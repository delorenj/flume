package events

import "time"

// TaskLifecycleCompleted represents a completed task event
type TaskLifecycleCompleted struct {
	TaskID        string         `json:"task_id"`
	Summary       string         `json:"summary"`
	CompletedAt   time.Time      `json:"completed_at"`
	Duration      int64          `json:"duration_seconds,omitempty"` // Total duration in seconds
	FilesModified []string       `json:"files_modified,omitempty"`
	CorrelationID string         `json:"correlation_id"`
	ParentEventID string         `json:"parent_event_id"`
	Metadata      map[string]any `json:"metadata,omitempty"`
}

// TaskLifecyclePaused represents a paused task event
type TaskLifecyclePaused struct {
	TaskID        string         `json:"task_id"`
	Reason        string         `json:"reason"`
	PausedAt      time.Time      `json:"paused_at"`
	CorrelationID string         `json:"correlation_id"`
	ParentEventID string         `json:"parent_event_id"`
	Metadata      map[string]any `json:"metadata,omitempty"`
}

// TaskLifecycleInProgress represents a progress update event
type TaskLifecycleInProgress struct {
	TaskID             string         `json:"task_id"`
	ProgressPercentage int            `json:"progress_percentage"`
	CurrentActivity    string         `json:"current_activity"`
	FilesModified      []string       `json:"files_modified,omitempty"`
	CommandsExecuted   int            `json:"commands_executed,omitempty"`
	ElapsedTimeSeconds int64          `json:"elapsed_time_seconds"`
	UpdatedAt          time.Time      `json:"updated_at"`
	CorrelationID      string         `json:"correlation_id"`
	ParentEventID      string         `json:"parent_event_id"`
	Metadata           map[string]any `json:"metadata,omitempty"`
}
