#!/bin/sh
# Ensure persistent data files exist before the app starts.
# Docker bind-mounts a directory instead of a file when the host path is missing.
[ -f /app/.tokens.json ] || echo '{}' > /app/.tokens.json
[ -f /app/.sync-state.json ] || echo '{}' > /app/.sync-state.json
exec node src/app.js
