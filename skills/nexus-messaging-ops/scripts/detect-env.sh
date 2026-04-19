#!/usr/bin/env bash
set -euo pipefail

# Detect NexusMessaging environment: Docker vs host, prerequisites, install state.
# Output: JSON to stdout, human hints to stderr.

NEXUS_URL="${NEXUS_URL:-https://messaging.md}"

# --- Detect environment ---
ENVIRONMENT="host"
if docker ps --filter name=openclaw-gateway --format "{{.Names}}" 2>/dev/null | grep -q openclaw; then
  ENVIRONMENT="docker"
elif [[ -f /.dockerenv ]] || grep -q docker /proc/1/cgroup 2>/dev/null; then
  ENVIRONMENT="container"  # we're inside a container
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
esac

# --- Check prerequisites ---
CURL_OK="false"
command -v curl &>/dev/null && CURL_OK="true"

JQ_OK="false"
command -v jq &>/dev/null && JQ_OK="true"

# --- Find messaging skill ---
MESSAGING_SKILL_PATH=""
SEARCH_PATHS=(
  "/opt/clawhub/skills/messaging/scripts/nexus.sh"
  "$HOME/clawd/skills/messaging/scripts/nexus.sh"
  "$HOME/.config/messaging/scripts/nexus.sh"
  "/opt/skills/messaging/scripts/nexus.sh"
  "/usr/local/bin/nexus.sh"
)

for p in "${SEARCH_PATHS[@]}"; do
  if [[ -f "$p" ]]; then
    MESSAGING_SKILL_PATH="$p"
    break
  fi
done

# Try which as fallback
if [[ -z "$MESSAGING_SKILL_PATH" ]]; then
  MESSAGING_SKILL_PATH=$(which nexus.sh 2>/dev/null || true)
fi

# --- Check plugin installed ---
PLUGIN_INSTALLED="false"
OPENCLAW_CONFIG_PATH=""

# Find openclaw.json
CONFIG_CANDIDATES=(
  "$HOME/.openclaw/openclaw.json"
  "/home/node/.openclaw/openclaw.json"
)

for c in "${CONFIG_CANDIDATES[@]}"; do
  if [[ -f "$c" ]]; then
    OPENCLAW_CONFIG_PATH="$c"
    break
  fi
done

if [[ -n "$OPENCLAW_CONFIG_PATH" && "$JQ_OK" == "true" ]]; then
  PLUGIN_ENTRY=$(jq -r '.plugins.entries["nexus-messaging"].enabled // false' "$OPENCLAW_CONFIG_PATH" 2>/dev/null || echo "false")
  if [[ "$PLUGIN_ENTRY" == "true" ]]; then
    PLUGIN_INSTALLED="true"
  fi
fi

# --- Check gateway health ---
GATEWAY_REACHABLE="false"
if [[ "$CURL_OK" == "true" ]]; then
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "$NEXUS_URL/health" 2>/dev/null || echo "000")
  [[ "$HTTP_CODE" == "200" ]] && GATEWAY_REACHABLE="true"
fi

# --- Output ---
cat <<EOF
{
  "environment": "$ENVIRONMENT",
  "arch": "$ARCH",
  "curlOk": $CURL_OK,
  "jqOk": $JQ_OK,
  "messagingSkillPath": "$MESSAGING_SKILL_PATH",
  "pluginInstalled": $PLUGIN_INSTALLED,
  "openclawConfigPath": "$OPENCLAW_CONFIG_PATH",
  "gatewayReachable": $GATEWAY_REACHABLE,
  "serverUrl": "$NEXUS_URL"
}
EOF

# Human-readable summary
echo "" >&2
echo "Environment: $ENVIRONMENT ($ARCH)" >&2
echo "curl: $CURL_OK | jq: $JQ_OK" >&2
echo "nexus.sh: ${MESSAGING_SKILL_PATH:-not found}" >&2
echo "Plugin installed: $PLUGIN_INSTALLED" >&2
echo "Gateway ($NEXUS_URL): $GATEWAY_REACHABLE" >&2
