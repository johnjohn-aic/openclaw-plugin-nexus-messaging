import { RuntimeError } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type { ServiceLoop, ServiceHealth } from "./service-loop.js";
import { readPersistedHealth } from "./service-loop.js";
import type { NexusMessagingConfig } from "./config.js";

function resolveLabel(input: string, labels?: Map<string, string>): string {
  if (!labels) return input;
  for (const [sessionId, label] of labels) {
    if (label === input) return sessionId;
  }
  return input;
}

const USAGE = [
  "Usage: /nexus <subcommand>",
  "",
  "Subcommands:",
  "  status                    Show service loop health",
  "  send <sessionId> <text>   Send a message to a session",
  "  join <sessionId>          Join a session",
  "  leave <sessionId>         Leave a session",
  "  poll [sessionId]          Force-poll sessions for new messages",
].join("\n");

function formatHealth(health: ServiceHealth): string {
  const lines: string[] = [`State: ${health.state}`];

  const sessionIds = Object.keys(health.sessions);
  lines.push(`Sessions: ${sessionIds.length}`);

  for (const id of sessionIds) {
    const s = health.sessions[id];
    const parts = [`state=${s.state}`];
    if (s.lastPollAt) parts.push(`lastPoll=${s.lastPollAt}`);
    if (s.consecutiveErrors > 0) parts.push(`errors=${s.consecutiveErrors}`);
    lines.push(`  ${id}: ${parts.join(", ")}`);
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
    return { text: "Usage: /nexus send <sessionId> <text>" };
  }
  const sessionId = trimmed.slice(0, spaceIdx);
  const text = trimmed.slice(spaceIdx + 1);
  if (!sessionId || !text) {
    return { text: "Usage: /nexus send <sessionId> <text>" };
  }
  try {
    const result = await runtime.send(sessionId, text);
    return {
      text: result.ok
        ? `Message sent to ${sessionId}`
        : `Failed to send message to ${sessionId}`,
    };
  } catch (err: unknown) {
    return { text: formatError(err) };
  }
}

async function handleJoin(
  runtime: Runtime,
  serviceLoop: ServiceLoop,
  args: string,
): Promise<{ text: string }> {
  const sessionId = args.trim();
  if (!sessionId) {
    return { text: "Usage: /nexus join <sessionId>" };
  }
  try {
    const result = await runtime.join(sessionId);
    serviceLoop.addSession(result.sessionId);
    return { text: `Joined session ${result.sessionId} (key: ${result.sessionKey})` };
  } catch (err: unknown) {
    return { text: formatError(err) };
  }
}

async function handleLeave(
  runtime: Runtime,
  serviceLoop: ServiceLoop,
  args: string,
): Promise<{ text: string }> {
  const sessionId = args.trim();
  if (!sessionId) {
    return { text: "Usage: /nexus leave <sessionId>" };
  }
  serviceLoop.removeSession(sessionId);
  try {
    const result = await runtime.leave(sessionId);
    return { text: result.ok ? `Left session ${sessionId}` : `Left session ${sessionId} (poll stopped, server leave failed)` };
  } catch (err: unknown) {
    return { text: `Left session ${sessionId} (poll stopped, server: ${formatError(err)})` };
  }
}

async function handlePoll(
  serviceLoop: ServiceLoop,
  args: string,
  sessionLabels?: Map<string, string>,
): Promise<{ text: string }> {
  const raw = args.trim() || undefined;
  const sessionId = raw ? resolveLabel(raw, sessionLabels) : undefined;
  try {
    const result = await serviceLoop.forcePoll(sessionId);
    const target = sessionId ? `session ${sessionId}` : "all sessions";
    return {
      text: `Polled ${target}: ${result.polled.length} session(s) responded, ${result.messagesReceived} message(s) received`,
    };
  } catch (err: unknown) {
    return { text: formatError(err) };
  }
}

export function registerSlashCommands(
  api: any,
  runtime: Runtime,
  serviceLoop: ServiceLoop,
  sessionLabels?: Map<string, string>,
): void {
  api.registerCommand({
    name: "nexus",
    description: "NexusMessaging commands: status, send, join, leave, poll",
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
          return handlePoll(serviceLoop, rest, sessionLabels);
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
          // CLI runs in a separate process — read persisted health from disk
          // (written by the gateway process service loop). Fall back to
          // in-process getHealth() for the gateway process itself.
          const health = readPersistedHealth() ?? serviceLoop.getHealth();
          const lines: string[] = [
            `Agent: ${config.agentName}`,
            `URL: ${config.url}`,
            `State: ${health.state}`,
            `Sessions: ${Object.keys(health.sessions).length}`,
          ];

          for (const id of Object.keys(health.sessions)) {
            const s = health.sessions[id];
            const parts = [`state=${s.state}`];
            if (s.lastPollAt) parts.push(`lastPoll=${s.lastPollAt}`);
            if (s.consecutiveErrors > 0) parts.push(`errors=${s.consecutiveErrors}`);
            lines.push(`  ${id}: ${parts.join(", ")}`);
          }

          process.stdout.write(lines.join("\n") + "\n");
        });

      cmd
        .command("sessions")
        .description("List configured sessions and their state")
        .action(() => {
          const health = readPersistedHealth() ?? serviceLoop.getHealth();

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
