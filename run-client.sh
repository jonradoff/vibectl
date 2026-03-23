#!/bin/bash
# run-client.sh — Starts vibectl in client mode (connects to a remote standalone server).
# Config (including API key) is loaded from .env.client which is gitignored.
#
# Ports:
#   Backend API:    4385  (standalone dev uses 4380 — no conflict)
#   Frontend dev:   4375  (standalone dev uses 4370 — no conflict)
#
# Usage:
#   ./run-client.sh                # build + run client mode
#   make frontend-client-dev       # Vite dev server on port 4375 (see Makefile)

set -e

cd "$(dirname "$0")"

if [ ! -f .env.client ]; then
    echo "ERROR: .env.client not found."
    echo "Create .env.client with REMOTE_SERVER_URL and REMOTE_API_KEY, then retry."
    exit 1
fi

# Load client env (overrides any existing env vars)
set -a
source .env.client
set +a

echo "=== Building vibectl-server (client mode) ==="
go build -o vibectl-server ./cmd/server/

while true; do
    echo "=== Starting vibectl-server in client mode (port ${PORT:-4385}) ==="
    echo "    Remote: ${REMOTE_SERVER_URL}"
    ./vibectl-server "$@" || true

    EXIT_CODE=$?
    echo "=== Server exited (code $EXIT_CODE), rebuilding in 2s ==="
    sleep 2

    echo "=== Rebuilding vibectl-server ==="
    go build -o vibectl-server ./cmd/server/ || {
        echo "=== Build failed, retrying in 5s ==="
        sleep 5
        continue
    }
done
