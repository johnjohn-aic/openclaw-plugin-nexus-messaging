import { parseConfig, discoverLocalSessions, type NexusSessionConfig } from "./src/config.js";
import { createRuntime, type Runtime, type Message } from "./src/runtime.js";
import { createServiceLoop } from "./src/service-loop.js";
import { registerTools } from "./src/tools.js";
import { registerSlashCommands, registerCliCommands } from "./src/commands.js";

/**
 * Resolve the delivery session key for a Nexus session.
 *
 * Supports three modes via session config deliverTo:
 *   1. deliverTo.sessionKey — literal key (e.g. "agent:main:telegram:dm:12345")
 *   2. deliverTo.channel + deliverTo.peer — resolved via resolveAgentRoute
 *   3. (none) — falls back to the plugin-level agentSessionKey
 */
function resolveDeliverySessionKey(
  sessionConfig: NexusSessionConfig | undefined,
  api: any,
): string | null {
  const deliverTo = sessionConfig?.deliverTo;
  if (!deliverTo) return null;

  // Mode 1: literal session key
  if (typeof deliverTo.sessionKey === "string" && deliverTo.sessionKey.trim()) {
    return deliverTo.sessionKey.trim();
  }

  // Mode 2: channel + peer → resolveAgentRoute
  if (typeof deliverTo.channel === "string" && deliverTo.peer) {
    try {
      const resolveRoute = api.runtime?.channel?.routing?.resolveAgentRoute;
      if (typeof resolveRoute === "function") {
        const route = resolveRoute({
          cfg: api.config,
          channel: deliverTo.channel,
          peer: deliverTo.peer,
        });
        if (route?.sessionKey) return route.sessionKey;
      }
    } catch {
      // fall through to null
    }
  }

  return null;
}

/**
 * NexusMessaging plugin for OpenClaw.
 *
 * Exported as a plain function — OpenClaw desestrutura `register` do default
 * export e chama como função standalone (sem bind), então usar `this` não
 * funciona. Seguir o padrão dos plugins stock (ex: device-pair).
 *
 * Config validation: OpenClaw já valida contra o JSON Schema do manifest
 * (openclaw.plugin.json) antes de chamar register. O parseConfig aqui aplica
 * defaults e tipagem TypeScript.
 */
export default function register(api: any): void {
  const config = parseConfig(api.pluginConfig);

  const runtime: Runtime = createRuntime(config);

  // Auto-discover sessions from nexus.sh local data directory.
  // Config sessions have priority; discovered sessions are added on top.
  const discoveredSessions = discoverLocalSessions(config.sessions);
  const allSessions = [...config.sessions, ...discoveredSessions];

  if (discoveredSessions.length > 0) {
    api.logger.info(
      `[nexus-messaging] Discovered ${discoveredSessions.length} session(s) from local data: ` +
        discoveredSessions.map((s) => s.label ?? s.id.slice(0, 8)).join(", ")
    );
  }

  // Build a label map for human-readable session names in events
  const sessionLabels = new Map<string, string>();
  for (const s of allSessions) {
    if (s.label) sessionLabels.set(s.id, s.label);
  }

  // Resolve the agent's main session key for system event injection.
  // The session key format is "agent:<agentId>:<mainKey>" (e.g. "agent:main:main").
  // We resolve it from the config so events land in the correct agent session.
  let agentSessionKey: string;
  try {
    const resolveMainKey = api.runtime?.channel?.routing?.buildAgentSessionKey;
    // Use resolveMainSessionKeyFromConfig if available (most reliable)
    const cfg = api.config;
    const agents = cfg?.agents?.list ?? [];
    const defaultAgent = agents.find((a: any) => a?.default);
    const agentId = defaultAgent?.id ?? agents[0]?.id ?? "main";
    const mainKey = cfg?.session?.mainKey ?? "main";

    if (cfg?.session?.scope === "global") {
      agentSessionKey = "global";
    } else {
      // Standard format: "agent:<agentId>:<mainKey>"
      agentSessionKey = `agent:${agentId}:${mainKey}`;
    }
  } catch {
    agentSessionKey = "agent:main:main";
  }

  api.logger.info(
    `[nexus-messaging] Plugin loaded — agent: ${config.agentName}, ` +
      `url: ${config.url}, sessions: ${allSessions.length} (${config.sessions.length} config + ${discoveredSessions.length} discovered), ` +
      `pollInterval: ${config.pollIntervalMs}ms, autoRejoin: ${config.autoRejoin}, ` +
      `sessionKey: ${agentSessionKey}`
  );

  if (allSessions.length === 0) {
    api.logger.warn(
      "[nexus-messaging] No sessions found. Add sessions to config or join via nexus.sh / nexus_join tool."
    );
  }

  /**
   * Deliver Nexus messages to the agent as system events.
   *
   * Each message becomes a system event injected into the agent session.
   * A heartbeat wake is requested so the agent processes them promptly
   * (instead of waiting for the next scheduled heartbeat).
   */
  function deliverToAgent(batch: Map<string, Message[]>): void {
    const enqueue = api.runtime?.system?.enqueueSystemEvent;
    const wake = api.runtime?.system?.requestHeartbeatNow;

    if (typeof enqueue !== "function") {
      api.logger.warn(
        "[nexus-messaging] Cannot deliver messages — enqueueSystemEvent not available in runtime"
      );
      return;
    }

    const filtered = new Map<string, Message[]>();
    for (const [sessionId, messages] of batch) {
      const agentMessages = messages.filter((m) => m.agentId !== "system");
      if (agentMessages.length > 0) {
        filtered.set(sessionId, agentMessages);
      }
    }

    if (filtered.size === 0) return;

    const sessionKeys = new Map<string, string>();
    for (const sessionId of filtered.keys()) {
      const sessionConfig = allSessions.find((s) => s.id === sessionId);
      sessionKeys.set(
        sessionId,
        resolveDeliverySessionKey(sessionConfig, api) ?? agentSessionKey,
      );
    }

    const firstDeliveryKey = sessionKeys.values().next().value as string;
    let eventText: string;
    let contextKey: string;

    if (filtered.size === 1) {
      const [sessionId, agentMessages] = filtered.entries().next().value as [string, Message[]];
      const label = sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
      const lines = agentMessages.map((m) => `${m.agentId}: ${m.text}`);
      const header = agentMessages.length === 1
        ? `[NexusMessaging:${label}] New message (session: ${sessionId})`
        : `[NexusMessaging:${label}] ${agentMessages.length} new messages (session: ${sessionId})`;
      eventText = `${header}\n${lines.join("\n")}`;
      contextKey = `nexus:${sessionId}`;
    } else {
      const parts: string[] = [];
      let totalMessages = 0;
      for (const [sessionId, agentMessages] of filtered) {
        totalMessages += agentMessages.length;
        const label = sessionLabels.get(sessionId) ?? sessionId.slice(0, 8);
        const lines = agentMessages.map((m) => `${m.agentId}: ${m.text}`);
        parts.push(`📨 ${label} (session: ${sessionId}) — ${agentMessages.length} message${agentMessages.length === 1 ? "" : "s"}\n${lines.join("\n")}`);
      }
      const header = `[NexusMessaging] ${totalMessages} new messages across ${filtered.size} sessions`;
      eventText = `${header}\n\n${parts.join("\n\n")}`;
      contextKey = "nexus:batch";
    }

    enqueue(eventText, {
      sessionKey: firstDeliveryKey,
      contextKey,
    });

    const totalCount = Array.from(filtered.values()).reduce((sum, msgs) => sum + msgs.length, 0);
    api.logger.info(
      `[nexus-messaging] Enqueued batch: ${totalCount} message(s) from ${filtered.size} session(s) (key: ${firstDeliveryKey})`
    );

    if (typeof wake === "function") {
      try {
        wake({ sessionKey: firstDeliveryKey });
      } catch {
        // best-effort — agent will pick up on next heartbeat
      }
    }
  }

  const serviceLoop = createServiceLoop({
    runtime,
    sessions: allSessions.map((s: { id: string }) => s.id),
    pollIntervalMs: config.pollIntervalMs,
    autoRejoin: config.autoRejoin,
    onMessage: (batch) => {
      for (const [sessionId, messages] of batch) {
        const agentMsgs = messages.filter((m) => m.agentId !== "system");
        const systemMsgs = messages.length - agentMsgs.length;
        api.logger.info(
          `[nexus-messaging] ${messages.length} message(s) from session ${sessionId}` +
            (systemMsgs > 0 ? ` (${systemMsgs} system, skipped)` : "")
        );
      }
      deliverToAgent(batch);
    },
  });

  registerTools(api, runtime, serviceLoop, sessionLabels);
  registerSlashCommands(api, runtime, serviceLoop, sessionLabels);
  registerCliCommands(api, runtime, serviceLoop, config);

  api.registerService({
    id: "nexus-messaging",
    start: () => {
      api.logger.info("[nexus-messaging] Service starting");
      serviceLoop.start();
    },
    stop: async () => {
      api.logger.info("[nexus-messaging] Service stopping");
      await serviceLoop.stop();
    },
  });
}
