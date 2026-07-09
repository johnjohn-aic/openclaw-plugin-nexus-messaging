#!/usr/bin/env bash
set -euo pipefail

# Session keys are credentials — keep everything we write owner-only
umask 077
# Tighten state written before umask existed (echo > preserves the old mode)
[[ -d "$HOME/.config/messaging" ]] && chmod -R go-rwx "$HOME/.config/messaging" 2>/dev/null || true

# NexusMessaging CLI wrapper
# Usage: nexus.sh <command> [args] [--url URL] [--agent-id ID] [--ttl N] [--after CURSOR] [--members]
#
# stdout: JSON only (pipeable to jq)
# stderr: human-readable tips, status messages

NEXUS_URL_ENV="${NEXUS_URL:-}"            # raw env before any default (lets us name the source)
NEXUS_DEFAULT_URL="https://messaging.md"
NEXUS_URL=""                              # effective URL — set by resolve_server_url after arg parse
SERVER_SOURCE=""                          # --url | env NEXUS_URL | config | default | session binding
URL_FLAG=""                               # value of --url, if given
NEXUS_DATA_DIR="${HOME}/.config/messaging/sessions"
NEXUS_ALIASES_FILE="${HOME}/.config/messaging/aliases.json"
NEXUS_CAPS_FILE="${HOME}/.config/messaging/server-caps.json"
NEXUS_CONFIG_FILE="${HOME}/.config/messaging/config.json"

# Normalize a server URL for storage + comparison: lowercase scheme + host[:port],
# strip a trailing slash. ponytail: no default-port folding (:80/:443) — base URLs
# never carry it; add it here if a divergence check ever proves too literal.
normalize_url() {
  local url="${1%/}"
  if [[ "$url" != *"://"* ]]; then
    # Scheme-less input (e.g. "messaging.md"): lowercase the authority, keep any
    # path, and leave the scheme for curl to default — matches the pre-config
    # behavior instead of fabricating a bogus "host://host".
    local a0="${url%%/*}" p0=""
    [[ "$url" == */* ]] && p0="/${url#*/}"
    printf '%s%s\n' "$(printf '%s' "$a0" | tr '[:upper:]' '[:lower:]')" "$p0"
    return 0
  fi
  local scheme="${url%%://*}" rest="${url#*://}" path=""
  [[ "$rest" == */* ]] && path="/${rest#*/}"
  local authority="${rest%%/*}"
  scheme=$(printf '%s' "$scheme" | tr '[:upper:]' '[:lower:]')
  authority=$(printf '%s' "$authority" | tr '[:upper:]' '[:lower:]')
  printf '%s://%s%s\n' "$scheme" "$authority" "$path"
}

# Resolve the effective server URL + its source. Precedence: --url > NEXUS_URL env >
# config.serverUrl > built-in default. Every call always resolves a server; the
# absence of config is never an error (zero-config install-and-go is preserved).
resolve_server_url() {
  if [[ -n "$URL_FLAG" ]]; then
    NEXUS_URL=$(normalize_url "$URL_FLAG"); SERVER_SOURCE="--url"
  elif [[ -n "$NEXUS_URL_ENV" ]]; then
    NEXUS_URL=$(normalize_url "$NEXUS_URL_ENV"); SERVER_SOURCE="env NEXUS_URL"
  else
    local cfg=""
    [[ -f "$NEXUS_CONFIG_FILE" ]] && cfg=$(jq -r '.serverUrl // empty' "$NEXUS_CONFIG_FILE" 2>/dev/null || true)
    if [[ -n "$cfg" ]]; then
      NEXUS_URL=$(normalize_url "$cfg"); SERVER_SOURCE="config"
    else
      NEXUS_URL="$NEXUS_DEFAULT_URL"; SERVER_SOURCE="default"
    fi
  fi
}

# One provenance line to stderr — which server, and why. stdout stays JSON-only.
provenance_line() {
  local host="${NEXUS_URL#*://}"; host="${host%%/*}"
  echo "→ server: $host ($SERVER_SOURCE)" >&2
}

# Loud warning when a configured server is being overridden by --url/env (and only then).
divergence_warning() {
  [[ "$SERVER_SOURCE" == "--url" || "$SERVER_SOURCE" == "env NEXUS_URL" ]] || return 0
  [[ -f "$NEXUS_CONFIG_FILE" ]] || return 0
  local cfg
  cfg=$(jq -r '.serverUrl // empty' "$NEXUS_CONFIG_FILE" 2>/dev/null || true)
  [[ -n "$cfg" ]] || return 0
  cfg=$(normalize_url "$cfg")
  if [[ "$NEXUS_URL" != "$cfg" ]]; then
    echo "⚠️  server override: using $NEXUS_URL ($SERVER_SOURCE) — configured server is $cfg" >&2
  fi
}

# Provenance + divergence, once, before the first network request of a command.
net_preamble() {
  divergence_warning
  provenance_line
}

# Route a session-scoped command to the session's bound server (self-healing): a
# 48-hex SID lives on exactly one server, so following the binding can only turn a
# wrong-server miss into a right-server hit. Never fails — warnings only.
route_session_server() {
  local sid="$1"
  local f="$NEXUS_DATA_DIR/$sid/server" bound=""
  [[ -f "$f" ]] && bound=$(normalize_url "$(cat "$f")")
  if [[ -n "$URL_FLAG" ]]; then
    if [[ -n "$bound" && "$NEXUS_URL" != "$bound" ]]; then
      echo "⚠️  session ${sid:0:12}… is bound to $bound — using $NEXUS_URL (--url overrides the binding)" >&2
    fi
    return 0
  fi
  if [[ -n "$bound" ]]; then
    if [[ "$bound" != "$NEXUS_URL" ]]; then
      if [[ "$SERVER_SOURCE" == "default" ]]; then
        echo "ℹ️  using session's bound server $bound (ambient would have used $NEXUS_URL via default)" >&2
      else
        echo "⚠️  session ${sid:0:12}… is bound to $bound — overriding $NEXUS_URL ($SERVER_SOURCE)" >&2
      fi
    fi
    NEXUS_URL="$bound"; SERVER_SOURCE="session binding"
  fi
  return 0
}

# TOFU: adopt the effective server as the binding after a successful (2xx) call.
# Only ever reached post-success (emit_response exits 1 first on failure).
adopt_binding_if_unbound() {
  local sid="$1"
  local f="$NEXUS_DATA_DIR/$sid/server"
  [[ -d "$NEXUS_DATA_DIR/$sid" ]] || return 0
  [[ -f "$f" ]] && return 0
  echo "$NEXUS_URL" > "$f"
  echo "ℹ️  adopted binding: ${sid:0:12}… → $NEXUS_URL (first successful use)" >&2
}

# Record the session→server binding on acquisition (create/join/claim).
write_binding() {
  local sid="$1"
  mkdir -p "$NEXUS_DATA_DIR/$sid"
  echo "$NEXUS_URL" > "$NEXUS_DATA_DIR/$sid/server"
}

# Resolve alias → session ID (or pass through if not an alias)
resolve_session() {
  local input="$1"
  if [[ -f "$NEXUS_ALIASES_FILE" ]]; then
    local resolved
    resolved=$(jq -r --arg name "$input" '.[$name] // empty' "$NEXUS_ALIASES_FILE" 2>/dev/null)
    if [[ -n "$resolved" ]]; then
      echo "$resolved"
      return
    fi
  fi
  echo "$input"
}

# Reverse-resolve session ID → alias (empty if none)
reverse_alias() {
  local session_id="$1"
  if [[ -f "$NEXUS_ALIASES_FILE" ]]; then
    jq -r --arg sid "$session_id" 'to_entries[] | select(.value == $sid) | .key' "$NEXUS_ALIASES_FILE" 2>/dev/null | head -1
  fi
}

# Remove alias by name from aliases.json
remove_alias() {
  local name="$1"
  if [[ -f "$NEXUS_ALIASES_FILE" ]]; then
    local tmp
    tmp=$(jq -c --arg name "$name" 'del(.[$name])' "$NEXUS_ALIASES_FILE" 2>/dev/null)
    if [[ -n "$tmp" ]]; then
      echo "$tmp" > "$NEXUS_ALIASES_FILE"
    fi
  fi
}

# Clean up local leave state: remove data dir + any alias for a session.
# Called only when the server confirms we're no longer a member.
cleanup_leave_state() {
  local sid="$1" alias_name="$2"
  rm -rf "$NEXUS_DATA_DIR/$sid"
  if [[ -n "$alias_name" ]]; then
    remove_alias "$alias_name"
  else
    local found
    found=$(reverse_alias "$sid")
    if [[ -n "$found" ]]; then
      remove_alias "$found"
    fi
  fi
}

# HTTP request helper: preserves error body on failure
# Usage: http_request [curl args...]
# Sets RESPONSE and HTTP_OK (true/false)
http_request() {
  local exit_code=0
  # Bound every request: poll is not long-poll (server returns immediately), so
  # no legit call holds the connection open. Prevents poll-all from hanging on a
  # wedged server once it started polling unreachable sessions. Tunable for slow nets.
  RESPONSE=$(curl -s --fail-with-body --max-time "${NEXUS_HTTP_TIMEOUT:-10}" "$@") || exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    HTTP_OK=false
  else
    HTTP_OK=true
  fi
}

# Emit RESPONSE to stdout; if HTTP failed, also exit 1.
# When RESPONSE is not valid JSON (transport failure / proxy HTML),
# emit a synthetic JSON error to stdout instead of raw output.
emit_response() {
  if [[ "$HTTP_OK" == "true" ]]; then
    echo "$RESPONSE"
  else
    if echo "$RESPONSE" | jq -e . >/dev/null 2>&1; then
      echo "$RESPONSE"
    else
      echo '{"error":"non_json_response"}'
      if [[ -n "$RESPONSE" ]]; then
        echo "→ non-JSON response (possible proxy/LB error):" >&2
        printf '%s\n' "$RESPONSE" | head -c 500 >&2
        echo "" >&2
      fi
    fi
    exit 1
  fi
}

# Resolve the server's supported message formats, with a 5-minute disk cache.
# stdout: space-separated list of supported formats (e.g. "text json").
# On any cache miss / unreadable cache / health failure, returns "text" only
# (conservative: assume the server does NOT support json).
get_server_capability() {
  local now fetched_at age formats health_resp
  now=$(date +%s)

  # 1. Use fresh disk cache (TTL 300s)
  if [[ -f "$NEXUS_CAPS_FILE" ]]; then
    fetched_at=$(jq -r '.fetchedAt // empty' "$NEXUS_CAPS_FILE" 2>/dev/null || true)
    if [[ "$fetched_at" =~ ^[0-9]+$ ]]; then
      age=$(( now - fetched_at ))
      if (( age < 300 )); then
        jq -r '(.capabilities.messageFormat // []) | join(" ")' "$NEXUS_CAPS_FILE" 2>/dev/null || true
        return 0
      fi
    fi
  fi

  # 2. Cache miss or stale — query the health endpoint
  health_resp=$(curl -s --max-time 5 "$NEXUS_URL/health" 2>/dev/null || true)
  formats=$(jq -r '(.capabilities.messageFormat // []) | join(" ")' <<<"$health_resp" 2>/dev/null || true)

  if [[ -n "$formats" ]]; then
    # 3. Persist the capabilities object with a fetchedAt timestamp
    mkdir -p "$(dirname "$NEXUS_CAPS_FILE")"
    jq -c --argjson now "$now" '{capabilities, fetchedAt: $now}' <<<"$health_resp" > "$NEXUS_CAPS_FILE" 2>/dev/null || true
    printf '%s\n' "$formats"
    return 0
  fi

  # 4. Conservative fallback: assume the server does not support json
  printf 'text\n'
  return 0
}
AGENT_ID=""
TTL=""
AFTER=""
GREETING=""
INTERVAL=""
MAX_AGENTS=""
CREATOR_AGENT_ID=""
MEMBERS=""
POSITIONAL=()

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --url) URL_FLAG="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --ttl) TTL="$2"; shift 2 ;;
    --after) AFTER="$2"; shift 2 ;;
    --greeting) GREETING="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --max-agents) MAX_AGENTS="$2"; shift 2 ;;
    --creator-agent-id) CREATOR_AGENT_ID="$2"; shift 2 ;;
    --members) MEMBERS="true"; shift ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]}"

# Resolve the effective server (--url > env > config > default) once, up front.
resolve_server_url

CMD="${1:-help}"
shift || true

case "$CMD" in
  create)
    if [[ -z "${TTL:-}" ]]; then
      echo "⚠️  TTL not specified — using default 3660s (~1h)" >&2
    fi
    TTL_VAL="${TTL:-3660}"
    BODY="{\"ttl\": $TTL_VAL}"

    if [[ -n "${GREETING:-}" ]]; then
      BODY=$(echo "$BODY" | jq -c --arg greeting "$GREETING" '. + {greeting: $greeting}')
    fi

    if [[ -n "${MAX_AGENTS:-}" ]]; then
      BODY=$(echo "$BODY" | jq -c --argjson maxAgents "$MAX_AGENTS" '. + {maxAgents: $maxAgents}')
    fi

    if [[ -n "${CREATOR_AGENT_ID:-}" ]]; then
      BODY=$(echo "$BODY" | jq -c --arg creatorAgentId "$CREATOR_AGENT_ID" '. + {creatorAgentId: $creatorAgentId}')
    fi

    net_preamble
    http_request -X PUT "$NEXUS_URL/v1/sessions" \
      -H "Content-Type: application/json" \
      -d "$BODY"
    emit_response

    if [[ -n "${CREATOR_AGENT_ID:-}" ]]; then
      SESSION_ID=$(echo "$RESPONSE" | jq -r '.sessionId // empty')
      if [[ -n "$SESSION_ID" ]]; then
        mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
        write_binding "$SESSION_ID"
        AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
        echo "$CREATOR_AGENT_ID" > "$AGENT_FILE"

        SESSION_KEY=$(echo "$RESPONSE" | jq -r '.sessionKey // empty')
        if [[ -n "$SESSION_KEY" ]]; then
          KEY_FILE="$NEXUS_DATA_DIR/$SESSION_ID/key"
          echo "$SESSION_KEY" > "$KEY_FILE"
        fi
      fi
    fi
    ;;

  alias)
    SESSION_ID="${1:?Usage: nexus.sh alias <SESSION_ID> <NAME>}"
    ALIAS_NAME="${2:?Usage: nexus.sh alias <SESSION_ID> <NAME>}"
    SESSION_ID=$(resolve_session "$SESSION_ID")

    if [[ ! -d "$NEXUS_DATA_DIR/$SESSION_ID" ]]; then
      echo "{\"error\":\"session not found locally — join or claim first\"}" && exit 1
    fi

    mkdir -p "$(dirname "$NEXUS_ALIASES_FILE")"
    if [[ ! -f "$NEXUS_ALIASES_FILE" ]]; then
      echo '{}' > "$NEXUS_ALIASES_FILE"
    fi

    jq -c --arg name "$ALIAS_NAME" --arg sid "$SESSION_ID" '. + {($name): $sid}' "$NEXUS_ALIASES_FILE" > "${NEXUS_ALIASES_FILE}.tmp"
    mv "${NEXUS_ALIASES_FILE}.tmp" "$NEXUS_ALIASES_FILE"

    echo "{\"ok\":true,\"alias\":\"$ALIAS_NAME\",\"sessionId\":\"$SESSION_ID\"}"
    echo "✅ Alias set: $ALIAS_NAME → ${SESSION_ID:0:12}..." >&2
    ;;

  unalias)
    ALIAS_NAME="${1:?Usage: nexus.sh unalias <NAME>}"

    if [[ ! -f "$NEXUS_ALIASES_FILE" ]]; then
      echo '{"error":"no aliases configured"}' && exit 1
    fi

    EXISTS=$(jq -r --arg name "$ALIAS_NAME" 'has($name)' "$NEXUS_ALIASES_FILE" 2>/dev/null)
    if [[ "$EXISTS" != "true" ]]; then
      echo "{\"error\":\"alias not found: $ALIAS_NAME\"}" && exit 1
    fi

    remove_alias "$ALIAS_NAME"
    echo "{\"ok\":true,\"removed\":\"$ALIAS_NAME\"}"
    echo "✅ Alias removed: $ALIAS_NAME" >&2
    ;;

  ls)
    if [[ ! -d "$NEXUS_DATA_DIR" ]]; then
      echo '{"sessions":[]}'
      exit 0
    fi

    ACTIVE_ONLY=""
    JSON_OUT=""
    STATUS_TIMEOUT="${NEXUS_STATUS_TIMEOUT:-3}"
    for arg in "$@"; do
      case "$arg" in
        --active) ACTIVE_ONLY="true" ;;
        --json) JSON_OUT="true" ;;
      esac
    done

    net_preamble
    SESSIONS_JSON="[]"
    for session_dir in "$NEXUS_DATA_DIR"/*/; do
      [[ -d "$session_dir" ]] || continue
      SID=$(basename "$session_dir")

      AGENT=""
      [[ -f "$session_dir/agent" ]] && AGENT=$(cat "$session_dir/agent")

      CURSOR=""
      [[ -f "$session_dir/cursor" ]] && CURSOR=$(cat "$session_dir/cursor")

      ALIAS_NAME=$(reverse_alias "$SID")

      # Probe each session against ITS OWN bound server (unbound → effective URL),
      # so a wrong global env can no longer poison the whole listing.
      # Classify by HTTP code, not response body: separates transport failure
      # (curl exit != 0 → "000") from application errors (404 vs other).
      PROBE_URL="$NEXUS_URL"
      [[ -f "$session_dir/server" ]] && PROBE_URL=$(normalize_url "$(cat "$session_dir/server")")
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$STATUS_TIMEOUT" \
        "$PROBE_URL/v1/sessions/$SID" 2>/dev/null) || HTTP_CODE="000"
      case "$HTTP_CODE" in
        200)     SESSION_STATUS="active" ;;
        404)     SESSION_STATUS="not_found" ;;
        000|"")  SESSION_STATUS="unreachable" ;;  # timeout, refused, DNS — transport failed
        *)       SESSION_STATUS="error" ;;        # 5xx, 429, anything else
      esac

      # --active keeps possibly-alive sessions (active + unreachable); drops not_found/error.
      if [[ "$ACTIVE_ONLY" == "true" && "$SESSION_STATUS" != "active" && "$SESSION_STATUS" != "unreachable" ]]; then
        continue
      fi

      SESSIONS_JSON=$(echo "$SESSIONS_JSON" | jq -c \
        --arg sid "$SID" \
        --arg alias "$ALIAS_NAME" \
        --arg agent "$AGENT" \
        --arg status "$SESSION_STATUS" \
        --arg cursor "$CURSOR" \
        --arg server "$PROBE_URL" \
        '. + [{sessionId: $sid, alias: ($alias | if . == "" then null else . end), agentId: $agent, status: $status, server: $server, cursor: ($cursor | if . == "" then null else . end)}]')
    done

    # Table format for TTY, JSON always on stdout
    if [[ -t 1 && "$JSON_OUT" != "true" ]]; then
      COUNT=$(echo "$SESSIONS_JSON" | jq 'length')
      if [[ "$COUNT" -eq 0 ]]; then
        echo "No sessions found." >&2
        echo '{"sessions":[]}'
        exit 0
      fi
      printf "%-12s %-14s %-12s %-12s\n" "ALIAS" "SESSION" "AGENT-ID" "STATUS" >&2
      echo "$SESSIONS_JSON" | jq -r '.[] | [(.alias // "—"), (.sessionId[:12] + "..."), .agentId, .status] | @tsv' | \
        while IFS=$'\t' read -r a s ag st; do
          printf "%-12s %-14s %-12s %-12s\n" "$a" "$s" "$ag" "$st" >&2
        done
    fi

    echo "$SESSIONS_JSON" | jq -c '{sessions: .}'
    ;;

  poll-all)
    ACTIVE_ONLY=""
    MEMBERS_ALL=""
    for arg in "$@"; do
      case "$arg" in
        --active) ACTIVE_ONLY="true" ;;
        --members) MEMBERS_ALL="true" ;;
      esac
    done

    LS_ARGS=""
    [[ "$ACTIVE_ONLY" == "true" ]] && LS_ARGS="--active"

    LS_JSON=$("$0" ls $LS_ARGS --json 2>/dev/null)
    SESSIONS=$(echo "$LS_JSON" | jq -c '.sessions[]' 2>/dev/null)
    if [[ -z "$SESSIONS" ]]; then
      echo '{"sessions":[]}'
      exit 0
    fi

    # Provenance: poll-all delegates to per-session `poll` (each follows its own
    # binding), so a single "→ server" line would mislead. Summarize the distinct
    # servers actually being contacted. Count/servers use the SAME filter as the
    # poll loop below (active + unreachable) — else an --active-less run would
    # overstate the count by including not_found/error sessions it never polls.
    PA_COUNT=$(echo "$LS_JSON" | jq '[.sessions[] | select(.status=="active" or .status=="unreachable")] | length' 2>/dev/null || echo 0)
    PA_SERVERS=$(echo "$LS_JSON" | jq -r '[.sessions[] | select(.status=="active" or .status=="unreachable") | .server] | map(sub("^https?://";"")) | unique | join(", ")' 2>/dev/null || true)
    [[ "$PA_COUNT" -gt 0 ]] && echo "→ polling $PA_COUNT session(s) across: ${PA_SERVERS:-?} (per-session bindings)" >&2

    RESULTS="[]"
    TOTAL_MSGS=0

    while IFS= read -r session; do
      SID=$(echo "$session" | jq -r '.sessionId')
      ALIAS_NAME=$(echo "$session" | jq -r '.alias // empty')
      STATUS=$(echo "$session" | jq -r '.status')

      # Mirror ls --active: poll active + unreachable (may be a transient blip
      # that has since cleared); skip not_found/error (server disowned it).
      # Without unreachable here, poll-all --active would silently drop live
      # sessions on a network blip — the exact bug this change fixes.
      if [[ "$STATUS" != "active" && "$STATUS" != "unreachable" ]]; then
        continue
      fi

      POLL_ARGS="$SID"
      [[ "$MEMBERS_ALL" == "true" ]] && POLL_ARGS="$SID --members"

      POLL_RESP=$("$0" poll $POLL_ARGS 2>/dev/null) || POLL_RESP='{"messages":[],"error":"poll_failed"}'
      POLL_RESP=$(echo "$POLL_RESP" | jq -c '.' 2>/dev/null) || POLL_RESP='{"messages":[],"error":"invalid_json"}'
      MSG_COUNT=$(echo "$POLL_RESP" | jq '.messages | length // 0')
      TOTAL_MSGS=$((TOTAL_MSGS + MSG_COUNT))

      ENTRY=$(echo "$POLL_RESP" | jq -c \
        --arg sid "$SID" \
        --arg alias "$ALIAS_NAME" \
        '{sessionId: $sid, alias: ($alias | if . == "" then null else . end), messages: .messages, members: (.members // null)}')

      RESULTS=$(echo "$RESULTS" | jq -c --argjson entry "$ENTRY" '. + [$entry]')
    done <<< "$SESSIONS"

    echo "$RESULTS" | jq -c '{sessions: .}'

    if [[ $TOTAL_MSGS -gt 0 ]]; then
      echo "" >&2
      echo "💬 $TOTAL_MSGS new message(s) across sessions" >&2
    fi
    ;;

  status)
    SESSION_ID="${1:?Usage: nexus.sh status <SESSION_ID>}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble
    http_request "$NEXUS_URL/v1/sessions/$SESSION_ID"
    emit_response
    adopt_binding_if_unbound "$SESSION_ID"
    ;;

  join)
    SESSION_ID="${1:?Usage: nexus.sh join <SESSION_ID> --agent-id ID}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    [[ -z "$AGENT_ID" ]] && echo '{"error":"missing --agent-id"}' && exit 1
    net_preamble
    http_request -X POST "$NEXUS_URL/v1/sessions/$SESSION_ID/join" \
      -H "X-Agent-Id: $AGENT_ID"
    emit_response

    mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
    write_binding "$SESSION_ID"
    AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
    echo "$AGENT_ID" > "$AGENT_FILE"

    SESSION_KEY=$(echo "$RESPONSE" | jq -r '.sessionKey // empty')
    if [[ -n "$SESSION_KEY" ]]; then
      KEY_FILE="$NEXUS_DATA_DIR/$SESSION_ID/key"
      echo "$SESSION_KEY" > "$KEY_FILE"
    fi
    ;;

  pair)
    SESSION_ID="${1:?Usage: nexus.sh pair <SESSION_ID>}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble
    http_request -X PUT "$NEXUS_URL/v1/pair" \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\": \"$SESSION_ID\"}"
    emit_response
    adopt_binding_if_unbound "$SESSION_ID"
    ;;

  claim)
    CODE="${1:?Usage: nexus.sh claim <CODE> --agent-id ID}"
    [[ -z "$AGENT_ID" ]] && echo '{"error":"missing --agent-id"}' && exit 1

    net_preamble
    http_request -X POST "$NEXUS_URL/v1/pair/$CODE/claim" \
      -H "X-Agent-Id: $AGENT_ID"
    emit_response

    SESSION_ID=$(echo "$RESPONSE" | jq -r '.sessionId // empty')
    if [[ -n "$SESSION_ID" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      write_binding "$SESSION_ID"
      AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
      echo "$AGENT_ID" > "$AGENT_FILE"

      SESSION_KEY=$(echo "$RESPONSE" | jq -r '.sessionKey // empty')
      if [[ -n "$SESSION_KEY" ]]; then
        KEY_FILE="$NEXUS_DATA_DIR/$SESSION_ID/key"
        echo "$SESSION_KEY" > "$KEY_FILE"
      fi

      echo "" >&2
      echo "✅ Claimed! Next step: poll messages" >&2
      echo "$0 poll $SESSION_ID" >&2
    fi
    ;;

  pair-status)
    CODE="${1:?Usage: nexus.sh pair-status <CODE>}"
    net_preamble
    http_request "$NEXUS_URL/v1/pair/$CODE/status"
    emit_response
    ;;

  send)
    SESSION_ID="${1:?Usage: nexus.sh send <SESSION_ID> \"text\" [--json PAYLOAD] [--strict]}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble
    shift || true

    TEXT=""
    JSON_PAYLOAD=""
    STRICT=""

    # Parse send-specific args (--json/--strict parsed here, NOT in the global
    # parser, so that other commands like `ls --json` keep working).
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json)
          if [[ $# -lt 2 || -z "${2:-}" ]]; then
            echo '{"error":"--json requires a value (JSON payload)"}' >&2
            exit 1
          fi
          JSON_PAYLOAD="$2"; shift 2 ;;
        --strict) STRICT="true"; shift ;;
        *)
          if [[ -z "$TEXT" ]]; then
            TEXT="$1"
          else
            TEXT="$TEXT $1"
          fi
          shift ;;
      esac
    done

    # At least one of text or --json is required
    if [[ -z "$TEXT" && -z "$JSON_PAYLOAD" ]]; then
      echo '{"error":"at least one of text or --json must be provided"}' >&2
      exit 1
    fi

    if [[ -z "$AGENT_ID" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
      if [[ -f "$AGENT_FILE" ]]; then
        AGENT_ID=$(cat "$AGENT_FILE")
      else
        echo '{"error":"missing --agent-id and no persisted agent-id found"}' && exit 1
      fi
    fi

    # Build the request body
    if [[ -n "$JSON_PAYLOAD" ]]; then
      # Validate the --json payload is valid JSON
      if ! printf '%s' "$JSON_PAYLOAD" | jq -e . >/dev/null 2>&1; then
        echo '{"error":"invalid JSON in --json payload"}' >&2
        exit 1
      fi

      FORMATS=$(get_server_capability)
      if [[ " $FORMATS " == *" json "* ]]; then
        # Server supports native json: { text?, json }
        BODY=$(printf '%s' "$JSON_PAYLOAD" | jq -c --arg text "$TEXT" \
          '{json: .} + (if $text == "" then {} else {text: $text} end)')
      else
        # Server lacks json support
        if [[ "$STRICT" == "true" ]]; then
          echo "✖  Server does not support json messages. Use without --strict to fall back to text, or omit --json." >&2
          exit 1
        fi
        # Conservative fallback: serialize the JSON payload into the text field
        echo "⚠️  Server does not support native json messages; payload serialized into text field." >&2
        BODY=$(printf '%s' "$JSON_PAYLOAD" | jq -c --arg text "$TEXT" \
          '{text: (if $text == "" then @json else ($text + " " + (@json)) end)}')
      fi
    else
      # Plain text-only send
      BODY=$(printf '%s' "$TEXT" | jq -Rs -c '{text: .}')
    fi

    KEY_FILE="$NEXUS_DATA_DIR/$SESSION_ID/key"
    if [[ -f "$KEY_FILE" ]]; then
      http_request -X POST "$NEXUS_URL/v1/sessions/$SESSION_ID/messages" \
        -H "X-Agent-Id: $AGENT_ID" \
        -H "X-Session-Key: $(cat "$KEY_FILE")" \
        -H "Content-Type: application/json" \
        -d "$BODY"
    else
      http_request -X POST "$NEXUS_URL/v1/sessions/$SESSION_ID/messages" \
        -H "X-Agent-Id: $AGENT_ID" \
        -H "Content-Type: application/json" \
        -d "$BODY"
    fi
    emit_response
    adopt_binding_if_unbound "$SESSION_ID"
    ;;

  poll)
    SESSION_ID="${1:?Usage: nexus.sh poll <SESSION_ID> [--agent-id ID] [--after CURSOR] [--members]}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble

    if [[ -z "$AGENT_ID" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
      if [[ -f "$AGENT_FILE" ]]; then
        AGENT_ID=$(cat "$AGENT_FILE")
      else
        echo '{"error":"missing --agent-id and no persisted agent-id found"}' && exit 1
      fi
    fi

    mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
    CURSOR_FILE="$NEXUS_DATA_DIR/$SESSION_ID/cursor"

    SAVED_CURSOR=""
    if [[ -f "$CURSOR_FILE" ]]; then
      SAVED_CURSOR=$(cat "$CURSOR_FILE")
    fi

    QUERY=""
    if [[ -n "$AFTER" ]]; then
      if [[ "$AFTER" == "0" ]]; then
        # after=0 means "replay from beginning" — don't send the param
        # (server treats after=0 as exclusive, skipping cursor-0 messages)
        QUERY=""
      else
        QUERY="?after=$AFTER"
      fi
    elif [[ -n "$SAVED_CURSOR" ]]; then
      QUERY="?after=$SAVED_CURSOR"
    fi

    if [[ "$MEMBERS" == "true" ]]; then
      if [[ -z "$QUERY" ]]; then
        QUERY="?members=true"
      else
        QUERY="$QUERY&members=true"
      fi
    fi

    http_request "$NEXUS_URL/v1/sessions/$SESSION_ID/messages$QUERY" \
      -H "X-Agent-Id: $AGENT_ID"
    emit_response
    adopt_binding_if_unbound "$SESSION_ID"

    NEXT_CURSOR=$(echo "$RESPONSE" | jq -r '.nextCursor // empty')
    if [[ -z "$AFTER" && -n "$NEXT_CURSOR" ]]; then
      echo "$NEXT_CURSOR" > "$CURSOR_FILE"
    fi

    MESSAGE_COUNT=$(echo "$RESPONSE" | jq -r '.messages | length')
    if [[ "$MESSAGE_COUNT" -gt 0 ]]; then
      echo "" >&2
      echo "💬 Received $MESSAGE_COUNT message(s)" >&2
      echo "Tip: Send a message:" >&2
      echo "$0 send $SESSION_ID \"Your message\"" >&2
    fi
    JSON_MSG_COUNT=$(echo "$RESPONSE" | jq '[.messages[] | select(has("json"))] | length' 2>/dev/null || echo 0)
    if [[ "$JSON_MSG_COUNT" -gt 0 ]]; then
      echo "📦 $JSON_MSG_COUNT message(s) include structured json data" >&2
    fi
    if [[ "$MEMBERS" == "true" ]]; then
      MEMBER_COUNT=$(echo "$RESPONSE" | jq -r '.members | length // 0')
      if [[ "$MEMBER_COUNT" -gt 0 ]]; then
        echo "" >&2
        echo "Members:" >&2
        echo "$RESPONSE" | jq -r '.members[] | "  - \(.agentId) (last seen: \(.lastSeenAt))"' >&2
      fi
    fi
    ;;

  poll-daemon)
    SESSION_ID="${1:?Usage: nexus.sh poll-daemon <SESSION_ID> [--agent-id ID] [--interval N] [--ttl N]}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble

    if [[ -z "$AGENT_ID" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
      if [[ -f "$AGENT_FILE" ]]; then
        AGENT_ID=$(cat "$AGENT_FILE")
      else
        echo '{"error":"missing --agent-id and no persisted agent-id found"}' && exit 1
      fi
    fi

    INTERVAL_VAL="${INTERVAL:-30}"
    TTL_VAL="${TTL:-3600}"

    echo "Should I poll for messages every ${INTERVAL_VAL}s for the next ${TTL_VAL}s? (y/n)" >&2
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
      echo "Polling daemon cancelled." >&2
      exit 0
    fi

    echo "Starting polling daemon..." >&2
    echo "Session: $SESSION_ID" >&2
    echo "Interval: ${INTERVAL_VAL}s" >&2
    echo "TTL: ${TTL_VAL}s" >&2
    echo "Press Ctrl+C to stop" >&2

    START_TIME=$(date +%s)
    trap 'echo "" >&2; echo "Polling daemon stopped." >&2; exit 0' SIGINT SIGTERM

    while true; do
      CURRENT_TIME=$(date +%s)
      ELAPSED=$((CURRENT_TIME - START_TIME))

      if [[ $ELAPSED -ge $TTL_VAL ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - TTL expired, stopping poll daemon" >&2
        break
      fi

      RESPONSE=$("$0" poll "$SESSION_ID" 2>/dev/null || echo "{}")
      MESSAGE_COUNT=$(echo "$RESPONSE" | jq -r '.messages | length // 0')

      if [[ "$MESSAGE_COUNT" -gt 0 ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - Poll: $MESSAGE_COUNT new message(s)" >&2
      fi

      sleep "$INTERVAL_VAL"
    done
    ;;

  heartbeat)
    SESSION_ID="${1:?Usage: nexus.sh heartbeat <SESSION_ID> [--agent-id ID] [--interval N]}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble

    if [[ -z "$AGENT_ID" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
      if [[ -f "$AGENT_FILE" ]]; then
        AGENT_ID=$(cat "$AGENT_FILE")
      else
        echo '{"error":"missing --agent-id and no persisted agent-id found"}' && exit 1
      fi
    fi

    INTERVAL_VAL="${INTERVAL:-60}"

    echo "Starting heartbeat polling..." >&2
    echo "Session: $SESSION_ID" >&2
    echo "Interval: ${INTERVAL_VAL}s" >&2
    echo "Press Ctrl+C to stop" >&2

    trap 'echo "" >&2; echo "Heartbeat stopped." >&2; exit 0' SIGINT SIGTERM

    while true; do
      echo "$(date '+%Y-%m-%d %H:%M:%S') - Polling..." >&2
      RESPONSE=$("$0" poll "$SESSION_ID" 2>/dev/null || echo "{}")
      MESSAGE_COUNT=$(echo "$RESPONSE" | jq -r '.messages | length // 0')

      if [[ "$MESSAGE_COUNT" -gt 0 ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - $MESSAGE_COUNT new message(s)" >&2
      fi

      sleep "$INTERVAL_VAL"
    done
    ;;

  renew)
    SESSION_ID="${1:?Usage: nexus.sh renew <SESSION_ID> [--ttl N] [--agent-id ID]}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble

    if [[ -z "$AGENT_ID" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
      if [[ -f "$AGENT_FILE" ]]; then
        AGENT_ID=$(cat "$AGENT_FILE")
      else
        echo '{"error":"missing --agent-id and no persisted agent-id found"}' && exit 1
      fi
    fi

    BODY=""
    if [[ -n "${TTL:-}" ]]; then
      BODY=$(echo "{}" | jq -c --argjson ttl "$TTL" '. + {ttl: $ttl}')
    fi

    if [[ -n "$BODY" ]]; then
      http_request -X POST "$NEXUS_URL/v1/sessions/$SESSION_ID/renew" \
        -H "X-Agent-Id: $AGENT_ID" \
        -H "Content-Type: application/json" \
        -d "$BODY"
    else
      http_request -X POST "$NEXUS_URL/v1/sessions/$SESSION_ID/renew" \
        -H "X-Agent-Id: $AGENT_ID" \
        -H "Content-Type: application/json" \
        -d "{}"
    fi
    emit_response
    adopt_binding_if_unbound "$SESSION_ID"

    EXPIRES_AT=$(echo "$RESPONSE" | jq -r '.expiresAt // empty')
    if [[ -n "$EXPIRES_AT" ]]; then
      echo "" >&2
      echo "✅ Session renewed — expires at: $EXPIRES_AT" >&2
    fi
    ;;

  leave)
    SESSION_ID="${1:?Usage: nexus.sh leave <SESSION_ID> [--agent-id ID]}"
    LEAVE_ALIAS=""
    # Check if input is an alias before resolving
    if [[ -f "$NEXUS_ALIASES_FILE" ]]; then
      LEAVE_ALIAS=$(jq -r --arg name "$1" 'if has($name) then $name else empty end' "$NEXUS_ALIASES_FILE" 2>/dev/null || true)
    fi
    SESSION_ID=$(resolve_session "$SESSION_ID")
    route_session_server "$SESSION_ID"
    net_preamble

    if [[ -z "$AGENT_ID" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      AGENT_FILE="$NEXUS_DATA_DIR/$SESSION_ID/agent"
      if [[ -f "$AGENT_FILE" ]]; then
        AGENT_ID=$(cat "$AGENT_FILE")
      else
        echo '{"error":"missing --agent-id and no persisted agent-id found"}' && exit 1
      fi
    fi

    KEY_FILE="$NEXUS_DATA_DIR/$SESSION_ID/key"
    if [[ ! -f "$KEY_FILE" ]]; then
      echo '{"error":"no session key found"}' && exit 1
    fi

    http_request -X DELETE "$NEXUS_URL/v1/sessions/$SESSION_ID/agents/$AGENT_ID" \
      -H "X-Agent-Id: $AGENT_ID" \
      -H "X-Session-Key: $(cat "$KEY_FILE")"

    # Parse response — handle potentially non-JSON bodies from proxies
    OK="false"
    ERROR=""
    if echo "$RESPONSE" | jq -e . >/dev/null 2>&1; then
      echo "$RESPONSE"
      OK=$(echo "$RESPONSE" | jq -r '.ok // false')
      ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
    else
      echo '{"error":"non_json_response"}'
      ERROR="non_json_response"
    fi

    # Decision table: cleanup local state based on error class
    # 2xx ok — remove local state, exit 0
    if [[ "$HTTP_OK" == "true" && "$OK" == "true" ]]; then
      cleanup_leave_state "$SESSION_ID" "$LEAVE_ALIAS"
      echo "" >&2
      echo "✅ Left session. Local data cleaned up." >&2
      exit 0
    fi

    # 404 session_not_found / agent_not_found — session gone or agent no longer
    # a member; idempotent cleanup either way
    if [[ "$ERROR" == "session_not_found" || "$ERROR" == "agent_not_found" ]]; then
      cleanup_leave_state "$SESSION_ID" "$LEAVE_ALIAS"
      echo "" >&2
      echo "⚠️  $ERROR on server — local data cleaned up." >&2
      exit 0
    fi

    # 401 invalid_session_key — cross-check with unauthenticated GET.
    # GET /v1/sessions/:id is public (no auth), returns agents[] membership.
    # Decision is on HTTP status code, NOT on a response body field — the server
    # does NOT include `ok` in the GET session response shape.
    if [[ "$ERROR" == "invalid_session_key" ]]; then
      get_resp=$(curl -s -w $'\n%{http_code}' --max-time "${NEXUS_HTTP_TIMEOUT:-10}" \
        "$NEXUS_URL/v1/sessions/$SESSION_ID" 2>/dev/null) || get_resp=""
      get_code="${get_resp##*$'\n'}"; get_body="${get_resp%$'\n'*}"
      [[ "$get_code" =~ ^[0-9]+$ ]] || get_code="000"

      if [[ "$get_code" == "404" ]]; then
        # Session does not exist → idempotent cleanup
        cleanup_leave_state "$SESSION_ID" "$LEAVE_ALIAS"
        echo "" >&2
        echo "⚠️  Session expired on server — local data cleaned up." >&2
        exit 0
      fi
      if [[ "$get_code" != "200" ]]; then
        # Transient / transport error → preserve, retry later
        echo "" >&2
        echo "⚠️  Cannot verify session state (HTTP $get_code) — local state preserved for retry." >&2
        exit 1
      fi
      # Session exists — check if agent is still a member
      if echo "$get_body" | jq -e --arg a "$AGENT_ID" '.agents | index($a)' >/dev/null 2>&1; then
        # Agent IS a member but key is wrong → real problem, preserve for retry
        echo "" >&2
        echo "⚠️  Invalid session key but agent is still a member — local state preserved for retry." >&2
        exit 1
      else
        # Agent is NOT a member (evicted or already left) → idempotent cleanup
        cleanup_leave_state "$SESSION_ID" "$LEAVE_ALIAS"
        echo "" >&2
        echo "⚠️  Agent no longer a member of session — local data cleaned up." >&2
        exit 0
      fi
    fi

    # 403 forbidden — creator cannot leave, session is alive
    if [[ "$ERROR" == "forbidden" ]]; then
      echo "" >&2
      echo "⚠️  Creator cannot leave the session — local state preserved." >&2
      exit 1
    fi

    # Transport failure, 429, 5xx, or unknown error — preserve for retry
    echo "" >&2
    echo "⚠️  Server leave failed (${ERROR:-transport error}) — local state preserved for retry." >&2
    exit 1
    ;;

  poll-status)
    # poll-status is inherently human-readable, not JSON
    echo "Active polling processes:" >&2
    PGREP_OUTPUT=$(pgrep -f "nexus.sh.*poll" || true)
    if [[ -z "$PGREP_OUTPUT" ]]; then
      echo "No active polling processes found." >&2
    else
      echo "$PGREP_OUTPUT" >&2
      echo "" >&2
      echo "Last poll time:" >&2
      if [[ -d "$NEXUS_DATA_DIR" ]]; then
        for session_dir in "$NEXUS_DATA_DIR"/*/; do
          cursor_file="$session_dir/cursor"
          if [[ -f "$cursor_file" ]]; then
            SESSION_ID=$(basename "$session_dir")
            LAST_POLL=$(stat -c %y "$cursor_file" 2>/dev/null || stat -f %Sm "$cursor_file" 2>/dev/null || echo "unknown")
            echo "  $SESSION_ID: $LAST_POLL" >&2
          fi
        done
      fi
    fi
    ;;

  config)
    SUB="${1:-show}"
    case "$SUB" in
      set-url)
        CFG_URL="${2:?Usage: nexus.sh config set-url <URL>}"
        if [[ ! "$CFG_URL" =~ ^https?://[^/]+ ]]; then
          echo '{"error":"invalid URL — must be http(s)://host"}'
          exit 1
        fi
        CFG_NORM=$(normalize_url "$CFG_URL")
        mkdir -p "$(dirname "$NEXUS_CONFIG_FILE")"
        jq -n --arg u "$CFG_NORM" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{serverUrl: $u, updatedAt: $t}' > "$NEXUS_CONFIG_FILE"
        jq -n --arg u "$CFG_NORM" '{ok: true, serverUrl: $u}'
        echo "✅ Server configured: $CFG_NORM" >&2
        ;;
      show)
        jq -n --arg u "$NEXUS_URL" --arg s "$SERVER_SOURCE" --arg p "$NEXUS_CONFIG_FILE" \
          '{serverUrl: $u, source: $s, configPath: $p}'
        ;;
      unset)
        if [[ -f "$NEXUS_CONFIG_FILE" ]]; then
          TMP=$(jq -c 'del(.serverUrl)' "$NEXUS_CONFIG_FILE" 2>/dev/null || echo '{}')
          echo "$TMP" > "$NEXUS_CONFIG_FILE"
        fi
        echo '{"ok":true}'
        echo "✅ Server config unset" >&2
        ;;
      *)
        jq -n --arg s "$SUB" '{error: ("unknown config subcommand: " + $s + " (use set-url|show|unset)")}'
        exit 1
        ;;
    esac
    ;;

  bind)
    SESSION_ID="${1:?Usage: nexus.sh bind <SESSION_ID>}"
    SESSION_ID=$(resolve_session "$SESSION_ID")
    net_preamble
    # Adopt the session only if the EFFECTIVE server actually knows it (200).
    BIND_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${NEXUS_HTTP_TIMEOUT:-10}" \
      "$NEXUS_URL/v1/sessions/$SESSION_ID" 2>/dev/null) || BIND_CODE="000"
    if [[ "$BIND_CODE" == "200" ]]; then
      mkdir -p "$NEXUS_DATA_DIR/$SESSION_ID"
      echo "$NEXUS_URL" > "$NEXUS_DATA_DIR/$SESSION_ID/server"
      jq -n --arg sid "$SESSION_ID" --arg srv "$NEXUS_URL" '{ok: true, sessionId: $sid, server: $srv}'
      echo "✅ Bound ${SESSION_ID:0:12}… → $NEXUS_URL" >&2
    else
      jq -n --arg srv "$NEXUS_URL" --arg code "$BIND_CODE" --arg sid "$SESSION_ID" \
        '{error: ("session not found on " + $srv + " (HTTP " + $code + ")"), sessionId: $sid}'
      exit 1
    fi
    ;;

  doctor)
    net_preamble
    EFFECTIVE="$NEXUS_URL"
    OVERALL_OK=true
    DIVERGENCE=false
    HTIMEOUT="${NEXUS_HTTP_TIMEOUT:-10}"
    STIMEOUT="${NEXUS_STATUS_TIMEOUT:-3}"

    # Distinct servers = effective + every bound server in local state.
    # ponytail: newline list + sort -u instead of an assoc array — bash 3.2 safe.
    SERVERS_LIST="$EFFECTIVE"
    if [[ -d "$NEXUS_DATA_DIR" ]]; then
      for d in "$NEXUS_DATA_DIR"/*/; do
        [[ -f "$d/server" ]] || continue
        SERVERS_LIST="$SERVERS_LIST"$'\n'"$(normalize_url "$(cat "$d/server")")"
      done
    fi

    HEALTH_JSON="[]"
    while IFS= read -r s; do
      [[ -n "$s" ]] || continue
      H=$(curl -s --max-time "$HTIMEOUT" "$s/health" 2>/dev/null || true)
      if [[ -n "$H" ]] && echo "$H" | jq -e . >/dev/null 2>&1; then
        VER=$(echo "$H" | jq -r '.version // "unknown"')
        UP=$(echo "$H" | jq -r '.uptime // empty')
        REACH=true
      else
        VER="unknown"; UP=""; REACH=false; OVERALL_OK=false
      fi
      [[ "$UP" =~ ^[0-9]+$ ]] && UP_JSON="$UP" || UP_JSON=null
      HEALTH_JSON=$(echo "$HEALTH_JSON" | jq -c \
        --arg s "$s" --argjson reach "$REACH" --arg ver "$VER" --argjson up "$UP_JSON" \
        '. + [{server: $s, reachable: $reach, version: $ver, uptime: $up}]')
    done <<< "$(printf '%s\n' "$SERVERS_LIST" | sort -u)"

    SESS_JSON="[]"
    if [[ -d "$NEXUS_DATA_DIR" ]]; then
      for d in "$NEXUS_DATA_DIR"/*/; do
        [[ -d "$d" ]] || continue
        DSID=$(basename "$d")
        BOUND=""; [[ -f "$d/server" ]] && BOUND=$(normalize_url "$(cat "$d/server")")
        PROBE="${BOUND:-$EFFECTIVE}"
        DAGENT=""; [[ -f "$d/agent" ]] && DAGENT=$(cat "$d/agent")

        # Divergence is SURFACED (visibility), not a failure: per-session binding
        # across servers is the supported, self-healing model — the binding is
        # routing correctly, so it must not make a healthy setup exit non-zero.
        [[ -n "$BOUND" && "$BOUND" != "$EFFECTIVE" ]] && DIVERGENCE=true

        # Single probe: capture body + status code in one request (was two — the
        # duplicate GET doubled rate-limit pressure on many-session setups).
        PRESP=$(curl -s -w $'\n%{http_code}' --max-time "$STIMEOUT" "$PROBE/v1/sessions/$DSID" 2>/dev/null || true)
        PCODE="${PRESP##*$'\n'}"; PBODY="${PRESP%$'\n'*}"
        [[ "$PCODE" =~ ^[0-9]+$ ]] || PCODE="000"
        MEMBER=null
        if [[ "$PCODE" == "200" ]]; then
          if echo "$PBODY" | jq -e --arg a "$DAGENT" '.agents | index($a)' >/dev/null 2>&1; then
            MEMBER=true
          else
            MEMBER=false; OVERALL_OK=false
          fi
        else
          OVERALL_OK=false
        fi

        # The key file is written only by create/join/claim; poll-only and
        # TOFU-adopted sessions legitimately have none. Absent → not a failure;
        # present but group/other-readable → a real security problem.
        KEY_STATE="absent"
        if [[ -f "$d/key" ]]; then
          KPERM=$(stat -c '%a' "$d/key" 2>/dev/null || stat -f '%Lp' "$d/key" 2>/dev/null || echo "")
          if [[ "$KPERM" == "600" || "$KPERM" == "400" ]]; then KEY_STATE="ok"; else KEY_STATE="insecure"; OVERALL_OK=false; fi
        fi

        CODE_JSON=$((10#$PCODE))
        SESS_JSON=$(echo "$SESS_JSON" | jq -c \
          --arg sid "$DSID" --arg bound "$BOUND" --arg probe "$PROBE" \
          --argjson code "$CODE_JSON" --argjson member "$MEMBER" --arg keyfile "$KEY_STATE" \
          '. + [{sessionId: $sid, bound: ($bound | if . == "" then null else . end), probed: $probe, httpCode: $code, memberOfSession: $member, keyFile: $keyfile}]')
      done
    fi

    jq -n \
      --arg eff "$EFFECTIVE" --arg src "$SERVER_SOURCE" \
      --argjson diverge "$DIVERGENCE" --argjson ok "$OVERALL_OK" \
      --argjson health "$HEALTH_JSON" --argjson sessions "$SESS_JSON" \
      '{effectiveServer: $eff, source: $src, divergence: $diverge, ok: $ok, health: $health, sessions: $sessions}'

    [[ "$DIVERGENCE" == "true" ]] && \
      echo "ℹ️  note: some sessions are bound to a server other than $EFFECTIVE (the binding routes them there correctly)" >&2
    if [[ "$OVERALL_OK" == "true" ]]; then
      echo "✅ doctor: all checks passed" >&2
      exit 0
    else
      echo "⚠️  doctor: problems found (see JSON report)" >&2
      exit 1
    fi
    ;;

  help)
    TOPIC="${1:-}"
    case "$TOPIC" in
      alias|aliases)
        cat >&2 <<EOF
Session Aliases — manage multiple sessions with short names

Commands:
  alias <SESSION_ID> <NAME>       Assign a short name to a session
  unalias <NAME>                  Remove an alias (keeps session active)
  ls [--active] [--json]          List all local sessions with aliases and status
  poll-all [--active] [--members] Poll all active sessions at once

Usage:
  nexus.sh alias 4670cde8a96a... chatbot
  nexus.sh send chatbot "Hey!"
  nexus.sh poll chatbot
  nexus.sh ls
  nexus.sh poll-all --active
  nexus.sh leave chatbot              # auto-removes alias

Aliases resolve client-side. Any command that accepts a SESSION_ID also accepts an alias.
Storage: ~/.config/messaging/aliases.json
EOF
        ;;
      *)
        cat >&2 <<EOF
NexusMessaging CLI

Usage: nexus.sh <command> [args] [options]

stdout: JSON only (pipeable to jq)
stderr: human-readable tips and status messages

Commands:
  create [--ttl N] [--max-agents N]        Create session (default TTL: 3660s, maxAgents: 50)
  status <SESSION>                        Get session status
  join <SESSION> --agent-id ID            Join a session (saves agent-id + session key)
  leave <SESSION> [--agent-id ID]         Leave a session (cleans local config + alias)
  pair <SESSION>                          Generate pairing code
  claim <CODE> --agent-id ID             Claim pairing code (saves agent-id + session key)
  pair-status <CODE>                      Check pairing code state
  send <SESSION> "text" [--json PAYLOAD] [--strict] [--agent-id]
                        Send message (text and/or structured json; at least one required)
  poll <SESSION> [--after] [--members]    Poll messages (cursor auto-managed)
  renew <SESSION> [--ttl N]              Renew session TTL
  poll-daemon <SESSION> [--interval N]    Poll with TTL tracking
  heartbeat <SESSION> [--interval N]      Continuous polling loop
  poll-status                              Show active polling processes
  config set-url <URL>|show|unset          Persist / inspect the server URL
  bind <SESSION>                          Bind a session to the current server (verifies first)
  doctor                                  Diagnose server identity + per-session health

Options:
  --url URL           Server URL. Resolution: --url > \$NEXUS_URL > config > https://messaging.md
  --agent-id ID       Agent identifier (optional after join/claim)
  --ttl N             Session TTL in seconds
  --max-agents N      Maximum agents per session (default: 50)
  --creator-agent-id  Auto-join as creator (immune to inactivity)
  --after CURSOR      Poll after this cursor (default: auto)
  --members           Include member list in poll response
  --json PAYLOAD      Send a structured JSON payload (send only; at least text or --json required)
  --strict            Fail if server lacks native json support (send only)
  --interval N        Polling interval in seconds

Tip: Use aliases to manage multiple sessions with short names.
  nexus.sh help alias             Show alias commands and usage

Session data: ~/.config/messaging/sessions/<SESSION_ID>/
EOF
        ;;
    esac
    ;;

  *)
    echo "{\"error\":\"unknown command: $CMD\"}" && exit 1
    ;;
esac
