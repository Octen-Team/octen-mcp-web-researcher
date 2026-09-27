#!/usr/bin/env bash
# Register Octen's MCP server with Claude Code (local stdio server via npx).
# Usage: OCTEN_API_KEY=... ./configs/claude-code.sh
set -euo pipefail
: "${OCTEN_API_KEY:?Set OCTEN_API_KEY first}"
claude mcp add --scope user octen -e OCTEN_API_KEY="$OCTEN_API_KEY" -- npx -y octen-mcp
claude mcp list
