package events

import "time"

// TaskLifecycleAssigned represents the incoming assignment event
type TaskLifecycleAssigned struct {
	TaskID        string            `json:"task_id"`
	WorkingDir    string            `json:"working_dir"`
	AgentType     string            `json:"agent_type"` // e.g., "claude-code", "gemini-cli"
	Command       string            `json:"command,omitempty"`
	Environment   map[string]string `json:"environment,omitempty"`
	Priority      string            `json:"priority,omitempty"`
	CorrelationID string            `json:"correlation_id"`
	Timestamp     time.Time         `json:"timestamp"`
	Metadata      map[string]any    `json:"metadata,omitempty"`
}

// TaskLifecycleStarted represents the session started event
type TaskLifecycleStarted struct {
	TaskID          string            `json:"task_id"`
	SessionID       string            `json:"session_id"`
	SessionManager  string            `json:"session_manager"` // "tmux" or "zellij"
	AgentPID        int               `json:"agent_pid"`
	AgentType       string            `json:"agent_type"`
	WorkingDir      string            `json:"working_dir"`
	StartedAt       time.Time         `json:"started_at"`
	CorrelationID   string            `json:"correlation_id"`
	ParentEventID   string            `json:"parent_event_id"`
	Metadata        map[string]any    `json:"metadata,omitempty"`
}

// TaskLifecycleFailed represents a failed session creation event
type TaskLifecycleFailed struct {
	TaskID        string         `json:"task_id"`
	Reason        string         `json:"reason"`
	ErrorDetails  string         `json:"error_details"`
	FailedAt      time.Time      `json:"failed_at"`
	CorrelationID string         `json:"correlation_id"`
	ParentEventID string         `json:"parent_event_id"`
	Metadata      map[string]any `json:"metadata,omitempty"`
}

// EventEnvelope wraps events with routing metadata
type EventEnvelope struct {
	EventType     string    `json:"event_type"`
	RoutingKey    string    `json:"routing_key"`
	CorrelationID string    `json:"correlation_id"`
	Timestamp     time.Time `json:"timestamp"`
	Payload       any       `json:"payload"`
}
