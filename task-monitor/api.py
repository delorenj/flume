"""FastAPI REST API for task monitoring."""

import logging
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import (
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from prometheus_client import CONTENT_TYPE_LATEST

from models import (
    HealthStatus,
    TaskFilter,
    TaskMetrics,
    TaskState,
    TaskStatus,
    WebSocketMessage,
)
from state_manager import TaskStateManager

logger = logging.getLogger(__name__)

# Prometheus metrics
TASK_EVENTS_TOTAL = Counter(
    "task_events_total",
    "Total number of task events processed",
    ["event_type"],
)

TASK_STATE_TRANSITIONS = Counter(
    "task_state_transitions_total",
    "Total number of task state transitions",
    ["from_status", "to_status"],
)

TASK_DURATION_SECONDS = Histogram(
    "task_duration_seconds",
    "Task duration in seconds",
    ["status"],
    buckets=[1, 5, 10, 30, 60, 300, 600, 1800, 3600],
)

TASKS_BY_STATUS = Gauge(
    "tasks_by_status",
    "Number of tasks by status",
    ["status"],
)

ACTIVE_TASKS = Gauge(
    "active_tasks_total",
    "Total number of active tasks",
)


class WebSocketManager:
    """Manages WebSocket connections for real-time updates."""

    def __init__(self) -> None:
        """Initialize WebSocket manager."""
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a new WebSocket connection.

        Args:
            websocket: WebSocket connection
        """
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket connected. Total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket) -> None:
        """Remove a WebSocket connection.

        Args:
            websocket: WebSocket connection
        """
        self.active_connections.remove(websocket)
        logger.info(f"WebSocket disconnected. Total connections: {len(self.active_connections)}")

    async def broadcast(self, message: WebSocketMessage) -> None:
        """Broadcast a message to all connected clients.

        Args:
            message: Message to broadcast
        """
        if not self.active_connections:
            return

        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message.model_dump(mode="json"))
            except Exception as e:
                logger.error(f"Error sending WebSocket message: {e}")
                disconnected.append(connection)

        # Remove disconnected clients
        for conn in disconnected:
            self.disconnect(conn)


def create_app(state_manager: TaskStateManager, start_time: datetime) -> FastAPI:
    """Create FastAPI application.

    Args:
        state_manager: Task state manager instance
        start_time: Service start time

    Returns:
        Configured FastAPI application
    """
    app = FastAPI(
        title="Task Monitor API",
        description="Real-time task monitoring and metrics service",
        version="1.0.0",
    )

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # WebSocket manager
    ws_manager = WebSocketManager()

    # Store references
    app.state.state_manager = state_manager
    app.state.ws_manager = ws_manager
    app.state.start_time = start_time

    @app.get("/")
    async def root() -> dict:
        """Root endpoint."""
        return {
            "service": "Task Monitor",
            "version": "1.0.0",
            "status": "running",
        }

    @app.get("/health", response_model=HealthStatus)
    async def health_check() -> HealthStatus:
        """Health check endpoint."""
        metrics = await state_manager.get_metrics()
        stale_tasks = await state_manager.get_stale_tasks()

        uptime = (datetime.now(start_time.tzinfo) - start_time).total_seconds()

        # Get memory usage (optional, requires psutil)
        memory_mb = None
        try:
            import psutil
            process = psutil.Process()
            memory_mb = process.memory_info().rss / 1024 / 1024
        except ImportError:
            pass

        return HealthStatus(
            status="healthy",
            tasks_monitored=metrics["total_tasks"],
            rabbitmq_connected=True,  # TODO: Check actual connection
            stale_tasks_count=len(stale_tasks),
            uptime_seconds=uptime,
            memory_usage_mb=memory_mb,
        )

    @app.get("/tasks", response_model=list[TaskState])
    async def list_tasks(
        status: Optional[TaskStatus] = None,
        agent_id: Optional[str] = None,
        limit: int = Query(default=100, ge=1, le=1000),
        offset: int = Query(default=0, ge=0),
    ) -> list[TaskState]:
        """List tasks with optional filtering."""
        tasks = await state_manager.get_all_tasks(
            status=status,
            agent_id=agent_id,
            limit=limit,
            offset=offset,
        )
        return tasks

    @app.get("/tasks/active", response_model=list[TaskState])
    async def list_active_tasks() -> list[TaskState]:
        """Get all active tasks."""
        return await state_manager.get_active_tasks()

    @app.get("/tasks/stale", response_model=list[TaskState])
    async def list_stale_tasks() -> list[TaskState]:
        """Get all stale tasks."""
        return await state_manager.get_stale_tasks()

    @app.get("/tasks/{task_id}", response_model=TaskState)
    async def get_task(task_id: str) -> TaskState:
        """Get specific task details."""
        task = await state_manager.get_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        return task

    @app.get("/tasks/{task_id}/events")
    async def get_task_events(task_id: str) -> dict:
        """Get full event history for a task."""
        task = await state_manager.get_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")

        return {
            "task_id": task_id,
            "event_count": len(task.events),
            "events": [event.model_dump(mode="json") for event in task.events],
        }

    @app.get("/metrics", response_model=TaskMetrics)
    async def get_metrics() -> TaskMetrics:
        """Get aggregate metrics."""
        metrics = await state_manager.get_metrics()

        return TaskMetrics(
            total_tasks=metrics["total_tasks"],
            tasks_by_status=metrics["tasks_by_status"],
            tasks_by_agent=metrics["tasks_by_agent"],
            average_queue_time=metrics["average_queue_time"],
            average_processing_time=metrics["average_processing_time"],
            total_completed=metrics["total_completed"],
            total_failed=metrics["total_failed"],
            success_rate=metrics["success_rate"],
            active_tasks=metrics["active_tasks"],
        )

    @app.get("/metrics/prometheus")
    async def prometheus_metrics() -> JSONResponse:
        """Export metrics in Prometheus format."""
        # Update Prometheus gauges
        metrics = await state_manager.get_metrics()

        # Update status gauges
        for status, count in metrics["tasks_by_status"].items():
            TASKS_BY_STATUS.labels(status=status).set(count)

        ACTIVE_TASKS.set(metrics["active_tasks"])

        # Generate Prometheus exposition format
        return JSONResponse(
            content=generate_latest().decode("utf-8"),
            media_type=CONTENT_TYPE_LATEST,
        )

    @app.get("/stats")
    async def get_stats() -> dict:
        """Get internal statistics."""
        return state_manager.stats.copy()

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        """WebSocket endpoint for real-time updates."""
        await ws_manager.connect(websocket)

        try:
            # Send initial state
            tasks = await state_manager.get_active_tasks()
            initial_message = WebSocketMessage(
                type="initial_state",
                data={
                    "task_count": len(tasks),
                    "tasks": [task.model_dump(mode="json") for task in tasks[:10]],
                },
            )
            await websocket.send_json(initial_message.model_dump(mode="json"))

            # Keep connection alive
            while True:
                # Wait for any client messages (ping/pong)
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")

        except WebSocketDisconnect:
            ws_manager.disconnect(websocket)
        except Exception as e:
            logger.error(f"WebSocket error: {e}", exc_info=True)
            ws_manager.disconnect(websocket)

    # Add method to broadcast updates
    async def broadcast_task_update(task: TaskState) -> None:
        """Broadcast task update to WebSocket clients.

        Args:
            task: Updated task state
        """
        message = WebSocketMessage(
            type="task_update",
            task_id=task.task_id,
            data=task.model_dump(mode="json"),
        )
        await ws_manager.broadcast(message)

    # Store broadcast method for use in main
    app.state.broadcast_task_update = broadcast_task_update

    return app
