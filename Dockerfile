# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --legacy-peer-deps
COPY frontend/ .
RUN npm run build

# Stage 2: Build Go server
FROM golang:1.25-alpine AS backend-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o vibectl-server ./cmd/server

# Stage 3: Final image
FROM alpine:3.19
RUN apk add --no-cache ca-certificates git nodejs npm su-exec
# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code
# Create a non-root user — Claude Code refuses --dangerously-skip-permissions when run as root
RUN adduser -D -h /home/vibectl vibectl
WORKDIR /app
COPY --from=backend-builder /app/vibectl-server .
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && chown -R vibectl:vibectl /app
# /data is a Fly volume mounted at runtime; entrypoint fixes ownership before dropping to vibectl user
EXPOSE 4380
ENTRYPOINT ["/app/docker-entrypoint.sh"]
