#!/usr/bin/env bash
set -euo pipefail

# Report NexusMessaging sessions: status, aliases, health.
# Output: JSON to stdout, formatted table to stderr.
#
# Usage: session-report.sh [--nexus-sh PATH] [--url URL]

NEXUS_URL="${NEXUS_URL:-https://messaging.md}"
NEXUS_SH=""
HEALTH_FILE="/tmp/nexus-messaging-health.json"

while [[ $# -gt 0 ]]; do
  case $1 in
    --nexus-sh) NEXUS_SH="$2"; shift 2 ;;
    --url) NEXUS_URL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Find nexus.sh
if [[ -z "$NEXUS_SH" ]]; then
  NEXUS_SH=$(which nexus.sh 2>/dev/null || true)
  for p in /opt/clawhub/skills/messaging/scripts/nexus.sh \
           "$HOME/clawd/skills/messaging/scripts/nexus.sh" \
           /opt/skills/messaging/scripts/nexus.sh; do
    [[ -z "$NEXUS_SH" && -f "$p" ]] && NEXUS_SH="$p"
  done
fi

if [[ -z "$NEXUS_SH" || ! -f "$NEXUS_SH" ]]; then
  echo '{"error":"nexus.sh not found"}' && exit 1
fi

# --- Plugin health ---
PLUGIN_STATE="unknown"
if [[ -f "$HEALTH_FILE" ]]; then
  PLUGIN_STATE=$(jq -r '.state // "unknown"' "$HEALTH_FILE" 2>/dev/null)
fi

# --- Sessions from nexus.sh ls ---
LS_JSON=$("$NEXUS_SH" ls --json --url "$NEXUS_URL" 2>/dev/null || echo '{"sessions":[]}')
SESSION_COUNT=$(echo "$LS_JSON" | jq '.sessions | length')

RESULTS="[]"
ACTIVE=0
EXPIRED=0

for i in $(seq 0 $((SESSION_COUNT - 1))); do
  SID=$(echo "$LS_JSON" | jq -r ".sessions[$i].sessionId")
  ALIAS=$(echo "$LS_JSON" | jq -r ".sessions[$i].alias // \"—\"")
  AGENT=$(echo "$LS_JSON" | jq -r ".sessions[$i].agentId // \"—\"")
  STATUS=$(echo "$LS_JSON" | jq -r ".sessions[$i].status // \"unknown\"")
  CURSOR=$(echo "$LS_JSON" | jq -r ".sessions[$i].cursor // \"—\"")

  TTL_LEFT="—"
  MEMBERS="[]"

  if [[ "$STATUS" == "active" ]]; then
    ACTIVE=$((ACTIVE + 1))
    # Get detailed status from server
    STATUS_RESP=$("$NEXUS_SH" status "$SID" --url "$NEXUS_URL" 2>/dev/null || echo '{}')
    EXPIRES_AT=$(echo "$STATUS_RESP" | jq -r '.expiresAt // empty')
    if [[ -n "$EXPIRES_AT" ]]; then
      EXPIRES_EPOCH=$(date -d "$EXPIRES_AT" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$EXPIRES_AT" +%s 2>/dev/null || echo 0)
      NOW_EPOCH=$(date +%s)
      REMAINING=$((EXPIRES_EPOCH - NOW_EPOCH))
      if [[ $REMAINING -gt 3600 ]]; then
        TTL_LEFT="$((REMAINING / 3600))h $((REMAINING % 3600 / 60))m"
      elif [[ $REMAINING -gt 60 ]]; then
        TTL_LEFT="$((REMAINING / 60))m"
      elif [[ $REMAINING -gt 0 ]]; then
        TTL_LEFT="${REMAINING}s"
      else
        TTL_LEFT="expiring"
      fi
    fi

    # Get members
    POLL_RESP=$("$NEXUS_SH" poll "$SID" --after 999999999 --members --url "$NEXUS_URL" 2>/dev/null || echo '{}')
    MEMBERS=$(echo "$POLL_RESP" | jq -c '.members // []')
  else
    EXPIRED=$((EXPIRED + 1))
  fi

  # Health from plugin file
  POLL_STATE="—"
  ERRORS=0
  LAST_POLL="—"
  if [[ -f "$HEALTH_FILE" ]]; then
    POLL_STATE=$(jq -r --arg sid "$SID" '.sessions[$sid].state // "—"' "$HEALTH_FILE" 2>/dev/null)
    ERRORS=$(jq -r --arg sid "$SID" '.sessions[$sid].consecutiveErrors // 0' "$HEALTH_FILE" 2>/dev/null)
    LAST_POLL=$(jq -r --arg sid "$SID" '.sessions[$sid].lastPollAt // "—"' "$HEALTH_FILE" 2>/dev/null)
  fi

  ENTRY=$(jq -nc \
    --arg sid "$SID" \
    --arg alias "$ALIAS" \
    --arg agent "$AGENT" \
    --arg status "$STATUS" \
    --arg cursor "$CURSOR" \
    --arg ttl "$TTL_LEFT" \
    --arg pollState "$POLL_STATE" \
    --argjson errors "$ERRORS" \
    --arg lastPoll "$LAST_POLL" \
    --argjson members "$MEMBERS" \
    '{sessionId: $sid, alias: $alias, agentId: $agent, status: $status, cursor: $cursor, ttlLeft: $ttl, pollState: $pollState, consecutiveErrors: $errors, lastPollAt: $lastPoll, members: $members}')

  RESULTS=$(echo "$RESULTS" | jq -c --argjson entry "$ENTRY" '. + [$entry]')
done

# --- Output JSON ---
jq -nc \
  --arg pluginState "$PLUGIN_STATE" \
  --argjson active "$ACTIVE" \
  --argjson expired "$EXPIRED" \
  --argjson sessions "$RESULTS" \
  '{pluginState: $pluginState, activeSessions: $active, expiredSessions: $expired, sessions: $sessions}'

# --- Human-readable table ---
echo "" >&2
echo "🔌 Plugin: $PLUGIN_STATE" >&2
echo "📡 Sessions: $ACTIVE active, $EXPIRED expired" >&2
echo "" >&2

if [[ "$SESSION_COUNT" -gt 0 ]]; then
  printf "%-10s %-14s %-12s %-8s %-10s %-8s %s\n" "ALIAS" "SESSION" "AGENT" "STATUS" "TTL" "ERRORS" "POLL STATE" >&2
  echo "$RESULTS" | jq -r '.[] | [.alias, (.sessionId[:12] + "..."), .agentId, .status, .ttlLeft, (.consecutiveErrors | tostring), .pollState] | @tsv' | \
    while IFS=$'\t' read -r a s ag st ttl err ps; do
      printf "%-10s %-14s %-12s %-8s %-10s %-8s %s\n" "$a" "$s" "$ag" "$st" "$ttl" "$err" "$ps" >&2
    done
fi
