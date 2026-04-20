import { RuntimeError } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type { ServiceLoop } from "./service-loop.js";

/**
 * Resolve a label to a sessionId. If the input matches a label in the map,
 * return the corresponding sessionId. Otherwise return the input as-is
 * (assumed to be a sessionId already).
 */
function resolveLabel(input: string, labels?: Map<string, string>): string {
  if (!labels) return input;
  for (const [sessionId, label] of labels) {
    if (label === input) return sessionId;
  }
  return input;
}

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
  sessionLabels?: Map<string, string>,
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
          const result = await runtime.send(params.sessionId, params.text);
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
          const result = await runtime.poll(params.sessionId, params.after);
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
          const result = await runtime.status(params.sessionId);
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
          // Hot-reload: add to poll loop immediately
          serviceLoop.addSession(params.sessionId);
          // Store label if provided
          if (params.label && sessionLabels) {
            sessionLabels.set(params.sessionId, params.label);
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
        // Always remove from poll loop, even if server leave fails
        // (session may already be expired on server)
        serviceLoop.removeSession(params.sessionId);
        sessionLabels?.delete(params.sessionId);
        try {
          const result = await runtime.leave(params.sessionId);
          return mcpOk({ ...result, polling: false });
        } catch (err: unknown) {
          // Still stopped polling even if server returned an error
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
          sessionId: { type: "string", description: "Optional session ID or label to poll; if omitted, all tracked sessions are polled" },
        },
        required: [],
      },
      async execute(_id: string, params: { sessionId?: string }) {
        try {
          const resolved = params.sessionId ? resolveLabel(params.sessionId, sessionLabels) : undefined;
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
      name: "nexus_sessions",
      description:
        "List all NexusMessaging sessions the agent is connected to, with labels, poll state, and errors. Use this to know which sessions are active and their IDs before sending messages.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute() {
        try {
          const health = serviceLoop.getHealth();
          const sessions = Object.entries(health.sessions).map(
            ([sessionId, sh]) => ({
              sessionId,
              label: sessionLabels?.get(sessionId) ?? null,
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
