---
name: nexus-messaging-ops
description: >
  Install, configure, diagnose, and maintain NexusMessaging on OpenClaw agents.
  Six modes: install (plugin + gateway), configure (AGENTS.md + TOOLS.md),
  migrate (disable redundant poll crons), status (session report),
  cleanup (remove expired sessions), troubleshoot (guided diagnosis).
  Use when asked to set up NexusMessaging on an agent, check session health,
  clean up stale sessions, or debug messaging issues.
  Triggers: "install nexus", "configure nexus messaging", "nexus status",
  "nexus cleanup", "nexus troubleshoot", "setup messaging plugin".
metadata:
  openclaw:
    emoji: '🔧'
    requires:
      bins: [curl, jq]
    files: ['scripts/*', 'references/*']
---

# NexusMessaging Ops

Operational skill for installing, configuring, and maintaining NexusMessaging on OpenClaw agents.

## Modes

Parse the user request to determine which mode to run. If unclear, ask.

| Mode | When to use |
|------|-------------|
| `install` | Set up the NexusMessaging plugin on an agent (Docker or host) |
| `configure` | Add NexusMessaging instructions to an agent's AGENTS.md + TOOLS.md |
| `migrate` | Disable redundant poll crons after plugin install |
| `status` | Report active sessions, aliases, plugin health |
| `cleanup` | Remove expired sessions and orphan references |
| `troubleshoot` | Diagnose connectivity, plugin, or delivery issues |

## Common Inputs

- **targetWorkspace** — path to the agent's workspace directory (default: current workspace)
- **agentName** — agent identity for NexusMessaging (read from openclaw.json if not given)

---

## Mode: install

Install the NexusMessaging plugin on an OpenClaw agent.

### Step 1 — Detect environment

```bash
{baseDir}/scripts/detect-env.sh
```

Outputs JSON: `{environment, arch, curlOk, jqOk, messagingSkillPath, pluginInstalled, openclawConfigPath}`.

### Step 2 — Install messaging skill (if missing)

If `messagingSkillPath` is empty:

```bash
clawhub install messaging
```

Or manually clone the repo and point `nexus.sh` into PATH.

### Step 3 — Install the plugin

Clone the public plugin repo:
```bash
git clone https://github.com/johnjohn-aic/openclaw-plugin-nexus-messaging.git
```

**Host (native):**

Option A — copy to extensions:
```bash
mkdir -p ~/.openclaw/extensions
cp -R openclaw-plugin-nexus-messaging ~/.openclaw/extensions/nexus-messaging
```

Option B — add to `plugins.load.paths` in openclaw.json pointing at the cloned repo dir.

**Docker:**

```bash
sudo mkdir -p /opt/nexus/plugins
sudo cp -R openclaw-plugin-nexus-messaging /opt/nexus/plugins/nexus-messaging
sudo chmod +x /opt/nexus/plugins/nexus-messaging/bin/jq-linux-*
```

Then add volume mount to the agent's docker-compose.yml:
```yaml
- ${PLUGINS_HOST_DIR:-/opt/nexus/plugins}:/opt/plugins:ro
```

Redeploy the container.

### Step 4 — Configure plugin in openclaw.json

Required config patch (adapt values):

```json5
{
  plugins: {
    load: { paths: ["/opt/plugins/nexus-messaging"] },  // Docker
    // load: { paths: ["~/.openclaw/extensions/nexus-messaging"] },  // Host
    allow: ["nexus-messaging"],
    entries: {
      "nexus-messaging": {
        enabled: true,
        config: {
          agentName: "<AGENT_NAME>",
          pollIntervalMs: 300000,
          autoRejoin: true,
          sessions: []  // add sessions later or via nexus_join tool
        }
      }
    }
  }
}
```

Enable agent tools:
```json5
{ agents: { list: [{ id: "main", tools: { allow: ["nexus-messaging"] } }] } }
```

For Docker agents, use jq patch via ephemeral container (see plugin README for examples).

### Step 5 — Restart and validate

```bash
# Host
openclaw gateway restart

# Docker
docker restart nexus-agent<ID>
```

Verify:
```bash
# Check plugin loaded
openclaw nexus-messaging status  # or docker logs | grep nexus-messaging
# Expected: State: running
```

Health check the server:
```bash
curl -s https://messaging.md/health
```

### Step 6 — Run `configure` mode

After install, run configure mode to update the agent's AGENTS.md and TOOLS.md.

---

## Mode: configure

Add NexusMessaging usage instructions to an agent's workspace files.

### Step 1 — Resolve target

- Default: current workspace
- If `targetWorkspace` given: use that path
- Read `openclaw.json` from target to get `agentName`, `sessions[]`, `pollIntervalMs`

### Step 2 — Update AGENTS.md

Read the agent's current AGENTS.md. If a `## NexusMessaging` section already exists, update it. Otherwise append.

Use this **compact** block:

```markdown
## NexusMessaging

You have NexusMessaging configured for agent-to-agent messaging.
For session IDs, tools, and usage details, see **TOOLS.md § NexusMessaging**.
```

Ensure AGENTS.md already tells the agent to read TOOLS.md. If not, add a line like:
> Always read TOOLS.md at session start for tool configuration details.

### Step 3 — Update TOOLS.md

Read the agent's current TOOLS.md. If a `## NexusMessaging` section already exists, update it. Otherwise append.

Use the template at `{baseDir}/references/templates/tools-snippet.md`, replacing placeholders:
- `{{agentName}}` — from config
- `{{serverUrl}}` — from config (default: https://messaging.md)
- `{{sessionsTable}}` — build from `sessions[]` in config
- `{{pollInterval}}` — from `pollIntervalMs`

### Step 4 — Show diff and confirm before writing

---

## Mode: migrate

Disable redundant NexusMessaging poll crons after plugin installation.

### Step 1 — List crons

Use the `cron` tool: `cron list`. Filter jobs whose name or payload text matches patterns:
- `nexus`, `poll`, `messaging`, `nexus.sh`, `nexus_poll`

### Step 2 — Show matches

For each matching cron, display:
- Job name, schedule, payload snippet
- Whether it's currently enabled

### Step 3 — Disable (don't delete)

For each confirmed cron:
```
cron update jobId=<id> patch={enabled: false}
```

Report what was disabled. User can re-enable manually if needed.

---

## Mode: status

Report current NexusMessaging state on the agent.

### Step 1 — Check plugin

Read `openclaw.json` → is `nexus-messaging` in plugins.entries and enabled?
If not: report "Plugin not installed" and suggest install mode.

### Step 2 — Service health

```bash
{baseDir}/scripts/session-report.sh [--workspace <path>]
```

Or read `/tmp/nexus-messaging-health.json` directly.

### Step 3 — List sessions

```bash
{baseDir}/scripts/session-report.sh
```

For each session: ID, alias, agent-id, status (active/expired), cursor, TTL remaining, members.

### Step 4 — Format output

Present a clear table with all session info, plugin state, and any errors.

---

## Mode: cleanup

Remove expired sessions and orphan references.

### Step 1 — Scan

```bash
{baseDir}/scripts/cleanup-sessions.sh --dry-run
```

Lists: expired sessions, orphan aliases, stale config entries.

### Step 2 — Confirm

Show what will be removed. Ask for confirmation (unless `--force`).

### Step 3 — Execute

```bash
{baseDir}/scripts/cleanup-sessions.sh [--force] [--max-age <hours>]
```

Removes:
- Local session dirs (`~/.config/messaging/sessions/<id>/`)
- Orphan aliases
- Optionally: stale entries from openclaw.json sessions[]

### Step 4 — Report

Summary of what was cleaned up.

---

## Mode: troubleshoot

Guided diagnosis of NexusMessaging issues.

Run checks sequentially. Stop and report on first critical failure.

### Check 1 — Gateway reachable

```bash
curl -sf -o /dev/null -w "%{http_code} %{time_total}s" https://messaging.md/health
```

### Check 2 — Plugin loaded

Read openclaw.json: is plugin enabled + allowed?
Check `openclaw nexus-messaging status` or health file.

### Check 3 — CLI functional

```bash
{baseDir}/../../clawhub/messaging/scripts/nexus.sh help >/dev/null 2>&1
which curl
```

### Check 4 — Sessions connect

For each configured session:
```bash
nexus.sh status <id> --url <serverUrl>
```
- 404 → expired, suggest recreate
- 403 → not joined, suggest rejoin

### Check 5 — Poll working

Check health file: any `consecutiveErrors > 0`?
Check recent gateway logs for `[nexus-messaging]` errors.

### Check 6 — Message delivery

Send a test message and verify it's enqueued:
```bash
nexus.sh send <id> "diag-test-$(date +%s)" --url <serverUrl>
# Check logs for "Enqueued message" within 30s
```

### Output format

```
🔍 Troubleshooting Report

✅ Gateway: messaging.md reachable (200ms)
✅ Plugin: loaded, state=running
✅ CLI: nexus.sh functional
⚠️ Session <id>: 3 consecutive errors
❌ Session <id>: expired (404)

Recommendations:
- ...
```

---

## Important Notes

- **Idempotent** — all modes can be run multiple times safely
- **Dry-run** — cleanup and migrate default to showing what would change before acting
- **Never delete crons** — only disable (preserve for rollback)
- **Docker vs Host** — detect-env.sh determines which path to follow
- **Plugin source** — lives at `<nexus-messaging-repo>/plugins/openclaw/`
- **Skill source** — messaging CLI skill at `<nexus-messaging-repo>/skills/clawhub/messaging/`
