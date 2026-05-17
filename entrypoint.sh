#!/bin/sh
# Ensure persistent data files exist before the app starts.
DATA_PATH=${DATA_DIR:-/app}
[ -f "$DATA_PATH/.tokens.json" ] || echo '{}' > "$DATA_PATH/.tokens.json"
[ -f "$DATA_PATH/.sync-state.json" ] || echo '{}' > "$DATA_PATH/.sync-state.json"
exec node src/app.js
