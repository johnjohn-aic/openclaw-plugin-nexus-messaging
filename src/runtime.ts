import { execFile } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { arch, tmpdir } from "node:os";
import type { NexusMessagingConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export type RuntimeErrorCode =
  | "cli-not-found"
  | "timeout"
  | "parse-failure"
  | "session-expired"
  | "agent-not-in-session"
  | "network"
  | "cli-error";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly sessionId?: string;
  readonly cliOutput?: string;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    opts?: { sessionId?: string; cliOutput?: string }
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.sessionId = opts?.sessionId;
    this.cliOutput = opts?.cliOutput;
  }
}

export interface Message {
  id: string;
  agentId: string;
  text: string;
  timestamp: string;
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
  sessionKey: string;
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
  join(sessionId: string): Promise<JoinResult>;
  poll(sessionId: string, after?: string): Promise<PollResult>;
  send(sessionId: string, text: string): Promise<SendResult>;
  leave(sessionId: string): Promise<LeaveResult>;
  status(sessionId: string): Promise<StatusResult>;
  heartbeat(sessionId: string): Promise<PollResult>;
}

function classifyError(
  stderr: string,
  stdout: string,
  sessionId?: string
): RuntimeError {
  const combined = `${stderr} ${stdout}`;
  const lower = combined.toLowerCase();

  if (
    lower.includes("agent") &&
    (lower.includes("not in session") || lower.includes("not found"))
  ) {
    return new RuntimeError("agent-not-in-session", combined, {
      sessionId,
      cliOutput: stdout,
    });
  }

  if (
    lower.includes("expired") ||
    lower.includes("not found") ||
    lower.includes("404")
  ) {
    return new RuntimeError("session-expired", combined, {
      sessionId,
      cliOutput: stdout,
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
    });
  }

  return new RuntimeError("cli-error", combined, {
    sessionId,
    cliOutput: stdout,
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
  const homedir = require("node:os").homedir();
  const sessionDir = resolve(homedir, ".config", "messaging", "sessions", sessionId);
  const agentFile = resolve(sessionDir, "agent");

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(agentFile, agentName, "utf-8");
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

  const timeoutMs: number =
    typeof (config as unknown as Record<string, unknown>).timeoutMs === "number"
      ? ((config as unknown as Record<string, unknown>).timeoutMs as number)
      : DEFAULT_TIMEOUT_MS;

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
  const jqWrapperDir = resolve(tmpdir(), "nexus-messaging-bin");
  const jqWrapperPath = resolve(jqWrapperDir, "jq");

  if (existsSync(jqBundled) && !existsSync(jqWrapperPath)) {
    try {
      mkdirSync(jqWrapperDir, { recursive: true });
      writeFileSync(jqWrapperPath, `#!/bin/sh\nexec "${jqBundled}" "$@"\n`, { mode: 0o755 });
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

  async function execCli(
    args: string[],
    sessionId?: string
  ): Promise<string> {
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

      throw classifyError(error.stderr ?? "", error.stdout ?? "", sessionId);
    }
  }

  function parseJson<T>(raw: string, sessionId?: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new RuntimeError("parse-failure", `Invalid JSON output: ${raw}`, {
        sessionId,
        cliOutput: raw,
      });
    }
  }

  return {
    async join(sessionId: string): Promise<JoinResult> {
      try {
        const raw = await execCli(
          ["join", sessionId, "--agent-id", config.agentName, "--url", config.url],
          sessionId
        );
        return parseJson<JoinResult>(raw, sessionId);
      } catch (err: unknown) {
        // agent_id_taken means we're already in the session — treat as success.
        // The server returns an error HTTP status but this is semantically idempotent.
        if (
          err instanceof RuntimeError &&
          (err.cliOutput ?? err.message).includes("agent_id_taken")
        ) {
          // Reconstruct nexus.sh local state so poll/send can find the agent-id.
          // nexus.sh persists agent-id at ~/.config/messaging/sessions/<sid>/agent
          // which is lost on container recreate (ephemeral filesystem).
          ensureLocalSessionState(sessionId, config.agentName);
          return { sessionId, sessionKey: "" };
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

    async send(sessionId: string, text: string): Promise<SendResult> {
      const raw = await execCli(
        ["send", sessionId, text, "--url", config.url],
        sessionId
      );
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

    async heartbeat(sessionId: string): Promise<PollResult> {
      const raw = await execCli(
        ["poll", sessionId, "--url", config.url],
        sessionId
      );
      return parseJson<PollResult>(raw, sessionId);
    },
  };
}
