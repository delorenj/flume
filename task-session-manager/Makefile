.PHONY: help build build-all build-cli run test clean docker-build docker-run install install-all deps lint

# Variables
BINARY_NAME=task-session-manager
CLI_BINARIES=flume-complete flume-session flume
DOCKER_IMAGE=task-session-manager:latest
GO_FILES=$(shell find . -name '*.go' -type f)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

deps: ## Download dependencies
	go mod download
	go mod tidy

build: deps ## Build the main application
	CGO_ENABLED=0 go build -ldflags="-w -s" -o bin/$(BINARY_NAME) ./cmd

build-cli: deps ## Build all CLI tools
	@echo "Building CLI tools..."
	@mkdir -p bin
	@for cli in $(CLI_BINARIES); do \
		echo "  Building $$cli..."; \
		CGO_ENABLED=0 go build -ldflags="-w -s" -o bin/$$cli ./cmd/$$cli; \
	done
	@echo "CLI tools built successfully"

build-all: build build-cli ## Build everything (main app + CLI tools)

run: build ## Build and run the main application
	./bin/$(BINARY_NAME)

test: ## Run tests
	go test -v -race -coverprofile=coverage.out ./...

test-coverage: test ## Run tests with coverage report
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

lint: ## Run linters
	@which golangci-lint > /dev/null || (echo "Installing golangci-lint..." && go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest)
	golangci-lint run ./...

clean: ## Clean build artifacts
	rm -rf bin/
	rm -f coverage.out coverage.html

docker-build: ## Build Docker image
	docker build -t $(DOCKER_IMAGE) .

docker-run: docker-build ## Run in Docker with docker-compose
	docker-compose up -d

docker-stop: ## Stop Docker containers
	docker-compose down

docker-logs: ## Show Docker logs
	docker-compose logs -f task-session-manager

install: build ## Install the main binary to /usr/local/bin
	sudo cp bin/$(BINARY_NAME) /usr/local/bin/

install-all: build-all ## Install all binaries (main app + CLI tools) to /usr/local/bin
	sudo cp bin/$(BINARY_NAME) /usr/local/bin/
	@for cli in $(CLI_BINARIES); do \
		sudo cp bin/$$cli /usr/local/bin/; \
	done
	@echo "All binaries installed to /usr/local/bin/"

dev: ## Run with hot reload (requires air)
	@which air > /dev/null || (echo "Installing air..." && go install github.com/air-verse/air@latest)
	air

fmt: ## Format code
	go fmt ./...
	gofmt -s -w .

vet: ## Run go vet
	go vet ./...

mod-update: ## Update dependencies
	go get -u ./...
	go mod tidy

check: lint vet test ## Run all checks

.DEFAULT_GOAL := help
