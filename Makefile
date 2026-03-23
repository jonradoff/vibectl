.PHONY: build dev client dev-client test lint docker-up docker-down frontend-dev frontend-build frontend-client-dev

VERSION ?= 0.2.0
LDFLAGS = -ldflags "-X github.com/jonradoff/vibectl/internal/config.Version=$(VERSION)"

build:
	cd cmd/server && go build $(LDFLAGS) -o ../../vibectl-server .
	cd cmd/cli && go build $(LDFLAGS) -o ../../vibectl .
	cd cmd/mcp && go build $(LDFLAGS) -o ../../vibectl-mcp .

build-server:
	cd cmd/server && go build -o ../../vibectl-server .

dev:
	./run-server.sh

# Client mode: connects to a remote vibectl server (config in .env.client)
client:
	./run-client.sh

frontend-dev:
	./run-vite.sh

# Client mode frontend dev server on port 4375 proxying to backend 4385
frontend-client-dev:
	VITE_PORT=4375 VITE_BACKEND_PORT=4385 ./run-vite.sh

frontend-build:
	cd frontend && npm run build

test:
	go test ./...

lint:
	go vet ./...

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

check:
	go build ./...
	cd frontend && npx tsc --noEmit

# Write .env.client for client mode — usage: make setup-client SERVER_URL=https://... API_KEY=vk_...
setup-client:
	@if [ -z "$(SERVER_URL)" ]; then echo "Usage: make setup-client SERVER_URL=https://your-server [API_KEY=vk_...]"; exit 1; fi
	@printf "REMOTE_SERVER_URL=%s\n" "$(SERVER_URL)" > .env.client
	@if [ -n "$(API_KEY)" ]; then printf "REMOTE_API_KEY=%s\n" "$(API_KEY)" >> .env.client; fi
	@echo "✓ .env.client written. Run 'make client' to start."
