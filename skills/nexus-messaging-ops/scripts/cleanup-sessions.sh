#!/usr/bin/env bash
set -euo pipefail

# Cleanup expired NexusMessaging sessions and orphan references.
#
# Usage: cleanup-sessions.sh [--dry-run] [--force] [--max-age HOURS] [--nexus-sh PATH] [--url URL]
#
# Default: dry-run mode (show what would be cleaned, don't act).

NEXUS_URL="${NEXUS_URL:-https://messaging.md}"
NEXUS_SH=""
NEXUS_DATA_DIR="${HOME}/.config/messaging/sessions"
NEXUS_ALIASES_FILE="${HOME}/.config/messaging/aliases.json"
DRY_RUN="true"
FORCE="false"
MAX_AGE_HOURS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN="true"; shift ;;
    --force) FORCE="true"; DRY_RUN="false"; shift ;;
    --max-age) MAX_AGE_HOURS="$2"; shift 2 ;;
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

EXPIRED_SESSIONS=()
ORPHAN_ALIASES=()
CLEANED_DIRS=0
CLEANED_ALIASES=0

# --- Scan session directories ---
if [[ -d "$NEXUS_DATA_DIR" ]]; then
  for session_dir in "$NEXUS_DATA_DIR"/*/; do
    [[ -d "$session_dir" ]] || continue
    SID=$(basename "$session_dir")

    # Check if session exists on server
    STATUS_RESP=$("$NEXUS_SH" status "$SID" --url "$NEXUS_URL" 2>/dev/null || echo '{"error":"check_failed"}')
    IS_ERROR=$(echo "$STATUS_RESP" | jq -r '.error // empty')

    if [[ -n "$IS_ERROR" ]]; then
      # Session doesn't exist on server — candidate for cleanup
      # Check max-age filter (based on local dir modification time)
      if [[ -n "$MAX_AGE_HOURS" ]]; then
        DIR_AGE_HOURS=$(( ($(date +%s) - $(stat -c %Y "$session_dir" 2>/dev/null || stat -f %m "$session_dir" 2>/dev/null || echo 0)) / 3600 ))
        if [[ $DIR_AGE_HOURS -lt $MAX_AGE_HOURS ]]; then
          continue  # too recent, skip
        fi
      fi

      # Find alias if any
      ALIAS=""
      if [[ -f "$NEXUS_ALIASES_FILE" ]]; then
        ALIAS=$(jq -r --arg sid "$SID" 'to_entries[] | select(.value == $sid) | .key' "$NEXUS_ALIASES_FILE" 2>/dev/null | head -1)
      fi

      EXPIRED_SESSIONS+=("$SID|${ALIAS:-—}")
    fi
  done
fi

# --- Scan orphan aliases ---
if [[ -f "$NEXUS_ALIASES_FILE" ]]; then
  while IFS= read -r line; do
    ALIAS_NAME=$(echo "$line" | jq -r '.key')
    ALIAS_SID=$(echo "$line" | jq -r '.value')

    # Check if session dir exists locally
    if [[ ! -d "$NEXUS_DATA_DIR/$ALIAS_SID" ]]; then
      ORPHAN_ALIASES+=("$ALIAS_NAME|$ALIAS_SID")
    fi
  done < <(jq -c 'to_entries[]' "$NEXUS_ALIASES_FILE" 2>/dev/null)
fi

# --- Report ---
echo "" >&2
if [[ "$DRY_RUN" == "true" ]]; then
  echo "🔍 DRY RUN — no changes will be made" >&2
fi
echo "" >&2

TOTAL_EXPIRED=${#EXPIRED_SESSIONS[@]}
TOTAL_ORPHANS=${#ORPHAN_ALIASES[@]}

if [[ $TOTAL_EXPIRED -eq 0 && $TOTAL_ORPHANS -eq 0 ]]; then
  echo "✅ Nothing to clean up — all sessions active, no orphan aliases." >&2
  echo '{"cleanedDirs":0,"cleanedAliases":0,"dryRun":'"$DRY_RUN"'}' 
  exit 0
fi

if [[ $TOTAL_EXPIRED -gt 0 ]]; then
  echo "📦 Expired sessions ($TOTAL_EXPIRED):" >&2
  for entry in "${EXPIRED_SESSIONS[@]}"; do
    IFS='|' read -r sid alias <<< "$entry"
    echo "  - ${sid:0:12}... (alias: $alias)" >&2
  done
  echo "" >&2
fi

if [[ $TOTAL_ORPHANS -gt 0 ]]; then
  echo "🏷️  Orphan aliases ($TOTAL_ORPHANS):" >&2
  for entry in "${ORPHAN_ALIASES[@]}"; do
    IFS='|' read -r name sid <<< "$entry"
    echo "  - $name → ${sid:0:12}..." >&2
  done
  echo "" >&2
fi

# --- Execute cleanup ---
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Run with --force to execute cleanup." >&2
  echo "{\"expiredSessions\":$TOTAL_EXPIRED,\"orphanAliases\":$TOTAL_ORPHANS,\"cleanedDirs\":0,\"cleanedAliases\":0,\"dryRun\":true}"
  exit 0
fi

# Clean expired session dirs
for entry in "${EXPIRED_SESSIONS[@]}"; do
  IFS='|' read -r sid alias <<< "$entry"
  rm -rf "$NEXUS_DATA_DIR/$sid"
  CLEANED_DIRS=$((CLEANED_DIRS + 1))

  # Remove alias if exists
  if [[ "$alias" != "—" && -f "$NEXUS_ALIASES_FILE" ]]; then
    TMP=$(jq -c --arg name "$alias" 'del(.[$name])' "$NEXUS_ALIASES_FILE" 2>/dev/null)
    [[ -n "$TMP" ]] && echo "$TMP" > "$NEXUS_ALIASES_FILE"
    CLEANED_ALIASES=$((CLEANED_ALIASES + 1))
  fi

  echo "  ✅ Removed session ${sid:0:12}... (alias: $alias)" >&2
done

# Clean orphan aliases
for entry in "${ORPHAN_ALIASES[@]}"; do
  IFS='|' read -r name sid <<< "$entry"
  TMP=$(jq -c --arg name "$name" 'del(.[$name])' "$NEXUS_ALIASES_FILE" 2>/dev/null)
  [[ -n "$TMP" ]] && echo "$TMP" > "$NEXUS_ALIASES_FILE"
  CLEANED_ALIASES=$((CLEANED_ALIASES + 1))
  echo "  ✅ Removed orphan alias: $name" >&2
done

echo "" >&2
echo "🧹 Cleanup complete: $CLEANED_DIRS dirs, $CLEANED_ALIASES aliases removed." >&2

echo "{\"cleanedDirs\":$CLEANED_DIRS,\"cleanedAliases\":$CLEANED_ALIASES,\"dryRun\":false}"
