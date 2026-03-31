#!/bin/bash
# Sync Claude Code credentials from macOS keychain to file
# Docker containers can't access keychain, so we export to .credentials.json

set -e

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.config/claude}"
CREDS_FILE="$CLAUDE_DIR/.credentials.json"

if ! command -v security &>/dev/null; then
  echo "Error: macOS 'security' command not found. This script is for macOS only."
  exit 1
fi

echo "Syncing Claude Code credentials from keychain..."
if security find-generic-password -s "Claude Code-credentials" -w > "$CREDS_FILE" 2>/dev/null; then
  EXPIRY=$(node -e "const j=JSON.parse(require('fs').readFileSync('$CREDS_FILE','utf8'));console.log(new Date(j.claudeAiOauth.expiresAt).toISOString())" 2>/dev/null)
  echo "Credentials synced. Token expires: $EXPIRY"
else
  echo "Error: Could not read credentials from keychain."
  echo "Run 'claude auth login' first."
  exit 1
fi
