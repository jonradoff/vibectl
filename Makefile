.PHONY: build dev test lint docker-up docker-down frontend-dev frontend-build

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

frontend-dev:
	cd frontend && npm run dev

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
