# Flume - Task Lifecycle Management System

**Flume** is a comprehensive, event-driven task orchestration system that bridges the gap between Obsidian note-taking, terminal-based AI agents (like Claude Code and Gemini), and a real-time monitoring dashboard. It enables a "fire-and-forget" workflow where tasks defined in Obsidian are automatically executed by AI agents in dedicated terminal sessions, with full observability.

## 🏗️ Architecture Overview

The system follows an event-driven architecture using RabbitMQ (Bloodbank) as the central nervous system.

```mermaid
graph TD
    Obsidian[Obsidian QuickAdd] -->|task.lifecycle.assigned| RabbitMQ
    RabbitMQ -->|Event| SessionMgr[Task Session Manager (Go)]
    RabbitMQ -->|Event| Monitor[Task Monitor (Python)]
    
    SessionMgr -->|Spawns| Zellij[Zellij Session]
    Zellij -->|Runs| Agent[AI Agent Wrapper]
    
    Agent -->|task.lifecycle.started| RabbitMQ
    Agent -->|task.lifecycle.in_progress| RabbitMQ
    Agent -->|task.lifecycle.completed| RabbitMQ
    
    Monitor -->|WebSocket| Dashboard[Next.js Dashboard]
```

### Core Components

1.  **Obsidian Integration (`obsidian-quickadd-*.js`):** Scripts that run within Obsidian to parse task notes and publish assignment events.
2.  **Bloodbank (RabbitMQ):** The message broker handling all lifecycle events (`task.lifecycle.*`).
3.  **Task Session Manager (`task-session-manager/`):** A Go service that consumes assignment events, spawns isolated Zellij/Tmux sessions, and launches the AI agent wrapper.
4.  **Task Monitor (`task-monitor/`):** A Python/FastAPI service that tracks the state of all tasks, persists history, and exposes a WebSocket API.
5.  **Task Dashboard (`task-dashboard/`):** A Next.js 16 real-time UI for monitoring active tasks, viewing logs, and analyzing metrics.
6.  **Flume Agent (`flume-agent`):** A wrapper around AI CLIs that injects context and emits heartbeat/progress events.

## 🚀 Getting Started

### Prerequisites

*   **Docker & Docker Compose:** For running the services.
*   **Zellij:** Terminal multiplexer for agent sessions.
*   **Mise:** Task runner and tool manager (preferred).
*   **Go 1.21+** & **Python 3.12+** & **Node.js 18+**.
*   **RabbitMQ:** Running locally or via Docker.

### Running the System

The system is designed to be run as a set of microservices.

**1. Start Infrastructure (RabbitMQ):**
```bash
# In the root or a dedicated docker directory
docker run -d -p 5672:5672 -p 15672:15672 --name bloodbank rabbitmq:3-management
```

**2. Start Services (Individual Terminals or Docker Compose):**

*   **Task Monitor:**
    ```bash
    cd task-monitor
    make run
    # OR
    make docker-up
    ```

*   **Task Session Manager:**
    ```bash
    cd task-session-manager
    make run
    # OR
    make docker-up
    ```

*   **Task Dashboard:**
    ```bash
    cd task-dashboard
    npm install
    npm run dev
    ```

**3. Quick Start Script:**
You can use `start-agent.sh` to manually fire a task if the full event loop isn't set up yet:
```bash
./start-agent.sh "Implement feature X using Y"
```

## 📂 Project Structure

*   `trunk-main/`
    *   `task-dashboard/` - Frontend application (Next.js, Tailwind, Socket.io).
    *   `task-monitor/` - Backend state manager (FastAPI, Python).
    *   `task-session-manager/` - Session orchestrator (Go).
    *   `event_producers/` - Python schemas and CLI tools for events.
    *   `docs/` - Comprehensive documentation (Architecture, API, Guides).
    *   `obsidian-quickadd-*.js` - Integration scripts for Obsidian.
    *   `PRD.md` - Product Requirements Document.
    *   `IMPLEMENTATION_REPORT.md` - Status of the implementation.

## 🛠️ Development Conventions

*   **Task Runner:** Use **Mise** for managing environments and running tasks.
*   **Event-First:** All state changes should be driven by events. If you need to change something, publish an event.
*   **Documentation:** Keep `docs/` updated. Architecture changes require a corresponding update in `docs/architecture/`.
*   **Testing:**
    *   Go: `make test`
    *   Python: `make test` (pytest)
    *   Frontend: Standard Next.js testing patterns.
*   **Logs:** Services should log structured JSON where possible (using `zerolog` for Go, standard logging for Python).

## 🔍 Key Commands

*   **Build Session Manager:** `cd task-session-manager && make build`
*   **Run Monitor:** `cd task-monitor && make run`
*   **Generate Events:** Use the `bb` (Bloodbank) CLI tools found in `event_producers/`.

## ⚠️ Known Issues / Status

*   **Schema Consistency:** Ensure event schemas in `event_producers/events.py` match the Go structs and TypeScript interfaces.
*   **Security:** Authentication is currently open; do not expose ports publicly.
*   **Tests:** Unit test coverage is currently partial.

## 📚 References

*   [Implementation Report](IMPLEMENTATION_REPORT.md)
*   [Architecture Summary](docs/architecture/00-ARCHITECTURE_SUMMARY.md)
*   [PRD](PRD.md)
