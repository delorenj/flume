"""Tests for task monitoring service."""

import asyncio
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient

from api import create_app
from models import EventType, TaskEvent, TaskState, TaskStatus
from state_manager import TaskStateManager


@pytest.fixture
async def state_manager() -> TaskStateManager:
    """Create a test state manager."""
    manager = TaskStateManager(
        persistence_path=None,
        stale_threshold=5,
        retention_hours=1,
    )
    await manager.initialize()
    yield manager
    await manager.shutdown()


@pytest.fixture
async def app(state_manager: TaskStateManager):
    """Create test FastAPI app."""
    return create_app(state_manager, datetime.now(timezone.utc))


@pytest.fixture
async def client(app):
    """Create test HTTP client."""
    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client


class TestTaskState:
    """Test TaskState model."""

    def test_create_task_state(self) -> None:
        """Test creating a task state."""
        task = TaskState(task_id="test-123")
        assert task.task_id == "test-123"
        assert task.status == TaskStatus.PENDING
        assert len(task.events) == 0

    def test_valid_state_transitions(self) -> None:
        """Test valid state transitions."""
        task = TaskState(task_id="test-123")

        # PENDING -> ASSIGNED
        event = TaskEvent(event_type=EventType.ASSIGNED, agent_id="agent-1")
        task.transition_to(TaskStatus.ASSIGNED, event)
        assert task.status == TaskStatus.ASSIGNED
        assert task.agent_id == "agent-1"

        # ASSIGNED -> STARTED
        event = TaskEvent(event_type=EventType.STARTED)
        task.transition_to(TaskStatus.STARTED, event)
        assert task.status == TaskStatus.STARTED
        assert task.started_at is not None

        # STARTED -> IN_PROGRESS
        event = TaskEvent(event_type=EventType.IN_PROGRESS)
        task.transition_to(TaskStatus.IN_PROGRESS, event)
        assert task.status == TaskStatus.IN_PROGRESS

        # IN_PROGRESS -> COMPLETED
        event = TaskEvent(event_type=EventType.COMPLETED)
        task.transition_to(TaskStatus.COMPLETED, event)
        assert task.status == TaskStatus.COMPLETED
        assert task.completed_at is not None

    def test_invalid_state_transition(self) -> None:
        """Test invalid state transition."""
        task = TaskState(task_id="test-123")
        event = TaskEvent(event_type=EventType.COMPLETED)

        # PENDING -> COMPLETED (invalid)
        with pytest.raises(ValueError):
            task.transition_to(TaskStatus.COMPLETED, event)

    def test_stale_detection(self) -> None:
        """Test stale task detection."""
        task = TaskState(
            task_id="test-123",
            status=TaskStatus.IN_PROGRESS,
        )

        # Not stale yet
        assert not task.is_stale(stale_threshold_seconds=3600)

        # Manually set old timestamp
        old_time = datetime.now(timezone.utc)
        old_time = old_time.replace(year=old_time.year - 1)
        task.last_heartbeat = old_time

        # Should be stale
        assert task.is_stale(stale_threshold_seconds=300)

    def test_timing_metrics(self) -> None:
        """Test timing metrics calculation."""
        task = TaskState(task_id="test-123")

        # Assign
        event = TaskEvent(event_type=EventType.ASSIGNED)
        task.transition_to(TaskStatus.ASSIGNED, event)

        # Start (wait a bit)
        asyncio.sleep(0.1)
        event = TaskEvent(event_type=EventType.STARTED)
        task.transition_to(TaskStatus.STARTED, event)

        assert task.time_in_queue is not None
        assert task.time_in_queue >= 0


class TestStateManager:
    """Test TaskStateManager."""

    @pytest.mark.asyncio
    async def test_handle_event(self, state_manager: TaskStateManager) -> None:
        """Test handling events."""
        event = TaskEvent(event_type=EventType.ASSIGNED, agent_id="agent-1")
        await state_manager.handle_event("task-123", event)

        task = await state_manager.get_task("task-123")
        assert task is not None
        assert task.task_id == "task-123"
        assert task.status == TaskStatus.ASSIGNED

    @pytest.mark.asyncio
    async def test_get_all_tasks(self, state_manager: TaskStateManager) -> None:
        """Test getting all tasks."""
        # Create multiple tasks
        for i in range(5):
            event = TaskEvent(event_type=EventType.ASSIGNED)
            await state_manager.handle_event(f"task-{i}", event)

        tasks = await state_manager.get_all_tasks(limit=10)
        assert len(tasks) == 5

    @pytest.mark.asyncio
    async def test_filter_by_status(self, state_manager: TaskStateManager) -> None:
        """Test filtering by status."""
        # Create tasks with different statuses
        event1 = TaskEvent(event_type=EventType.ASSIGNED)
        await state_manager.handle_event("task-1", event1)

        event2 = TaskEvent(event_type=EventType.STARTED)
        await state_manager.handle_event("task-2", event2)

        # Filter by ASSIGNED
        tasks = await state_manager.get_all_tasks(status=TaskStatus.ASSIGNED)
        assert len(tasks) == 1
        assert tasks[0].task_id == "task-1"

    @pytest.mark.asyncio
    async def test_get_metrics(self, state_manager: TaskStateManager) -> None:
        """Test metrics calculation."""
        # Create some tasks
        for i in range(3):
            event = TaskEvent(event_type=EventType.ASSIGNED)
            await state_manager.handle_event(f"task-{i}", event)

        metrics = await state_manager.get_metrics()
        assert metrics["total_tasks"] == 3
        assert TaskStatus.ASSIGNED.value in metrics["tasks_by_status"]

    @pytest.mark.asyncio
    async def test_stale_detection(self, state_manager: TaskStateManager) -> None:
        """Test stale task detection."""
        # Create task and mark as in progress
        event = TaskEvent(event_type=EventType.IN_PROGRESS)
        await state_manager.handle_event("task-1", event)

        # Get task and set old heartbeat
        task = await state_manager.get_task("task-1")
        assert task is not None

        old_time = datetime.now(timezone.utc)
        old_time = old_time.replace(year=old_time.year - 1)
        task.last_heartbeat = old_time

        # Check for stale tasks
        stale_tasks = await state_manager.get_stale_tasks()
        assert len(stale_tasks) >= 1


class TestAPI:
    """Test FastAPI endpoints."""

    @pytest.mark.asyncio
    async def test_root_endpoint(self, client: AsyncClient) -> None:
        """Test root endpoint."""
        response = await client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "Task Monitor"

    @pytest.mark.asyncio
    async def test_health_check(self, client: AsyncClient) -> None:
        """Test health check endpoint."""
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert "tasks_monitored" in data

    @pytest.mark.asyncio
    async def test_list_tasks(
        self,
        client: AsyncClient,
        state_manager: TaskStateManager,
    ) -> None:
        """Test listing tasks."""
        # Create a task
        event = TaskEvent(event_type=EventType.ASSIGNED)
        await state_manager.handle_event("task-1", event)

        response = await client.get("/tasks")
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 1

    @pytest.mark.asyncio
    async def test_get_task_details(
        self,
        client: AsyncClient,
        state_manager: TaskStateManager,
    ) -> None:
        """Test getting task details."""
        # Create a task
        event = TaskEvent(event_type=EventType.ASSIGNED, agent_id="agent-1")
        await state_manager.handle_event("task-123", event)

        response = await client.get("/tasks/task-123")
        assert response.status_code == 200
        data = response.json()
        assert data["task_id"] == "task-123"
        assert data["status"] == "assigned"

    @pytest.mark.asyncio
    async def test_get_nonexistent_task(self, client: AsyncClient) -> None:
        """Test getting nonexistent task."""
        response = await client.get("/tasks/nonexistent")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_amq.topic(
        self,
        client: AsyncClient,
        state_manager: TaskStateManager,
    ) -> None:
        """Test getting task event history."""
        # Create a task with multiple events
        event1 = TaskEvent(event_type=EventType.ASSIGNED)
        await state_manager.handle_event("task-1", event1)

        event2 = TaskEvent(event_type=EventType.STARTED)
        await state_manager.handle_event("task-1", event2)

        response = await client.get("/tasks/task-1/events")
        assert response.status_code == 200
        data = response.json()
        assert data["task_id"] == "task-1"
        assert data["event_count"] >= 2

    @pytest.mark.asyncio
    async def test_get_metrics(
        self,
        client: AsyncClient,
        state_manager: TaskStateManager,
    ) -> None:
        """Test metrics endpoint."""
        # Create some tasks
        for i in range(3):
            event = TaskEvent(event_type=EventType.ASSIGNED)
            await state_manager.handle_event(f"task-{i}", event)

        response = await client.get("/metrics")
        assert response.status_code == 200
        data = response.json()
        assert data["total_tasks"] >= 3
        assert "tasks_by_status" in data

    @pytest.mark.asyncio
    async def test_get_active_tasks(
        self,
        client: AsyncClient,
        state_manager: TaskStateManager,
    ) -> None:
        """Test getting active tasks."""
        # Create active and completed tasks
        event1 = TaskEvent(event_type=EventType.IN_PROGRESS)
        await state_manager.handle_event("task-1", event1)

        event2 = TaskEvent(event_type=EventType.COMPLETED)
        await state_manager.handle_event("task-2", event2)

        response = await client.get("/tasks/active")
        assert response.status_code == 200
        data = response.json()
        # Should only return active task
        task_ids = [t["task_id"] for t in data]
        assert "task-1" in task_ids
        assert "task-2" not in task_ids


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
