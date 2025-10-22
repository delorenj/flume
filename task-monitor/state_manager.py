"""Task state management with persistence."""

import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from models import EventType, TaskEvent, TaskState, TaskStatus

logger = logging.getLogger(__name__)


class TaskStateManager:
    """Manages task states in memory with optional persistence."""

    def __init__(
        self,
        persistence_path: Optional[Path] = None,
        persistence_interval: int = 60,
        stale_threshold: int = 300,
        retention_hours: int = 24,
    ) -> None:
        """Initialize state manager.

        Args:
            persistence_path: Path to JSON file for persistence (None = no persistence)
            persistence_interval: Seconds between persistence saves
            stale_threshold: Seconds before task is considered stale
            retention_hours: Hours to retain completed/failed tasks
        """
        self.tasks: dict[str, TaskState] = {}
        self.persistence_path = persistence_path
        self.persistence_interval = persistence_interval
        self.stale_threshold = stale_threshold
        self.retention_hours = retention_hours

        self._lock = asyncio.Lock()
        self._persistence_task: Optional[asyncio.Task] = None
        self._cleanup_task: Optional[asyncio.Task] = None

        # Statistics
        self.stats = {
            "events_processed": 0,
            "state_transitions": 0,
            "invalid_transitions": 0,
        }

    async def initialize(self) -> None:
        """Initialize state manager and load persisted state."""
        if self.persistence_path and self.persistence_path.exists():
            await self._load_state()

        # Start background tasks
        self._persistence_task = asyncio.create_task(self._persistence_loop())
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

        logger.info("Task state manager initialized")

    async def shutdown(self) -> None:
        """Shutdown state manager and save state."""
        # Cancel background tasks
        if self._persistence_task:
            self._persistence_task.cancel()
            try:
                await self._persistence_task
            except asyncio.CancelledError:
                pass

        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass

        # Final save
        if self.persistence_path:
            await self._save_state()

        logger.info("Task state manager shutdown complete")

    async def handle_event(self, task_id: str, event: TaskEvent) -> None:
        """Handle a task event and update state.

        Args:
            task_id: Task identifier
            event: Task event to process
        """
        async with self._lock:
            # Get or create task state
            task = self.tasks.get(task_id)
            if not task:
                task = TaskState(
                    task_id=task_id,
                    created_at=event.timestamp,
                )
                self.tasks[task_id] = task
                logger.debug(f"Created new task state: {task_id}")

            # Map event type to status
            new_status = self._event_to_status(event.event_type)

            # Handle heartbeat events (don't change status)
            if event.event_type == EventType.HEARTBEAT:
                task.add_event(event)
                self.stats["events_processed"] += 1
                return

            # Attempt state transition
            try:
                if new_status:
                    task.transition_to(new_status, event)
                    self.stats["state_transitions"] += 1
                    logger.info(
                        f"Task {task_id} transitioned to {new_status} "
                        f"(agent: {event.agent_id or 'N/A'})"
                    )
                else:
                    # Just add event without transition
                    task.add_event(event)

                self.stats["events_processed"] += 1

            except ValueError as e:
                logger.warning(f"Invalid state transition: {e}")
                self.stats["invalid_transitions"] += 1
                # Add event anyway for history
                task.add_event(event)

    def _event_to_status(self, event_type: EventType) -> Optional[TaskStatus]:
        """Map event type to task status.

        Args:
            event_type: Event type

        Returns:
            Corresponding TaskStatus or None if no mapping
        """
        mapping = {
            EventType.ASSIGNED: TaskStatus.ASSIGNED,
            EventType.STARTED: TaskStatus.STARTED,
            EventType.IN_PROGRESS: TaskStatus.IN_PROGRESS,
            EventType.COMPLETED: TaskStatus.COMPLETED,
            EventType.FAILED: TaskStatus.FAILED,
            EventType.PAUSED: TaskStatus.PAUSED,
            EventType.RESUMED: TaskStatus.IN_PROGRESS,
        }
        return mapping.get(event_type)

    async def get_task(self, task_id: str) -> Optional[TaskState]:
        """Get task state by ID.

        Args:
            task_id: Task identifier

        Returns:
            TaskState or None if not found
        """
        async with self._lock:
            return self.tasks.get(task_id)

    async def get_all_tasks(
        self,
        status: Optional[TaskStatus] = None,
        agent_id: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[TaskState]:
        """Get all tasks with optional filtering.

        Args:
            status: Filter by status
            agent_id: Filter by agent ID
            limit: Maximum number of tasks to return
            offset: Offset for pagination

        Returns:
            List of TaskState objects
        """
        async with self._lock:
            tasks = list(self.tasks.values())

            # Apply filters
            if status:
                tasks = [t for t in tasks if t.status == status]
            if agent_id:
                tasks = [t for t in tasks if t.agent_id == agent_id]

            # Sort by updated_at descending
            tasks.sort(key=lambda t: t.updated_at, reverse=True)

            # Apply pagination
            return tasks[offset : offset + limit]

    async def get_active_tasks(self) -> list[TaskState]:
        """Get all active tasks (not completed or failed).

        Returns:
            List of active TaskState objects
        """
        active_statuses = {
            TaskStatus.PENDING,
            TaskStatus.ASSIGNED,
            TaskStatus.STARTED,
            TaskStatus.IN_PROGRESS,
            TaskStatus.PAUSED,
        }

        async with self._lock:
            return [t for t in self.tasks.values() if t.status in active_statuses]

    async def get_stale_tasks(self) -> list[TaskState]:
        """Get all stale tasks.

        Returns:
            List of stale TaskState objects
        """
        async with self._lock:
            stale_tasks = []
            for task in self.tasks.values():
                if task.is_stale(self.stale_threshold):
                    stale_tasks.append(task)

                    # Mark as stale if not already
                    if task.status != TaskStatus.STALE:
                        try:
                            event = TaskEvent(
                                event_type=EventType.FAILED,
                                message=f"Task marked as stale (no heartbeat for {self.stale_threshold}s)",
                            )
                            task.transition_to(TaskStatus.STALE, event, force=True)
                            logger.warning(f"Task {task.task_id} marked as stale")
                        except Exception as e:
                            logger.error(f"Error marking task as stale: {e}")

            return stale_tasks

    async def get_metrics(self) -> dict:
        """Get aggregate metrics.

        Returns:
            Dictionary of metrics
        """
        async with self._lock:
            tasks = list(self.tasks.values())

            # Count by status
            status_counts = defaultdict(int)
            for task in tasks:
                status_counts[task.status.value] += 1

            # Count by agent
            agent_counts = defaultdict(int)
            for task in tasks:
                if task.agent_id:
                    agent_counts[task.agent_id] += 1

            # Calculate averages
            completed_tasks = [t for t in tasks if t.status == TaskStatus.COMPLETED]
            avg_queue_time = None
            avg_processing_time = None

            if completed_tasks:
                queue_times = [
                    t.time_in_queue for t in completed_tasks if t.time_in_queue
                ]
                if queue_times:
                    avg_queue_time = sum(queue_times) / len(queue_times)

                processing_times = [
                    t.time_processing for t in completed_tasks if t.time_processing
                ]
                if processing_times:
                    avg_processing_time = sum(processing_times) / len(processing_times)

            # Calculate success rate
            total_completed = status_counts.get(TaskStatus.COMPLETED.value, 0)
            total_failed = (
                status_counts.get(TaskStatus.FAILED.value, 0)
                + status_counts.get(TaskStatus.STALE.value, 0)
            )
            total_terminal = total_completed + total_failed
            success_rate = (
                total_completed / total_terminal if total_terminal > 0 else 0.0
            )

            # Count active tasks
            active_statuses = {
                TaskStatus.ASSIGNED.value,
                TaskStatus.STARTED.value,
                TaskStatus.IN_PROGRESS.value,
                TaskStatus.PAUSED.value,
            }
            active_tasks = sum(
                count for status, count in status_counts.items() if status in active_statuses
            )

            return {
                "total_tasks": len(tasks),
                "tasks_by_status": dict(status_counts),
                "tasks_by_agent": dict(agent_counts),
                "average_queue_time": avg_queue_time,
                "average_processing_time": avg_processing_time,
                "total_completed": total_completed,
                "total_failed": total_failed,
                "success_rate": success_rate,
                "active_tasks": active_tasks,
                "statistics": self.stats.copy(),
            }

    async def _persistence_loop(self) -> None:
        """Background task for periodic persistence."""
        if not self.persistence_path:
            return

        logger.info(f"Starting persistence loop (interval: {self.persistence_interval}s)")

        try:
            while True:
                await asyncio.sleep(self.persistence_interval)
                await self._save_state()
        except asyncio.CancelledError:
            logger.info("Persistence loop cancelled")
            raise

    async def _save_state(self) -> None:
        """Save current state to file."""
        if not self.persistence_path:
            return

        try:
            async with self._lock:
                # Convert tasks to dict
                data = {
                    "tasks": {
                        task_id: task.model_dump(mode="json")
                        for task_id, task in self.tasks.items()
                    },
                    "stats": self.stats,
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                }

            # Write to temp file then rename (atomic)
            temp_path = self.persistence_path.with_suffix(".tmp")
            temp_path.parent.mkdir(parents=True, exist_ok=True)

            with open(temp_path, "w") as f:
                json.dump(data, f, indent=2)

            temp_path.rename(self.persistence_path)
            logger.debug(f"Saved state to {self.persistence_path}")

        except Exception as e:
            logger.error(f"Error saving state: {e}", exc_info=True)

    async def _load_state(self) -> None:
        """Load state from file."""
        if not self.persistence_path or not self.persistence_path.exists():
            return

        try:
            with open(self.persistence_path) as f:
                data = json.load(f)

            # Restore tasks
            for task_id, task_data in data.get("tasks", {}).items():
                try:
                    task = TaskState(**task_data)
                    self.tasks[task_id] = task
                except Exception as e:
                    logger.error(f"Error loading task {task_id}: {e}")

            # Restore stats
            if "stats" in data:
                self.stats.update(data["stats"])

            logger.info(
                f"Loaded {len(self.tasks)} tasks from {self.persistence_path}"
            )

        except Exception as e:
            logger.error(f"Error loading state: {e}", exc_info=True)

    async def _cleanup_loop(self) -> None:
        """Background task for cleaning up old tasks."""
        logger.info(
            f"Starting cleanup loop (retention: {self.retention_hours} hours)"
        )

        try:
            while True:
                await asyncio.sleep(3600)  # Run every hour
                await self._cleanup_old_tasks()
        except asyncio.CancelledError:
            logger.info("Cleanup loop cancelled")
            raise

    async def _cleanup_old_tasks(self) -> None:
        """Remove old completed/failed tasks."""
        async with self._lock:
            now = datetime.now(timezone.utc)
            retention_seconds = self.retention_hours * 3600
            terminal_statuses = {TaskStatus.COMPLETED, TaskStatus.FAILED}

            tasks_to_remove = []
            for task_id, task in self.tasks.items():
                if task.status not in terminal_statuses:
                    continue

                if not task.completed_at:
                    continue

                age_seconds = (now - task.completed_at).total_seconds()
                if age_seconds > retention_seconds:
                    tasks_to_remove.append(task_id)

            # Remove old tasks
            for task_id in tasks_to_remove:
                del self.tasks[task_id]

            if tasks_to_remove:
                logger.info(f"Cleaned up {len(tasks_to_remove)} old tasks")
