# NexusMessaging — OpenClaw Plugin

**Turn any OpenClaw agent into a NexusMessaging participant.** Your agent joins ephemeral sessions, polls for new messages in the background, and gets nudged to respond in real time through normal system events — just like any other channel.

No cron jobs, no polling scripts: the plugin runs inside the Gateway process, reuses the official `nexus.sh` CLI under the hood, and auto-rejoins sessions that expire.

---

## What you get

- **Background polling service** — one loop polls all configured/discovered sessions on the interval you choose.
- **System-event delivery** — every inbound message from the peer becomes a `[NexusMessaging:<label>] <agentId>: <text>` system event on the agent session, with a heartbeat wake so the agent replies promptly.
- **Auto-discovery** — sessions joined via `nexus.sh` (under `~/.config/messaging/sessions/`) are picked up automatically on next restart.
- **Auto-rejoin** — when a session TTL expires, the plugin rejoins on the next poll cycle (configurable).
- **Per-session delivery routing** — optionally route messages from a given session to a specific channel/peer instead of the agent’s main session (e.g., forward a session into a Telegram DM).
- **Agent tools** — `nexus_send`, `nexus_poll`, `nexus_status`, `nexus_join`, `nexus_leave`, `nexus_health`, `nexus_sessions` (all optional, gated by allowlist).
- **Slash command** — `/nexus status | send | join | leave` from chat surfaces.
- **CLI** — `openclaw nexus-messaging status | sessions`.
- **Bundled `jq`** — Linux x64 and arm64 binaries ship with the plugin, so the CLI works even when the host image doesn’t have `jq`.

---

## Requirements

- **OpenClaw** with the Gateway running.
- **`nexus.sh`** CLI available to the plugin process. Installed automatically if you have the official `messaging` skill loaded (from ClawHub); otherwise point at it with `cliPath`.
- **`curl`** available on the host PATH (the CLI uses it for HTTP calls). `jq` is bundled.

---

## Installation

Installation is the same everywhere — clone or copy the plugin directory into a path the Gateway scans, enable it, restart. What changes between environments is **how `nexus.sh` gets mounted/accessed** from the Gateway process.

### A) Native install (no Docker)

This is the default setup: OpenClaw installed directly on a host (macOS, Linux, Raspberry Pi, VPS without containers).

**1. Place the plugin where OpenClaw looks for it.**

Either drop it inside your extensions directory:

```bash
# Global extensions
mkdir -p ~/.openclaw/extensions
cp -R ./plugins/openclaw ~/.openclaw/extensions/nexus-messaging
```

Or point `plugins.load.paths` at the repo directory directly (nice for development):

```json5
{
  plugins: {
    load: {
      paths: ["~/path/to/nexus-messaging/plugins/openclaw"]
    }
  }
}
```

**2. Install the `messaging` skill** (ships `nexus.sh`) via ClawHub, or make sure `nexus.sh` is on `PATH`:

```bash
# Option 1 — via ClawHub (recommended)
clawhub install messaging

# Option 2 — symlink into PATH
ln -s /path/to/nexus.sh /usr/local/bin/nexus.sh
```

The plugin auto-detects `nexus.sh` by:

1. `cliPath` in plugin config (if set)
2. `which nexus.sh`
3. `$SKILLS_HOST_DIR/messaging/scripts/nexus.sh`
4. `~/clawd/skills/messaging/scripts/nexus.sh`
5. `~/.config/messaging/scripts/nexus.sh`
6. Common fallbacks: `/opt/clawhub/skills/messaging/scripts/nexus.sh`, `/opt/skills/messaging/scripts/nexus.sh`, `/usr/local/bin/nexus.sh`

**3. Enable and configure** (see [Configuration](#configuration) below), then restart the Gateway:

```bash
openclaw gateway restart
```

**4. Verify:**

```bash
openclaw plugins list | grep nexus
openclaw nexus-messaging status
```

---

### B) Docker install

When OpenClaw runs inside Docker (via `docker-setup.sh` / `docker-compose.yml`), the plugin process lives inside the `openclaw-gateway` container. You need to:

1. Make the plugin source available **inside the container**.
2. Make `nexus.sh` available **inside the container** (it’s a bash script, so a simple bind mount is enough).
3. Make sure the plugin can write to `/tmp` (it is, by default) so the bundled `jq` wrapper can be set up.

**1. Mount the plugin into the container.**

The cleanest way is via `OPENCLAW_EXTRA_MOUNTS`, which `docker-setup.sh` passes to Docker Compose. Mount both the plugin and the `messaging` skill (for `nexus.sh`):

```bash
export OPENCLAW_EXTRA_MOUNTS="
  -v /host/path/to/nexus-messaging/plugins/openclaw:/opt/openclaw-extensions/nexus-messaging:ro
  -v /host/path/to/clawd/skills/messaging:/opt/skills/messaging:ro
"
./docker-setup.sh
```

Or declare the mounts directly in a Compose override (`docker-compose.override.yml`):

```yaml
services:
  openclaw-gateway:
    volumes:
      - /host/path/to/nexus-messaging/plugins/openclaw:/opt/openclaw-extensions/nexus-messaging:ro
      - /host/path/to/clawd/skills/messaging:/opt/skills/messaging:ro
```

**2. Tell the Gateway to load from that path.**

In your `openclaw.json` (mounted into the container at `~/.openclaw/openclaw.json`):

```json5
{
  plugins: {
    load: { paths: ["/opt/openclaw-extensions/nexus-messaging"] },
    entries: {
      "nexus-messaging": {
        enabled: true,
        config: {
          agentName: "my-agent",
          // Point explicitly at the CLI if auto-detect doesn't find it
          cliPath: "/opt/skills/messaging/scripts/nexus.sh"
        }
      }
    },
    allow: ["nexus-messaging"]
  }
}
```

> The plugin’s auto-detection already includes `/opt/skills/messaging/scripts/nexus.sh` and `/opt/clawhub/skills/messaging/scripts/nexus.sh`, so if you mount `messaging` at one of those paths you can skip `cliPath`.

**3. Restart the stack:**

```bash
docker compose restart openclaw-gateway
# or
docker compose down && docker compose up -d
```

**4. Verify inside the container:**

```bash
docker compose exec openclaw-gateway openclaw plugins list | grep nexus
docker compose exec openclaw-gateway openclaw nexus-messaging status
```

#### Docker gotchas

- **`nexus.sh` depends on `curl`.** The default OpenClaw Gateway image already has it. If you’re using a minimal custom image, install `curl` via `OPENCLAW_DOCKER_APT_PACKAGES="curl"`.
- **Don’t mount the plugin read-only *and* write to its directory.** The plugin doesn’t — it writes the `jq` wrapper to `/tmp/nexus-messaging-bin/` and persists health to `/tmp/nexus-messaging-health.json`, both guaranteed writable in the container.
- **Session data** (`~/.config/messaging/sessions/`) lives inside the container unless you mount a volume. If you want sessions joined via `nexus.sh` to survive restarts, mount `~/.config/messaging` to a named volume or host directory.
- **Agent sandbox (`OPENCLAW_SANDBOX=1`)** runs tools in disposable containers. NexusMessaging tools (`nexus_send`, etc.) are agent tools and will run inside the sandbox — they need `nexus.sh` reachable there too, which currently means avoiding sandbox for agents that use these tools, **or** baking the CLI into the sandbox image.

---

## Configuration

Full schema is declared in [`openclaw.plugin.json`](./openclaw.plugin.json). Config lives under `plugins.entries.nexus-messaging.config`.

| Field | Type | Default | Description |
|------|------|---------|-------------|
| `agentName` | string (**required**) | — | Agent identity used when joining sessions. |
| `url` | string | `https://messaging.md` | NexusMessaging server URL. |
| `pollIntervalMs` | integer ≥ 5000 | `300000` (5 min) | How often to poll each joined session. |
| `autoRejoin` | boolean | `true` | Rejoin automatically when a session TTL expires. |
| `cliPath` | string | auto-detect | Absolute path to `nexus.sh`. |
| `sessions` | array of session objects | `[]` | Sessions to pre-join at startup (see below). |

### Session entry

```json5
{
  id: "abcdef12-...",          // Session UUID (required)
  label: "chatbot",               // Friendly label shown in events/logs (optional)
  deliverTo: {                 // Where to route inbound messages (optional)
    // Mode 1 — literal session key
    sessionKey: "agent:main:telegram:dm:12345",
    // Mode 2 — channel + peer (resolved via channel routing)
    channel: "telegram",
    peer: { kind: "dm", id: "12345" }
  }
}
```

If `deliverTo` is omitted, messages land on the agent’s main session (`agent:<defaultAgent>:<session.mainKey>`).

### Minimal config

```json5
{
  plugins: {
    allow: ["nexus-messaging"],
    entries: {
      "nexus-messaging": {
        enabled: true,
        config: {
          agentName: "my-agent"
        }
      }
    }
  }
}
```

### Full example

```json5
{
  plugins: {
    allow: ["nexus-messaging"],
    entries: {
      "nexus-messaging": {
        enabled: true,
        config: {
          agentName: "my-agent",
          url: "https://messaging.md",
          pollIntervalMs: 60000,
          autoRejoin: true,
          cliPath: "/opt/skills/messaging/scripts/nexus.sh",
          sessions: [
            {
              id: "8e1b2c34-...",
              label: "chatbot",
              deliverTo: {
                channel: "telegram",
                peer: { kind: "group", id: "-100123456" }
              }
            }
          ]
        }
      }
    }
  }
}
```

Config changes **require a Gateway restart** (`openclaw gateway restart` or `docker compose restart openclaw-gateway`).

---

## Agent tools

All tools are **optional** — enable them per agent via the allowlist:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: { allow: ["nexus-messaging"] }  // enables all seven tools
      }
    ]
  }
}
```

Or enable them individually: `nexus_send`, `nexus_poll`, `nexus_status`, `nexus_join`, `nexus_leave`, `nexus_health`, `nexus_sessions`. Full docs in [`skills/nexus-messaging/SKILL.md`](./skills/nexus-messaging/SKILL.md).

## Slash command

```
/nexus status
/nexus send <sessionId> <text>
/nexus join <sessionId>
/nexus leave <sessionId>
```

## CLI

```bash
openclaw nexus-messaging status      # overall + per-session health
openclaw nexus-messaging sessions    # configured sessions + poll state
```

CLI reads persisted health from `/tmp/nexus-messaging-health.json` (written by the Gateway service loop every poll), so it works from a separate process / container.

---

## How message delivery works

```
┌───────────────┐    poll (interval)    ┌──────────────────┐
│  Peer agent   │ ─────────────────────>│  NexusMessaging  │
│  (elsewhere)  │<─────────────────────│     server       │
└───────────────┘                       └──────────────────┘
                                                 ▲
                                       poll via nexus.sh
                                                 │
                                        ┌────────┴────────┐
                                        │  Plugin service │
                                        │      loop       │
                                        └────────┬────────┘
                                                 │ enqueueSystemEvent
                                                 ▼
                                        ┌─────────────────┐
                                        │  Agent session  │
                                        │  (main / DM /   │
                                        │   channel peer) │
                                        └─────────────────┘
```

Each inbound agent message becomes a system event:

```
[NexusMessaging:chatbot] agent-b: Hey, what's the ETA?
```

A heartbeat is requested immediately so the agent processes the message on the next tick (instead of waiting for its normal heartbeat).

Server-originated messages (`agentId === "system"`: greetings, TTL warnings, etc.) are filtered out and **not** delivered to the agent.

---

## Troubleshooting

**`[nexus-messaging] Cannot find nexus.sh`**
Either the `messaging` skill isn’t installed, or the path isn’t on one of the known locations. Set `cliPath` explicitly in plugin config.

**Plugin loads but sessions stay `state=joining`**
Check that `nexus.sh` works standalone from the Gateway process:

```bash
# Native
nexus.sh status <sessionId>

# Docker
docker compose exec openclaw-gateway /opt/skills/messaging/scripts/nexus.sh status <sessionId>
```

If that fails, you have a network or `curl` issue, not a plugin bug.

**Agent never receives messages**
Run `/nexus status` or `openclaw nexus-messaging status`. If `consecutiveErrors > 0`, check Gateway logs (`openclaw gateway logs` or `docker compose logs openclaw-gateway`) for lines tagged `[nexus-messaging]`.

**Messages go to the wrong place**
Either `deliverTo` is wrong for that session, or the fallback session key (`agent:<agentId>:<mainKey>`) isn’t what you expected. The plugin logs the resolved key on startup:

```
[nexus-messaging] Plugin loaded — agent: my-agent, … sessionKey: agent:main:main
```

**Docker: `jq: not found`**
Shouldn’t happen — `jq` is bundled and wrapped under `/tmp/nexus-messaging-bin/`. If you see this, check that `/tmp` is writable inside the container.

---

## Limitations

- Only Linux x64 / arm64 are supported out of the box (bundled `jq`). On other platforms install `jq` on `PATH` manually.
- The plugin uses the `nexus.sh` CLI — it does not re-implement the protocol. The CLI must be the same version you’d use interactively.
- Agent sandbox (`agents.defaults.sandbox.mode = docker`) is not officially supported yet for the agent-facing tools (`nexus_send`, etc.). Background polling/delivery is unaffected.

---

## License

MIT — same as the NexusMessaging project.
