"""Data models for task monitoring service."""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class TaskStatus(str, Enum):
    """Task status enumeration."""

    PENDING = "pending"
    ASSIGNED = "assigned"
    STARTED = "started"
    IN_PROGRESS = "in_progress"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    STALE = "stale"


class EventType(str, Enum):
    """Task event type enumeration."""

    ASSIGNED = "assigned"
    STARTED = "started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"
    RESUMED = "resumed"
    HEARTBEAT = "heartbeat"


# Valid state transitions
VALID_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.PENDING: {TaskStatus.ASSIGNED, TaskStatus.FAILED},
    TaskStatus.ASSIGNED: {TaskStatus.STARTED, TaskStatus.FAILED},
    TaskStatus.STARTED: {TaskStatus.IN_PROGRESS, TaskStatus.FAILED},
    TaskStatus.IN_PROGRESS: {
        TaskStatus.IN_PROGRESS,  # Allow for heartbeats
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.PAUSED,
        TaskStatus.STALE,
    },
    TaskStatus.PAUSED: {TaskStatus.IN_PROGRESS, TaskStatus.FAILED, TaskStatus.STALE},
    TaskStatus.COMPLETED: set(),  # Terminal state
    TaskStatus.FAILED: set(),  # Terminal state
    TaskStatus.STALE: {TaskStatus.FAILED},  # Can only fail from stale
}


class TaskEvent(BaseModel):
    """Individual task event."""

    event_type: EventType
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    data: dict[str, Any] = Field(default_factory=dict)
    agent_id: Optional[str] = None
    message: Optional[str] = None

    @field_validator("timestamp", mode="before")
    @classmethod
    def ensure_timezone(cls, v: datetime | str) -> datetime:
        """Ensure timestamp is timezone-aware."""
        if isinstance(v, str):
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        if v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class TaskState(BaseModel):
    """Complete task state tracking."""

    task_id: str
    status: TaskStatus = TaskStatus.PENDING
    agent_id: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    last_heartbeat: Optional[datetime] = None

    # Timing metrics
    time_in_queue: Optional[float] = None  # seconds
    time_processing: Optional[float] = None  # seconds
    total_duration: Optional[float] = None  # seconds

    # Event history
    events: list[TaskEvent] = Field(default_factory=list)

    # Additional metadata
    metadata: dict[str, Any] = Field(default_factory=dict)
    error_message: Optional[str] = None
    error_count: int = 0
    pause_count: int = 0

    @field_validator("created_at", "updated_at", mode="before")
    @classmethod
    def ensure_timezone(cls, v: datetime | str) -> datetime:
        """Ensure timestamps are timezone-aware."""
        if isinstance(v, str):
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        if v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v

    def can_transition_to(self, new_status: TaskStatus) -> bool:
        """Check if transition to new status is valid."""
        return new_status in VALID_TRANSITIONS.get(self.status, set())

    def add_event(self, event: TaskEvent) -> None:
        """Add an event and update state."""
        self.events.append(event)
        self.updated_at = event.timestamp

        # Update last heartbeat
        if event.event_type == EventType.HEARTBEAT:
            self.last_heartbeat = event.timestamp

        # Update agent if provided
        if event.agent_id:
            self.agent_id = event.agent_id

    def transition_to(
        self,
        new_status: TaskStatus,
        event: TaskEvent,
        force: bool = False,
    ) -> None:
        """Transition to a new status."""
        if not force and not self.can_transition_to(new_status):
            raise ValueError(
                f"Invalid transition from {self.status} to {new_status} "
                f"for task {self.task_id}"
            )

        old_status = self.status
        self.status = new_status
        self.add_event(event)

        # Update timestamps based on transition
        now = event.timestamp

        if new_status == TaskStatus.STARTED and not self.started_at:
            self.started_at = now
            if self.created_at:
                self.time_in_queue = (now - self.created_at).total_seconds()

        elif new_status in {TaskStatus.COMPLETED, TaskStatus.FAILED}:
            self.completed_at = now
            if self.started_at:
                self.time_processing = (now - self.started_at).total_seconds()
            if self.created_at:
                self.total_duration = (now - self.created_at).total_seconds()

            # Store error message if failed
            if new_status == TaskStatus.FAILED:
                self.error_count += 1
                if event.message:
                    self.error_message = event.message

        elif new_status == TaskStatus.PAUSED:
            self.pause_count += 1

    def is_stale(self, stale_threshold_seconds: int = 300) -> bool:
        """Check if task is stale (no heartbeat for threshold period)."""
        if self.status not in {TaskStatus.IN_PROGRESS, TaskStatus.PAUSED}:
            return False

        if not self.last_heartbeat:
            # No heartbeat yet, check against started_at or updated_at
            reference_time = self.started_at or self.updated_at
        else:
            reference_time = self.last_heartbeat

        if not reference_time:
            return False

        elapsed = (datetime.now(timezone.utc) - reference_time).total_seconds()
        return elapsed > stale_threshold_seconds

    def get_duration_in_status(self, status: TaskStatus) -> float:
        """Calculate total time spent in a specific status (seconds)."""
        total_seconds = 0.0
        current_start: Optional[datetime] = None

        for event in self.events:
            # Check if we're entering the target status
            if event.event_type.value == status.value.lower():
                current_start = event.timestamp
            # Check if we're leaving (any different status)
            elif current_start is not None:
                total_seconds += (event.timestamp - current_start).total_seconds()
                current_start = None

        # If still in the status, count until now
        if current_start is not None and self.status == status:
            total_seconds += (
                datetime.now(timezone.utc) - current_start
            ).total_seconds()

        return total_seconds

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class TaskFilter(BaseModel):
    """Filter parameters for task queries."""

    status: Optional[TaskStatus] = None
    agent_id: Optional[str] = None
    created_after: Optional[datetime] = None
    created_before: Optional[datetime] = None
    limit: int = Field(default=100, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)


class TaskMetrics(BaseModel):
    """Aggregate metrics for tasks."""

    total_tasks: int
    tasks_by_status: dict[str, int]
    tasks_by_agent: dict[str, int]
    average_queue_time: Optional[float] = None
    average_processing_time: Optional[float] = None
    total_completed: int
    total_failed: int
    success_rate: float
    active_tasks: int


class HealthStatus(BaseModel):
    """Service health status."""

    status: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    tasks_monitored: int
    rabbitmq_connected: bool
    stale_tasks_count: int
    uptime_seconds: float
    memory_usage_mb: Optional[float] = None


class WebSocketMessage(BaseModel):
    """WebSocket message format."""

    type: str  # "task_update", "task_created", "task_completed", "metrics"
    task_id: Optional[str] = None
    data: dict[str, Any]
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}
