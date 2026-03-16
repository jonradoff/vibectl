FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o vibectl-server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/vibectl-server .
COPY --from=builder /app/frontend/dist ./frontend/dist
EXPOSE 4380
CMD ["./vibectl-server"]
