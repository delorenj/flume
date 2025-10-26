# FLUME CODEBASE CRUSH.md

## Build/Lint/Test Commands
### Go (task-session-manager)
- **Build**: `make build` or `make build-all` (static binaries)
- **Test**: `make test` or `go test -v -race -coverprofile=coverage.out ./...`
- **Test coverage**: `make test-coverage`
- **Lint**: `make lint` or `golangci-lint run ./...`
- **Format**: `make fmt` or `go fmt ./...`

### Python (task-monitor)  
- **Install**: `pip install -e .` or `make install`
- **Test**: `pytest` or `make test`
- **Lint**: `ruff check .` + `ruff format --check .`
- **Format**: `ruff format .`
- **Type check**: `mypy .`

### Next.js (task-dashboard)
- **Build**: `npm run build` (Turbopack standalone)
- **Dev**: `npm run dev`
- **Test**: `npm test`
- **Lint**: `npm run lint` (ESLint + custom rules)
- **Typecheck**: `npm run typecheck` or `npx tsc --noEmit`

## Code Style Guidelines
### Go
- goimports organizes imports (local prefix github.com/33GOD/flume)
- PascalCase exported, camelCase private. Concise names
- Errors: `fmt.Errorf("...: %w", err)` with wrapping
- Line length: 140 chars max
- Testing: table-driven tests preferred

### Python
- Ruff auto-sorts imports alphabetically
- snake_case vars/fns, PascalCase classes only  
- Pydantic v2 for data models, strict mypy typing
- Line length: 88 chars (Black/Ruff)
- Async: asyncio + aio-pika throughout

### TypeScript/React
- Named imports, @/* path aliases for internal
- Functional components with hooks, PascalCase, arrow defaults
- Interfaces over types, strict TypeScript enforced
- camelCase vars/fns/methods  
- Zustand store with Immer for global state
- ESLint handles formatting (no Prettier)

## Shared Patterns
- Events: PascalCase routing keys (TaskCreated), snake_case JSON  
- Config: YAML for structure, env vars for secrets
- RabbitMQ pub/sub, session tracking in Go, WebSocket real-time updates