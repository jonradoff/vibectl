#!/bin/bash
# run-vite.sh — Runs the Vite dev server with automatic restart.
# Vite can be killed by the OS (memory pressure) or crash; this wrapper restarts it.

cd "$(dirname "$0")/frontend"

VITE_PORT="${VITE_PORT:-4370}"

while true; do
    echo "=== Starting Vite dev server on port $VITE_PORT at $(date) ==="
    VITE_PORT=$VITE_PORT npm run dev
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        REASON="clean exit"
    elif [ $EXIT_CODE -eq 130 ]; then
        REASON="SIGINT (Ctrl+C) — stopping"
        echo "=== Vite stopped: $REASON ==="
        exit 0
    elif [ $EXIT_CODE -eq 137 ]; then
        REASON="SIGKILL (killed by OS — likely out-of-memory)"
    elif [ $EXIT_CODE -eq 143 ]; then
        REASON="SIGTERM (restarting — use Ctrl+C to stop)"
    else
        REASON="exit code $EXIT_CODE"
    fi

    echo "=== Vite stopped at $(date): $REASON — restarting in 3s ==="
    sleep 3
done
