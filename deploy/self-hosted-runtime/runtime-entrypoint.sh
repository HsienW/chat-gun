#!/bin/sh
set -eu
# Allow explicit maintenance commands without changing the graph.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node --import tsx /app/backend/start-runtime.mjs
