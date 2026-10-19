import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { arch, homedir, tmpdir } from "node:os";
import type { NexusMessagingConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export function redactCredentials(value: unknown, proofs: readonly string[] = []): unknown {
  if (typeof value === "string") return proofs.reduce((text, proof) => proof ? text.split(proof).join("[redacted]") : text, value);
  if (Array.isArray(value)) return value.map(item => redactCredentials(item, proofs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(sessionKey|session_key)$/i.test(key)).map(([key, item]) => [key, redactCredentials(item, proofs)]));
  return value;
}

export function omitCredentialMetadata(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(sessionKey|session_key)$/i.test(key)));
  return value;
}

export type RuntimeErrorCode =
  | "cli-not-found"
  | "timeout"
  | "parse-failure"
  | "session-expired"
  | "agent-not-in-session"
  | "network"
  | "cli-error"
  | "authentication"
  | "persistence-unavailable"
  | "server-binding-mismatch"
  | "verification-mode-mismatch"
  | "session-unavailable"
  | "capacity";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly sessionId?: string;
  readonly cliOutput?: string;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    opts?: { sessionId?: string; cliOutput?: string; proofs?: readonly string[] }
  ) {
    super(redactCredentials(message, opts?.proofs) as string);
    this.name = "RuntimeError";
    this.code = code;
    this.sessionId = opts?.sessionId;
    this.cliOutput = opts?.cliOutput === undefined ? undefined : redactCredentials(opts.cliOutput, opts?.proofs) as string;
  }
}

export interface Message {
  id: string;
  agentId: string;
  text: string;
  json?: unknown;
  cursor: string;
  expiresAt?: string;
  sentAt?: string;
  verified?: boolean;
}

export interface Member {
  agentId: string;
  lastSeenAt: string;
}

export interface PollResult {
  messages: Message[];
  nextCursor: string;
  members?: Member[];
}

export interface JoinResult {
  sessionId: string;
  sessionKey?: string;
  verifiedOnly?: boolean;
  expiresAt?: string;
}

export interface RenewResult {
  sessionId: string;
  ttl: number;
  expiresAt: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
}

export interface LeaveResult {
  ok: boolean;
}

export interface StatusResult {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  maxAgents: number;
  agents: Array<{ agentId: string; joinedAt: string }>;
}

export interface Runtime {
  isVerified?(sessionId: string): boolean;
  join(sessionId: string): Promise<JoinResult>;
  poll(sessionId: string, after?: string): Promise<PollResult>;
  pollMembers(sessionId: string): Promise<PollResult>;
  send(sessionId: string, text: string, opts?: { json?: unknown; strict?: boolean }): Promise<SendResult>;
  leave(sessionId: string): Promise<LeaveResult>;
  status(sessionId: string): Promise<StatusResult>;
  renew(sessionId: string, ttl?: number): Promise<RenewResult>;
}

// Known server error identifiers (JSON `error` field) → RuntimeError code.
// Single extension point: add a new identifier here (and a spec scenario) to
// make it drive recovery. Unknown identifiers fall through to the heuristics.
const SERVER_ERROR_CODES: Record<string, RuntimeErrorCode> = {
  agent_not_in_session: "agent-not-in-session",
  session_not_found: "session-expired",
  missing_session_key: "authentication",
  persistence_unavailable: "persistence-unavailable",
  server_binding_mismatch: "server-binding-mismatch",
  verification_mode_mismatch: "verification-mode-mismatch",
  identity_limit_reached: "capacity",
  claim_receipt_limit_reached: "capacity",
};

export function classifyError(
  stderr: string,
  stdout: string,
  sessionId?: string,
  verifiedOnly = false,
  proofs: readonly string[] = [],
  command?: string
): RuntimeError {
  const combined = redactCredentials(`${stderr} ${stdout}`, proofs) as string;

  // Structured-first: stdout is JSON-only by nexus.sh contract. A known
  // `error` identifier is authoritative and maps deterministically.
  try {
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed.error === "string") {
      const code = (verifiedOnly || command === "renew") && parsed.error === "invalid_session_key" ? "authentication"
        : verifiedOnly && parsed.error === "session_not_found" ? "session-unavailable"
        : SERVER_ERROR_CODES[parsed.error];
      if (code) {
        const message = command === "renew" && code === "authentication"
          ? `${combined}\nRestore the saved credential directory from a persistent volume or backup; rejoining an active ID cannot recover its key.`
          : combined;
        return new RuntimeError(code, message, { sessionId, cliOutput: stdout, proofs });
      }
    }
  } catch {
    // Not JSON (transport failure, partial output) → fall through to heuristics.
  }

  const lower = combined.toLowerCase();

  if (
    lower.includes("agent") &&
    (lower.includes("not in session") ||
      lower.includes("not_in_session") ||
      lower.includes("not found"))
  ) {
    return new RuntimeError("agent-not-in-session", combined, {
      sessionId,
      cliOutput: stdout,
      proofs,
    });
  }

  if (
    lower.includes("expired") ||
    lower.includes("session not found") ||
    lower.includes("session_not_found") ||
    (lower.includes("404") && !lower.includes("command not found"))
  ) {
    return new RuntimeError(verifiedOnly ? "session-unavailable" : "session-expired", combined, {
      sessionId,
      cliOutput: stdout,
      proofs,
    });
  }

  if (
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("enetunreach") ||
    lower.includes("exit code 6") ||
    lower.includes("exit code 7")
  ) {
    return new RuntimeError("network", combined, {
      sessionId,
      cliOutput: stdout,
      proofs,
    });
  }

  return new RuntimeError("cli-error", combined, {
    sessionId,
    cliOutput: stdout,
    proofs,
  });
}

/**
 * Reconstruct nexus.sh local session state on disk.
 * nexus.sh expects ~/.config/messaging/sessions/<sid>/agent to contain
 * the agent-id. Without it, poll/send fail with "missing --agent-id".
 *
 * This is needed when join() returns agent_id_taken (idempotent rejoin)
 * because the normal nexus.sh join path (which writes these files) is
 * skipped.
 */
function ensureLocalSessionState(sessionId: string, agentName: string): void {
  const home = homedir();
  const sessionDir = resolve(home, ".config", "messaging", "sessions", sessionId);
  const agentFile = resolve(sessionDir, "agent");

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(agentFile, agentName, "utf-8");
    const keyFile = resolve(sessionDir, "key");
    if (!existsSync(keyFile) || !readFileSync(keyFile, "utf8").trim()) {
      console.warn(`[nexus-messaging] Session ${sessionId} recovered without a key; authenticated renewal is unavailable. Restore and persist ~/.config/messaging from a volume or backup.`);
    }
  } catch {
    // best-effort — if this fails, poll will still get --agent-id from config
  }
}

export function createRuntime(config: NexusMessagingConfig): Runtime {
  if (!existsSync(config.cliPath)) {
    throw new Error(
      `[nexus-messaging] CLI not found at config.cliPath: ${config.cliPath}`
    );
  }

  const timeoutMs: number = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Resolve bundled jq binary based on architecture.
  // The plugin ships jq-linux-x64 and jq-linux-arm64 in bin/.
  // Instead of creating a symlink (fails on read-only mounts), we create
  // a wrapper script at runtime in /tmp that calls the arch-specific binary.
  const pluginDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const pluginBinDir = resolve(pluginDir, "bin");
  const jqArch = arch() === "arm64" ? "arm64" : "x64";
  const jqBundled = resolve(pluginBinDir, `jq-linux-${jqArch}`);

  // Create a /tmp wrapper dir with a `jq` script pointing to the right binary.
  // /tmp is always writable, even when plugin dir is mounted read-only.
  // IMPORTANT: Always overwrite the wrapper to avoid stale/recursive scripts
  // from previous plugin versions (see: infinite recursion bug in v0.5.0).
  const jqWrapperDir = resolve(tmpdir(), "nexus-messaging-bin");
  const jqWrapperPath = resolve(jqWrapperDir, "jq");
  const expectedContent = `#!/bin/sh\nexec "${jqBundled}" "$@"\n`;

  if (existsSync(jqBundled)) {
    try {
      // Always write — ensures stale wrappers from older versions are replaced
      let needsWrite = true;
      if (existsSync(jqWrapperPath)) {
        try {
          const current = readFileSync(jqWrapperPath, "utf-8");
          if (current === expectedContent) needsWrite = false;
        } catch {
          // can't read → overwrite
        }
      }
      if (needsWrite) {
        mkdirSync(jqWrapperDir, { recursive: true });
        writeFileSync(jqWrapperPath, expectedContent, { mode: 0o755 });
      }
    } catch {
      // best-effort — if /tmp is somehow not writable, jq must be in system PATH
    }
  }

  const extraPath = existsSync(jqWrapperDir) ? jqWrapperDir : "";
  const sharedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEXUS_URL: config.url,
    ...(extraPath ? { PATH: `${extraPath}:${process.env.PATH ?? ""}` } : {}),
  };

  const knownStrict = new Set<string>();
  const knownProofs = new Set<string>();
  const rememberProof = (value: unknown) => { if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) knownProofs.add(value); };
  const normalize = (value: string) => { try { const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`; } catch { return value.replace(/\/+$/, ""); } };
  function strictBinding(sessionId: string): { strict: boolean; server?: string } {
    if (!/^[a-f0-9]{48}$/i.test(sessionId)) return { strict: knownStrict.has(sessionId) };
    const root = resolve(homedir(), ".config", "messaging");
    const active = resolve(root, "sessions", sessionId);
    const policy = resolve(active, "policy");
    if (existsSync(policy) && readFileSync(policy, "utf8").trim() === "verifiedOnly") {
      knownStrict.add(sessionId);
      const proof = resolve(active, "key");
      if (existsSync(proof)) rememberProof(readFileSync(proof, "utf8").trim());
      const server = resolve(active, "server");
      return { strict: true, server: existsSync(server) ? normalize(readFileSync(server, "utf8").trim()) : undefined };
    }
    const identities = resolve(root, "identities"), servers = new Set<string>();
    if (existsSync(identities)) for (const hash of readdirSync(identities)) {
      const file = resolve(identities, hash, sessionId, `${config.agentName}.json`);
      if (!existsSync(file)) continue;
      const record = JSON.parse(readFileSync(file, "utf8"));
      rememberProof(record.sessionKey);
      if (record.v === 1 && record.verifiedOnly === true && record.sessionId === sessionId && record.agentId === config.agentName && typeof record.serverUrl === "string") servers.add(normalize(record.serverUrl));
    }
    // Anonymous creates have policy evidence without a member credential.
    // Follow it before passing the plugin's ambient URL as an explicit CLI flag.
    const policies = resolve(root, "policies");
    if (!servers.size && existsSync(policies)) for (const hash of readdirSync(policies)) {
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      const file = resolve(policies, hash, `${sessionId}.json`);
      if (!existsSync(file)) continue;
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        if (record.v !== 1 || record.verifiedOnly !== true || record.sessionId !== sessionId
          || typeof record.serverUrl !== "string" || normalize(record.serverUrl) !== record.serverUrl
          || createHash("sha256").update(record.serverUrl).digest("hex") !== hash) throw new Error("Invalid policy");
        servers.add(record.serverUrl);
      } catch { throw new RuntimeError("cli-error", "Could not read the saved strict policy; retain local state and check storage", { sessionId }); }
    }
    if (servers.size > 1) throw new RuntimeError("server-binding-mismatch", "Multiple retained servers match; select the original binding explicitly", { sessionId });
    if (servers.size) knownStrict.add(sessionId);
    return { strict: knownStrict.has(sessionId), server: [...servers][0] };
  }
  const isVerified = (sessionId: string) => strictBinding(sessionId).strict;

  async function execCli(
    args: string[],
    sessionId?: string
  ): Promise<string> {
    const binding = sessionId ? strictBinding(sessionId) : { strict: false, server: undefined };
    if (sessionId && !binding.strict && args[0] === "renew" && /^[a-f0-9]{48}$/i.test(sessionId)) {
      const proof = resolve(homedir(), ".config", "messaging", "sessions", sessionId, "key");
      try {
        if (existsSync(proof)) rememberProof(readFileSync(proof, "utf8").trim());
      } catch {
        throw new RuntimeError("authentication",
          "Could not read the saved renewal credential. Check file permissions. Restore the credential directory from a persistent volume or backup if needed.",
          { sessionId });
      }
    }
    if (binding.strict && binding.server) {
      if (config.sessions.some(s => s.id === sessionId) && normalize(config.url) !== binding.server) {
        throw new RuntimeError("server-binding-mismatch", "Configured destination differs from the original strict server", { sessionId });
      }
      args = [...args];
      const urlIndex = args.indexOf("--url");
      if (urlIndex >= 0) args[urlIndex + 1] = binding.server;
    }
    try {
      const { stdout } = await execFileAsync(config.cliPath, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: sharedEnv,
      });
      return (stdout ?? "").trim();
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & {
        stderr?: string;
        stdout?: string;
        killed?: boolean;
      };

      if (error.code === "ENOENT") {
        throw new RuntimeError("cli-not-found", error.message, { sessionId });
      }

      if (error.killed) {
        throw new RuntimeError(
          "timeout",
          `Command timed out after ${timeoutMs}ms`,
          { sessionId }
        );
      }

      throw classifyError(error.stderr ?? "", error.stdout ?? "", sessionId, binding.strict || (sessionId ? isVerified(sessionId) : false), [...knownProofs], args[0]);
    }
  }

  function parseJson<T>(raw: string, sessionId?: string): T {
    try {
      const parsed = JSON.parse(raw);
      rememberProof(parsed?.sessionKey);
      return (sessionId && (isVerified(sessionId) || parsed?.verifiedOnly === true) ? omitCredentialMetadata(parsed) : parsed) as T;
    } catch {
      throw new RuntimeError("parse-failure", `Invalid JSON output: ${raw}`, {
        sessionId,
        cliOutput: raw,
        proofs: [...knownProofs],
      });
    }
  }

  return {
    isVerified,
    async join(sessionId: string): Promise<JoinResult> {
      try {
        const raw = await execCli(
          ["join", sessionId, "--agent-id", config.agentName, "--url", config.url],
          sessionId
        );
        const result = parseJson<JoinResult>(raw, sessionId);
        if (result.verifiedOnly) {
          knownStrict.add(sessionId);
          const { sessionKey: _key, ...safe } = result;
          return { ...safe, sessionId };
        }
        return result;
      } catch (err: unknown) {
        // agent_id_taken means we're already in the session — treat as success.
        // The server returns an error HTTP status but this is semantically idempotent.
        if (
          !isVerified(sessionId) &&
          err instanceof RuntimeError &&
          (err.cliOutput ?? err.message).includes("agent_id_taken")
        ) {
          // Reconstruct nexus.sh local state so poll/send can find the agent-id.
          // nexus.sh persists agent-id at ~/.config/messaging/sessions/<sid>/agent
          // which is lost on container recreate (ephemeral filesystem).
          // Reconstruct only after successful default-mode evidence or legacy lookup failure.
          // Fetch current session state to recover expiresAt.
          // Without this, tracker.expiresAt stays null and renewal
          // only fires on the first tick (defensive, but delayed).
          try {
            const raw = await execCli(
              ["status", sessionId, "--url", config.url],
              sessionId
            );
            const st = parseJson<StatusResult & { verifiedOnly?: boolean }>(raw, sessionId);
            if (st.verifiedOnly) { knownStrict.add(sessionId); throw new RuntimeError("authentication", "Strict entry requires original proof", { sessionId }); }
            ensureLocalSessionState(sessionId, config.agentName);
            return { sessionId, sessionKey: "", expiresAt: st.expiresAt };
          } catch (lookupError) {
            if (isVerified(sessionId)) throw lookupError;
            ensureLocalSessionState(sessionId, config.agentName);
            return { sessionId, sessionKey: "" };
          }
        }
        throw err;
      }
    },

    async poll(sessionId: string, after?: string): Promise<PollResult> {
      const args = ["poll", sessionId, "--url", config.url];
      if (after !== undefined) {
        args.push("--after", after);
      }
      const raw = await execCli(args, sessionId);
      return parseJson<PollResult>(raw, sessionId);
    },

    async pollMembers(sessionId: string): Promise<PollResult> {
      const args = ["poll", sessionId, "--url", config.url, "--members"];
      const raw = await execCli(args, sessionId);
      return parseJson<PollResult>(raw, sessionId);
    },

    async send(sessionId: string, text: string, opts?: { json?: unknown; strict?: boolean }): Promise<SendResult> {
      const args = ["send", sessionId, text, "--url", config.url];
      if (opts?.json !== undefined) {
        args.push("--json", JSON.stringify(opts.json));
      }
      if (opts?.strict) {
        args.push("--strict");
      }
      const raw = await execCli(args, sessionId);
      return parseJson<SendResult>(raw, sessionId);
    },

    async leave(sessionId: string): Promise<LeaveResult> {
      const raw = await execCli(
        ["leave", sessionId, "--url", config.url],
        sessionId
      );
      return parseJson<LeaveResult>(raw, sessionId);
    },

    async status(sessionId: string): Promise<StatusResult> {
      const raw = await execCli(
        ["status", sessionId, "--url", config.url],
        sessionId
      );
      return parseJson<StatusResult>(raw, sessionId);
    },

    async renew(sessionId: string, ttl?: number): Promise<RenewResult> {
      const args = ["renew", sessionId, "--url", config.url];
      if (ttl !== undefined) {
        args.push("--ttl", String(ttl));
      }
      const raw = await execCli(args, sessionId);
      return parseJson<RenewResult>(raw, sessionId);
    },
  };
}
