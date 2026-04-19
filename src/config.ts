import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * NexusMessaging plugin configuration.
 * Lives under plugins.entries.nexus-messaging.config in openclaw.json.
 */
export interface NexusSessionDeliverTo {
  /** Literal session key (e.g. "agent:main:telegram:dm:12345") */
  sessionKey?: string;
  /** Channel name for route resolution (e.g. "telegram", "discord") */
  channel?: string;
  /** Peer for route resolution */
  peer?: { kind: string; id: string };
}

export interface NexusSessionConfig {
  /** Session UUID */
  id: string;
  /** Human-readable label */
  label?: string;
  /** Where to deliver messages from this session */
  deliverTo?: NexusSessionDeliverTo;
}

export interface NexusMessagingConfig {
  /** NexusMessaging server URL */
  url: string;
  /** Agent identity for sessions */
  agentName: string;
  /** Sessions to join and poll */
  sessions: NexusSessionConfig[];
  /** Poll interval in milliseconds */
  pollIntervalMs: number;
  /** Auto-rejoin on TTL expiry */
  autoRejoin: boolean;
  /** Path to nexus.sh CLI (auto-detected if omitted) */
  cliPath: string;
}

/**
 * Parse and validate raw plugin config from OpenClaw.
 * Applies defaults and throws on invalid config.
 */
export function parseConfig(raw: unknown): NexusMessagingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "[nexus-messaging] Invalid config: expected an object, got " + typeof raw
    );
  }

  const cfg = raw as Record<string, unknown>;

  // agentName is required
  const agentName = cfg.agentName;
  if (typeof agentName !== "string" || agentName.trim().length === 0) {
    throw new Error(
      "[nexus-messaging] Config 'agentName' is required and must be a non-empty string"
    );
  }

  // url with default
  const url = typeof cfg.url === "string" ? cfg.url : "https://messaging.md";

  // sessions array
  let sessions: NexusSessionConfig[] = [];
  if (Array.isArray(cfg.sessions)) {
    sessions = cfg.sessions
      .filter((s: unknown) => s && typeof s === "object" && !Array.isArray(s))
      .map((s: Record<string, unknown>) => {
        const entry: NexusSessionConfig = {
          id: String(s.id ?? ""),
          ...(typeof s.label === "string" ? { label: s.label } : {}),
        };
        // Parse deliverTo config
        if (s.deliverTo && typeof s.deliverTo === "object" && !Array.isArray(s.deliverTo)) {
          const dt = s.deliverTo as Record<string, unknown>;
          const deliverTo: NexusSessionDeliverTo = {};
          if (typeof dt.sessionKey === "string") deliverTo.sessionKey = dt.sessionKey;
          if (typeof dt.channel === "string") deliverTo.channel = dt.channel;
          if (dt.peer && typeof dt.peer === "object" && !Array.isArray(dt.peer)) {
            const p = dt.peer as Record<string, unknown>;
            if (typeof p.kind === "string" && typeof p.id === "string") {
              deliverTo.peer = { kind: p.kind, id: p.id };
            }
          }
          if (Object.keys(deliverTo).length > 0) entry.deliverTo = deliverTo;
        }
        return entry;
      })
      .filter((s) => s.id.length > 0);
  }

  // pollIntervalMs with default and minimum
  let pollIntervalMs = 300000;
  if (typeof cfg.pollIntervalMs === "number") {
    pollIntervalMs = Math.max(5000, cfg.pollIntervalMs);
  }

  // autoRejoin with default
  const autoRejoin = typeof cfg.autoRejoin === "boolean" ? cfg.autoRejoin : true;

  // cliPath — resolve or auto-detect
  const cliPath = resolveCliPath(
    typeof cfg.cliPath === "string" ? cfg.cliPath : undefined
  );

  return {
    url,
    agentName: agentName.trim(),
    sessions,
    pollIntervalMs,
    autoRejoin,
    cliPath,
  };
}

/**
 * Discover sessions from the nexus.sh local data directory.
 * Reads ~/.config/messaging/sessions/ for session dirs with an agent file,
 * and ~/.config/messaging/aliases.json for human-readable labels.
 *
 * Returns sessions NOT already present in configSessions (config has priority).
 */
export function discoverLocalSessions(
  configSessions: NexusSessionConfig[],
): NexusSessionConfig[] {
  const dataDir = resolve(homedir(), ".config", "messaging", "sessions");
  const aliasesFile = resolve(homedir(), ".config", "messaging", "aliases.json");

  // Load aliases (label → sessionId mapping, reversed to sessionId → label)
  let aliasMap = new Map<string, string>();
  try {
    if (existsSync(aliasesFile)) {
      const raw = require("fs").readFileSync(aliasesFile, "utf-8");
      const aliases = JSON.parse(raw) as Record<string, string>;
      for (const [label, sid] of Object.entries(aliases)) {
        if (typeof sid === "string" && sid.trim()) {
          aliasMap.set(sid.trim(), label);
        }
      }
    }
  } catch {
    // aliases file is optional
  }

  // Existing config session IDs (config has priority)
  const configIds = new Set(configSessions.map((s) => s.id));

  // Scan session directories
  const discovered: NexusSessionConfig[] = [];
  try {
    if (!existsSync(dataDir)) return discovered;
    const entries = require("fs").readdirSync(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sid = entry.name;
      // Skip if already in config
      if (configIds.has(sid)) continue;
      // Must have an agent file (proof of a valid join)
      const agentFile = resolve(dataDir, sid, "agent");
      if (!existsSync(agentFile)) continue;

      const label = aliasMap.get(sid) ?? undefined;
      discovered.push({ id: sid, ...(label ? { label } : {}) });
    }
  } catch {
    // scan failure is non-fatal
  }

  return discovered;
}

/**
 * Resolve the path to nexus.sh CLI.
 * If configured explicitly, use that. Otherwise auto-detect.
 */
export function resolveCliPath(configured?: string): string {
  // Explicit path takes priority
  if (configured) {
    const expanded = configured.replace(/^~/, homedir());
    const abs = resolve(expanded);
    if (existsSync(abs)) {
      return abs;
    }
    throw new Error(
      `[nexus-messaging] Configured cliPath does not exist: ${abs}`
    );
  }

  // Try to find in PATH
  try {
    const which = execSync("which nexus.sh 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    if (which && existsSync(which)) {
      return which;
    }
  } catch {
    // not in PATH, continue searching
  }

  // Known locations — include $SKILLS_HOST_DIR if set, plus common Docker mount paths
  const skillsHostDir = process.env.SKILLS_HOST_DIR;
  const knownPaths = [
    ...(skillsHostDir
      ? [resolve(skillsHostDir, "messaging/scripts/nexus.sh")]
      : []),
    resolve(homedir(), "clawd/skills/messaging/scripts/nexus.sh"),
    resolve(homedir(), ".config/messaging/scripts/nexus.sh"),
    // Common Docker/container mount paths
    "/opt/clawhub/skills/messaging/scripts/nexus.sh",
    "/opt/skills/messaging/scripts/nexus.sh",
    "/usr/local/bin/nexus.sh",
  ];

  for (const p of knownPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    "[nexus-messaging] Cannot find nexus.sh. Configure 'cliPath' in plugin config or install nexus.sh in PATH."
  );
}
