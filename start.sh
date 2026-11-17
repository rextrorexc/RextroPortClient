#!/usr/bin/env bash
# Starts the server on a free port and opens the site on localhost.
cd "$(dirname "$0")"
PORT="${PORT:-3917}"
while ss -ltn 2>/dev/null | grep -q ":$PORT "; do PORT=$((PORT+1)); done
export PORT
URL="http://localhost:$PORT"
echo "Rextro Port Client: $URL"
(sleep 1; xdg-open "$URL" >/dev/null 2>&1 || true) &
exec node server.js
