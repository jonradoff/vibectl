#!/bin/bash
# Wrapper for vibectl MCP server (stdio transport)
# Reads MongoDB URI and database name from .env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  export $(grep -v '^#' "$SCRIPT_DIR/.env" | grep -E '^(MONGODB_URI|DATABASE_NAME)=' | xargs)
fi

MONGODB_URI="${MONGODB_URI:-mongodb://localhost:27017}"
DATABASE_NAME="${DATABASE_NAME:-vibectl}"

exec "$SCRIPT_DIR/vibectl-mcp" \
  --mongodb-uri "$MONGODB_URI" \
  --database "$DATABASE_NAME"
