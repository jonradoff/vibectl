#!/bin/bash
# run-server.sh — Builds and runs vibectl-server with automatic restart.
# Used for development so that if syscall.Exec fails during a self-rebuild,
# the server comes back up automatically.

set -e

cd "$(dirname "$0")"

echo "=== Building vibectl-server ==="
go build -o vibectl-server ./cmd/server/

while true; do
    echo "=== Starting vibectl-server ==="
    ./vibectl-server "$@" || true

    EXIT_CODE=$?

    # Exit code 0 from syscall.Exec means the process replaced itself successfully.
    # We only get here if the process actually exited (crash or exec failure).
    echo "=== Server exited (code $EXIT_CODE), rebuilding in 2s ==="
    sleep 2

    # Rebuild before restarting in case the binary was updated on disk
    echo "=== Rebuilding vibectl-server ==="
    go build -o vibectl-server ./cmd/server/ || {
        echo "=== Build failed, retrying in 5s ==="
        sleep 5
        continue
    }
done
