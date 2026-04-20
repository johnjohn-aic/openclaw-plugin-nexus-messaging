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
      description: "Send a message to another agent in a NexusMessaging session. All agents in that session will see the message on their next poll. Use nexus_sessions to find available session IDs/aliases.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID or alias to send to (e.g. \"chatbot\" or a UUID). Use nexus_sessions to discover available sessions." },
          text: { type: "string", description: "Message text to send. Will be visible to all agents in the session." },
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
      description: "Check for new messages in a NexusMessaging session since the last poll. Only returns messages you haven't seen yet (advances the cursor). For reading past messages without advancing the cursor, use nexus_history instead.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID or alias to poll. Use nexus_sessions to list available sessions." },
          after: { type: "string", description: "Only return messages after this cursor. Omit to continue from where the last poll left off." },
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
      description: "Get detailed info about a NexusMessaging session: who created it, when it expires, and which agents are currently connected. Useful for checking if a session is still alive or who's in it.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID or alias to inspect. Use nexus_sessions to list available sessions." },
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
      description: "Join a NexusMessaging session. After joining, new messages will be delivered to you automatically via the background poll loop. Give it a label so you can refer to it by name instead of UUID.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID (UUID) to join. You'll get this from whoever created the session or from a pairing link." },
          label: { type: "string", description: "Short name for this session (e.g. \"team-chat\", \"research\"). You can use this alias instead of the UUID in all other nexus tools." },
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
      description: "Leave a NexusMessaging session and stop receiving messages from it. Removes the session from your active list and deletes its alias. You can rejoin later with nexus_join if needed.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID or alias to leave. Use nexus_sessions to see which sessions you're in." },
        },
        required: ["sessionId"],
      },
      async execute(_id: string, params: { sessionId: string }) {
        const sessionId = resolveAlias(params.sessionId);
        serviceLoop.removeSession(sessionId);
        removeAlias(sessionId);
        try {
          const result = await runtime.leave(sessionId);
          return mcpOk({ ...result, sessionId, polling: false });
        } catch (err: unknown) {
          return mcpOk({ sessionId, polling: false, serverLeave: "failed (session may be expired)" });
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "nexus_health",
      description: "Check if the NexusMessaging background service is running correctly. Shows the overall service state and per-session poll status. Use this to diagnose delivery problems or check if polling is active.",
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
      description: "Check for new messages right now, without waiting for the next automatic poll cycle. Use when you expect a reply and want it immediately. If no sessionId is given, checks all sessions at once.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID or alias to check. Omit to check all sessions at once. Use nexus_sessions to list available sessions." },
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
