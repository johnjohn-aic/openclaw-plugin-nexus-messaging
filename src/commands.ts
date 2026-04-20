import { RuntimeError } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type { ServiceLoop, ServiceHealth } from "./service-loop.js";
import { readPersistedHealth } from "./service-loop.js";
import type { NexusMessagingConfig } from "./config.js";
import { resolveAlias, reverseAliasLookup, writeAlias, removeAlias } from "./aliases.js";

const USAGE = [
  "Usage: /nexus <command>",
  "",
  "Commands:",
  "  status                              Show active sessions and their state",
  "  send <session|alias> <text>         Send a message to a session",
  "  join <sessionId> [alias]            Join a session (alias lets you use a name instead of UUID)",
  "  leave <session|alias>               Leave a session and stop receiving messages",
  "  poll [session|alias]                Check for new messages now (all sessions if omitted)",
  "  history <session|alias> [limit]     Show recent messages (default: last 20)",
  "",
  "Tip: Use an alias (e.g. \"team-chat\") anywhere a session ID is expected.",
].join("\n");

function formatHealth(health: ServiceHealth): string {
  const sessionIds = Object.keys(health.sessions);

  const stateEmoji = health.state === "running" ? "🟢" : health.state === "stopped" ? "🔴" : "🟡";
  const lines: string[] = [`${stateEmoji} Service: ${health.state} | ${sessionIds.length} session(s)`];

  if (sessionIds.length === 0) {
    lines.push("  No sessions. Use /nexus join <id> [alias] to add one.");
    return lines.join("\n");
  }

  lines.push("");
  for (const id of sessionIds) {
    const s = health.sessions[id];
    const alias = reverseAliasLookup(id);
    const name = alias ?? id.slice(0, 8) + "…";
    const stateIcon = s.state === "polling" ? "✅" : s.state === "backoff" ? "⚠️" : s.state === "joining" ? "⏳" : "⏹️";
    const parts: string[] = [];
    if (s.lastPollAt) {
      const ago = Math.round((Date.now() - new Date(s.lastPollAt).getTime()) / 1000);
      parts.push(ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`);
    }
    if (s.consecutiveErrors > 0) parts.push(`${s.consecutiveErrors} error(s)`);
    const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
    const fullId = alias ? ` (${id})` : "";
    lines.push(`  ${stateIcon} ${name}${fullId}${detail}`);
  }

  return lines.join("\n");
}

function formatError(err: unknown): string {
  if (err instanceof RuntimeError) {
    return `${err.message} (code: ${err.code})`;
  }
  return "Unexpected error";
}

async function handleStatus(
  serviceLoop: ServiceLoop,
): Promise<{ text: string }> {
  const health = serviceLoop.getHealth();
  return { text: formatHealth(health) };
}

async function handleSend(
  runtime: Runtime,
  args: string,
): Promise<{ text: string }> {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { text: "Usage: /nexus send <session|alias> <text>\nExample: /nexus send team-chat Hello everyone!" };
  }
  const rawId = trimmed.slice(0, spaceIdx);
  const text = trimmed.slice(spaceIdx + 1);
  if (!rawId || !text) {
    return { text: "Usage: /nexus send <session|alias> <text>\nExample: /nexus send team-chat Hello everyone!" };
  }
  const sessionId = resolveAlias(rawId);
  const display = rawId !== sessionId ? `${rawId} (${sessionId})` : sessionId;
  try {
    const result = await runtime.send(sessionId, text);
    return {
      text: result.ok
        ? `✅ Message sent to ${display}`
        : `❌ Failed to send message to ${display}`,
    };
  } catch (err: unknown) {
    return { text: `❌ ${formatError(err)}` };
  }
}

async function handleJoin(
  runtime: Runtime,
  serviceLoop: ServiceLoop,
  args: string,
): Promise<{ text: string }> {
  const parts = args.trim().split(/\s+/);
  const rawId = parts[0];
  if (!rawId) {
    return { text: "Usage: /nexus join <sessionId> [alias]\nExample: /nexus join abc123-def456 team-chat\n\nThe alias lets you use a short name instead of the UUID in all commands." };
  }
  const sessionId = resolveAlias(rawId);
  const label = parts[1];
  try {
    const result = await runtime.join(sessionId);
    serviceLoop.addSession(result.sessionId);
    if (label) {
      writeAlias(result.sessionId, label);
    }
    const display = label ? `${result.sessionId} (alias: ${label})` : result.sessionId;
    const tip = label ? "" : "\nTip: Add an alias next time — /nexus join <id> my-alias";
    return { text: `✅ Joined session ${display}${tip}` };
  } catch (err: unknown) {
    return { text: `❌ ${formatError(err)}` };
  }
}

async function handleLeave(
  runtime: Runtime,
  serviceLoop: ServiceLoop,
  args: string,
): Promise<{ text: string }> {
  const rawId = args.trim();
  if (!rawId) {
    return { text: "Usage: /nexus leave <session|alias>\nExample: /nexus leave team-chat" };
  }
  const sessionId = resolveAlias(rawId);
  const display = rawId !== sessionId ? `${rawId} (${sessionId})` : sessionId;
  serviceLoop.removeSession(sessionId);
  removeAlias(sessionId);
  try {
    const result = await runtime.leave(sessionId);
    return { text: result.ok ? `✅ Left session ${display}` : `⚠️ Left session ${display} (stopped polling, but server leave failed)` };
  } catch (err: unknown) {
    return { text: `⚠️ Left session ${display} (stopped polling, server: ${formatError(err)})` };
  }
}

async function handlePoll(
  serviceLoop: ServiceLoop,
  args: string,
): Promise<{ text: string }> {
  const raw = args.trim() || undefined;
  const sessionId = raw ? resolveAlias(raw) : undefined;
  try {
    const result = await serviceLoop.forcePoll(sessionId);
    const target = sessionId ? `session ${raw}` : "all sessions";
    if (result.messagesReceived === 0) {
      return { text: `📭 No new messages in ${target}` };
    }
    return {
      text: `📬 ${result.messagesReceived} new message(s) from ${result.polled.length} session(s)`,
    };
  } catch (err: unknown) {
    return { text: `❌ ${formatError(err)}` };
  }
}

async function handleHistory(
  runtime: Runtime,
  args: string,
): Promise<{ text: string }> {
  const parts = args.trim().split(/\s+/);
  const rawId = parts[0];
  if (!rawId) {
    return { text: "Usage: /nexus history <session|alias> [limit]\nExample: /nexus history team-chat 10\n\nShows the most recent messages (default: 20)." };
  }
  const sessionId = resolveAlias(rawId);
  // NOTE: Fetches all messages from cursor "0" and slices client-side.
  const limit = parts[1] ? parseInt(parts[1], 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { text: "Usage: /nexus history <session|alias> [limit]\nLimit must be a positive number. Example: /nexus history team-chat 10" };
  }
  const display = rawId !== sessionId ? `${rawId} (${sessionId})` : sessionId;
  try {
    const result = await runtime.poll(sessionId, "0");
    const messages = result.messages.slice(-limit);
    if (messages.length === 0) {
      return { text: `📭 No messages in ${display}` };
    }
    const lines = messages.map((m) => `[${m.timestamp}] ${m.agentId}: ${m.text}`);
    const header = `📜 ${display} — last ${messages.length} message(s):`;
    return { text: `${header}\n${lines.join("\n")}` };
  } catch (err: unknown) {
    return { text: `❌ ${formatError(err)}` };
  }
}

export function registerSlashCommands(
  api: any,
  runtime: Runtime,
  serviceLoop: ServiceLoop,
): void {
  api.registerCommand({
    name: "nexus",
    description: "NexusMessaging — manage agent-to-agent messaging sessions",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: { args?: string }) => {
      const raw = (ctx.args ?? "").trim();
      const spaceIdx = raw.indexOf(" ");
      const sub = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1);

      switch (sub) {
        case "status":
          return handleStatus(serviceLoop);
        case "send":
          return handleSend(runtime, rest);
        case "join":
          return handleJoin(runtime, serviceLoop, rest);
        case "leave":
          return handleLeave(runtime, serviceLoop, rest);
        case "poll":
          return handlePoll(serviceLoop, rest);
        case "history":
          return handleHistory(runtime, rest);
        default:
          return { text: USAGE };
      }
    },
  });
}

export function registerCliCommands(
  api: any,
  runtime: Runtime,
  serviceLoop: ServiceLoop,
  config: NexusMessagingConfig,
): void {
  api.registerCli(
    ({ program }: { program: any }) => {
      const cmd = program
        .command("nexus-messaging")
        .description("NexusMessaging plugin commands");

      cmd
        .command("status")
        .description("Show plugin status and health")
        .action(() => {
          const health = readPersistedHealth(config.agentName) ?? serviceLoop.getHealth();
          const lines: string[] = [
            `Agent: ${config.agentName}`,
            `URL: ${config.url}`,
            `State: ${health.state}`,
            `Sessions: ${Object.keys(health.sessions).length}`,
          ];

          for (const id of Object.keys(health.sessions)) {
            const s = health.sessions[id];
            const alias = reverseAliasLookup(id);
            const parts = [`state=${s.state}`];
            if (s.lastPollAt) parts.push(`lastPoll=${s.lastPollAt}`);
            if (s.consecutiveErrors > 0) parts.push(`errors=${s.consecutiveErrors}`);
            const display = alias ? `${id} (${alias})` : id;
            lines.push(`  ${display}: ${parts.join(", ")}`);
          }

          process.stdout.write(lines.join("\n") + "\n");
        });

      cmd
        .command("sessions")
        .description("List configured sessions and their state")
        .action(() => {
          const health = readPersistedHealth(config.agentName) ?? serviceLoop.getHealth();

          for (const session of config.sessions) {
            const s = health.sessions[session.id];
            const parts: string[] = [session.id];
            if (session.label) parts.push(`label=${session.label}`);
            if (s) {
              parts.push(`pollState=${s.state}`);
              if (s.lastPollAt) parts.push(`lastPoll=${s.lastPollAt}`);
              if (s.consecutiveErrors > 0) parts.push(`errors=${s.consecutiveErrors}`);
            } else {
              parts.push("pollState=unknown");
            }
            process.stdout.write(parts.join(" ") + "\n");
          }
        });
    },
    { commands: ["nexus-messaging"] },
  );
}
