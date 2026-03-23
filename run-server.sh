#!/bin/bash
# run-server.sh — Builds and runs vibectl-server with automatic restart.
# Used for development so that if syscall.Exec fails during a self-rebuild,
# the server comes back up automatically.

set -e

cd "$(dirname "$0")"

echo "=== Building vibectl-server ==="
go build -o vibectl-server ./cmd/server/

while true; do
    echo "=== Starting vibectl-server at $(date) ==="
    ./vibectl-server "$@"
    EXIT_CODE=$?

    # Decode the exit signal for debugging
    if [ $EXIT_CODE -eq 0 ]; then
        REASON="clean exit (syscall.Exec self-rebuild)"
    elif [ $EXIT_CODE -eq 130 ]; then
        REASON="SIGINT (Ctrl+C)"
    elif [ $EXIT_CODE -eq 137 ]; then
        REASON="SIGKILL (killed by OS — likely out-of-memory)"
    elif [ $EXIT_CODE -eq 143 ]; then
        REASON="SIGTERM (graceful shutdown request)"
    else
        REASON="exit code $EXIT_CODE"
    fi

    echo "=== Server stopped at $(date): $REASON — rebuilding in 2s ==="
    sleep 2

    # Rebuild before restarting in case the binary was updated on disk
    echo "=== Rebuilding vibectl-server ==="
    go build -o vibectl-server ./cmd/server/ || {
        echo "=== Build failed, retrying in 5s ==="
        sleep 5
        continue
    }
done
