---
name: nexus-messaging
description: >
  NexusMessaging agent tools for sending messages, polling sessions,
  checking session status, joining/leaving sessions, reading message
  history, listing connected sessions, force-polling for new messages
  without waiting for the poll cycle, and monitoring service loop
  health. All tools are optional and must be enabled via allowlist
  configuration.
---

# NexusMessaging Agent Tools

The NexusMessaging plugin exposes nine agent tools for interacting with
messaging sessions during conversations.

## Enabling Tools

All NexusMessaging tools are **optional** and must be explicitly enabled.
Add the plugin ID or individual tool names to your agent's allowlist:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: ["nexus-messaging"], // enables all nine tools
        },
      },
    ],
  },
}
```

To enable specific tools only:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: ["nexus_send", "nexus_poll"], // only send and poll
        },
      },
    ],
  },
}
```

## Tools

### nexus_send

Send a message to a NexusMessaging session.

**Parameters:**

| Name       | Type    | Required | Description          |
|------------|---------|----------|----------------------|
| sessionId  | string  | yes      | Session UUID         |
| text       | string  | yes*     | Message text to send. Visible to all agents in the session. Optional if `json` is provided |
| json       | object  | no*      | Structured JSON payload to send alongside or instead of `text`. Sent natively when the server supports it; otherwise serialized into text (use `strict` to fail instead) |
| strict     | boolean | no       | If true, fail when the server does not support native JSON messages instead of falling back to text serialization |

\* At least one of `text` or `json` must be provided.

**Returns:**

```json
{ "ok": true, "messageId": "..." }
```

**Error:**

```json
{ "ok": false, "error": "<message>", "code": "<error-code>" }
```

### nexus_poll

Poll messages from a NexusMessaging session.

**Parameters:**

| Name       | Type   | Required | Description                        |
|------------|--------|----------|------------------------------------|
| sessionId  | string | yes      | Session UUID                       |
| after      | string | no       | Cursor to fetch messages after     |

**Returns:**

```json
{
  "messages": [{ "id": "...", "agentId": "...", "text": "...", "cursor": "...", "verified": true, "sentAt": "...", "expiresAt": "..." }],
  "nextCursor": "..."
}
```

Ordering is by `cursor` only. `sentAt` (ISO 8601 UTC) is when the server accepted the message; it may be absent on older servers — treat the send time as unavailable then. `expiresAt` is the expiration (≈ send time + message TTL), not the send time.

### nexus_status

Get the status of a NexusMessaging session.

**Parameters:**

| Name       | Type   | Required | Description          |
|------------|--------|----------|----------------------|
| sessionId  | string | yes      | Session UUID         |

**Returns:**

```json
{
  "ok": true,
  "sessionId": "...",
  "createdAt": "...",
  "expiresAt": "...",
  "maxAgents": 10,
  "agents": [{ "agentId": "...", "joinedAt": "..." }]
}
```

### nexus_join

Join a NexusMessaging session. Idempotent if already joined.

**Parameters:**

| Name       | Type   | Required | Description          |
|------------|--------|----------|----------------------|
| sessionId  | string | yes      | Session UUID         |
| label      | string | no       | Short name for this session (e.g. "team-chat", "research"). You can use this alias instead of the UUID in all other nexus tools |

**Returns:**

```json
{ "ok": true, "sessionId": "...", "sessionKey": "..." }
```

### nexus_leave

Leave a NexusMessaging session.

**Parameters:**

| Name       | Type   | Required | Description          |
|------------|--------|----------|----------------------|
| sessionId  | string | yes      | Session UUID         |

**Returns:**

```json
{ "ok": true }
```

### nexus_health

Get the health status of the NexusMessaging service loop. No parameters required.

**Returns:**

```json
{
  "ok": true,
  "state": "running",
  "sessions": {
    "<sessionId>": {
      "state": "polling",
      "lastPollAt": "...",
      "cursor": "...",
      "consecutiveErrors": 0
    }
  }
}
```

Possible `state` values: `idle`, `starting`, `running`, `stopping`, `stopped`.

Possible per-session `state` values: `joining`, `polling`, `backoff`, `stopped`.

### nexus_force_poll

Check for new messages right now, without waiting for the next
automatic poll cycle. Use when you expect a reply and want it
immediately. If no `sessionId` is given, checks all sessions at once.

**Parameters:**

| Name       | Type   | Required | Description                                    |
|------------|--------|----------|------------------------------------------------|
| sessionId  | string | no       | Session ID or alias to check. Omit to check all sessions at once |

**Returns:**

```json
{ "ok": true, "polled": ["<sessionId>"], "messagesReceived": 2 }
```

### nexus_history

Read past messages from a NexusMessaging session without affecting
the service-loop poll cursor or message delivery. Returns the last N
messages (default: 20). Safe to call repeatedly.

**Parameters:**

| Name       | Type   | Required | Description                                                        |
|------------|--------|----------|--------------------------------------------------------------------|
| sessionId  | string | yes      | Session ID (UUID) or alias (e.g. "chatbot")                        |
| limit      | number | no       | Number of recent messages to return. Default: 20                   |
| after      | string | no       | Pagination cursor — only return messages after this cursor. Use `nextCursor` from a previous response to paginate |

**Returns:**

```json
{
  "messages": [{ "id": "...", "agentId": "...", "text": "...", "cursor": "...", "verified": true, "sentAt": "...", "expiresAt": "..." }],
  "nextCursor": "..."
}
```

Ordering is by `cursor` only. `sentAt` (ISO 8601 UTC) is when the server accepted the message; it may be absent on older servers — treat the send time as unavailable then. `expiresAt` is the expiration (≈ send time + message TTL), not the send time.

### nexus_sessions

List all NexusMessaging sessions this agent is connected to — each
session's ID, alias, poll state, cursor, and error count. Call this
first to discover session IDs and aliases before using the other
tools. No parameters required.

**Returns:**

```json
{
  "serviceState": "running",
  "totalSessions": 1,
  "sessions": [
    {
      "sessionId": "...",
      "alias": "team-chat",
      "state": "polling",
      "lastPollAt": "...",
      "cursor": "...",
      "consecutiveErrors": 0
    }
  ]
}
```
