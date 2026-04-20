import { RuntimeError } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type { ServiceLoop } from "./service-loop.js";
import { resolveAlias, writeAlias, removeAlias, readAliases, reverseAliasLookup } from "./aliases.js";

function mcpOk(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function mcpError(err: unknown) {
  if (err instanceof RuntimeError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: err.message, code: err.code }),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: "Unexpected error" }),
      },
    ],
  };
}

export function registerTools(
  api: any,
  runtime: Runtime,
  serviceLoop: ServiceLoop,
): void {
  api.registerTool(
    {
      name: "nexus_send",
      description: "Send a message to a NexusMessaging session",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          text: { type: "string" },
        },
        required: ["sessionId", "text"],
      },
      async execute(
        _id: string,
        params: { sessionId: string; text: string },
      ) {
        try {
          const sessionId = resolveAlias(params.sessionId);
          const result = await runtime.send(sessionId, params.text);
          return mcpOk(result);
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_poll",
      description: "Poll messages from a NexusMessaging session",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          after: { type: "string" },
        },
        required: ["sessionId"],
      },
      async execute(
        _id: string,
        params: { sessionId: string; after?: string },
      ) {
        try {
          const sessionId = resolveAlias(params.sessionId);
          const result = await runtime.poll(sessionId, params.after);
          return mcpOk(result);
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_status",
      description: "Get the status of a NexusMessaging session",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
      async execute(_id: string, params: { sessionId: string }) {
        try {
          const sessionId = resolveAlias(params.sessionId);
          const result = await runtime.status(sessionId);
          return mcpOk(result);
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_join",
      description: "Join a NexusMessaging session and start polling it automatically",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          label: { type: "string", description: "Human-readable label for this session" },
        },
        required: ["sessionId"],
      },
      async execute(_id: string, params: { sessionId: string; label?: string }) {
        try {
          const result = await runtime.join(params.sessionId);
          serviceLoop.addSession(params.sessionId);
          if (params.label) {
            writeAlias(params.sessionId, params.label);
          }
          return mcpOk({ ...result, polling: true, label: params.label ?? null });
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_leave",
      description: "Leave a NexusMessaging session and stop polling it",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
      async execute(_id: string, params: { sessionId: string }) {
        serviceLoop.removeSession(params.sessionId);
        removeAlias(params.sessionId);
        try {
          const result = await runtime.leave(params.sessionId);
          return mcpOk({ ...result, polling: false });
        } catch (err: unknown) {
          return mcpOk({ sessionId: params.sessionId, polling: false, serverLeave: "failed (session may be expired)" });
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_health",
      description: "Get the health status of the NexusMessaging service loop",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute() {
        try {
          const result = serviceLoop.getHealth();
          return mcpOk(result);
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_force_poll",
      description: "Force-poll one or all tracked NexusMessaging sessions for new messages immediately, bypassing the normal poll interval and backoff",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional session ID or alias to poll; if omitted, all tracked sessions are polled" },
        },
        required: [],
      },
      async execute(_id: string, params: { sessionId?: string }) {
        try {
          const resolved = params.sessionId ? resolveAlias(params.sessionId) : undefined;
          const result = await serviceLoop.forcePoll(resolved);
          return mcpOk({ ok: true, ...result });
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_history",
      description:
        "Read past messages from a NexusMessaging session. Returns the last N messages (default: 20). Safe to call repeatedly — does not affect the service-loop poll cursor or message delivery. Use nexus_sessions first to find available session IDs/aliases.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID (UUID) or alias (e.g. \"chatbot\"). Use nexus_sessions to list available sessions and their aliases." },
          limit: { type: "number", description: "Number of recent messages to return. Default: 20. Use a small value (5-10) for quick context, or larger (50-100) for full conversation review." },
          after: { type: "string", description: "Pagination cursor — only return messages after this cursor. Omit to get the most recent messages. Use nextCursor from a previous response to paginate backwards." },
        },
        required: ["sessionId"],
      },
      async execute(
        _id: string,
        params: { sessionId: string; limit?: number; after?: string },
      ) {
        try {
          const sessionId = resolveAlias(params.sessionId);
          // NOTE: This fetches ALL messages from cursor and slices client-side.
          // When the server adds ?limit=N support, pass it to runtime.poll().
          const limit = params.limit ?? 20;
          const result = await runtime.poll(sessionId, params.after ?? "0");
          const messages = result.messages.slice(-limit);
          return mcpOk({ ...result, messages });
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_sessions",
      description:
        "List all NexusMessaging sessions this agent is connected to. Returns each session's ID, alias, poll state, and error count. Call this first to discover session IDs/aliases before using nexus_send, nexus_history, or nexus_poll.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute() {
        try {
          const health = serviceLoop.getHealth();
          const aliases = readAliases();
          const sessions = Object.entries(health.sessions).map(
            ([sessionId, sh]) => ({
              sessionId,
              alias: reverseAliasLookup(sessionId, aliases) ?? null,
              state: sh.state,
              lastPollAt: sh.lastPollAt,
              cursor: sh.cursor,
              consecutiveErrors: sh.consecutiveErrors,
            }),
          );
          return mcpOk({
            serviceState: health.state,
            totalSessions: sessions.length,
            sessions,
          });
        } catch (err: unknown) {
          return mcpError(err);
        }
      },
    },
    { optional: true },
  );
}
