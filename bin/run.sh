#!/bin/sh
# Preflight for every journeymap hook: needs Node 20+, and must never break the Claude session.
if ! command -v node >/dev/null 2>&1; then
  echo "journeymap: the journey map needs Node.js 20 or newer. Install it from https://nodejs.org and restart Claude Code." >&2
  exit 0
fi
major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$major" -lt 20 ] 2>/dev/null; then
  echo "journeymap: the journey map needs Node.js 20 or newer (found $(node -v)). Update it from https://nodejs.org." >&2
  exit 0
fi
exec node "$(dirname "$0")/journeys.mjs" "$@"
