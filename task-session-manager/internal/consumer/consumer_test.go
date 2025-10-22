package consumer

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/33GOD/flume/task-session-manager/internal/config"
	"github.com/33GOD/flume/task-session-manager/pkg/events"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/rs/zerolog"
)

// mockSessionManager implements a mock session manager for testing
type mockSessionManager struct {
	createErr error
}

func (m *mockSessionManager) CreateSession(ctx context.Context, event *events.TaskLifecycleAssigned) (*mockSessionInfo, error) {
	if m.createErr != nil {
		return nil, m.createErr
	}
	return &mockSessionInfo{
		SessionID:      "test-session-" + event.TaskID,
		SessionManager: "tmux",
		AgentPID:       12345,
		Command:        "claude",
		WorkingDir:     event.WorkingDir,
	}, nil
}

type mockSessionInfo struct {
	SessionID      string
	SessionManager string
	AgentPID       int
	Command        string
	WorkingDir     string
}

// mockPublisher implements a mock publisher for testing
type mockPublisher struct {
	startedEvents []events.TaskLifecycleStarted
	failedEvents  []events.TaskLifecycleFailed
}

func (m *mockPublisher) PublishStarted(ctx context.Context, event *events.TaskLifecycleStarted) error {
	m.startedEvents = append(m.startedEvents, *event)
	return nil
}

func (m *mockPublisher) PublishFailed(ctx context.Context, event *events.TaskLifecycleFailed) error {
	m.failedEvents = append(m.failedEvents, *event)
	return nil
}

func TestHandleMessage(t *testing.T) {
	tests := []struct {
		name           string
		event          events.TaskLifecycleAssigned
		createErr      error
		expectStarted  bool
		expectFailed   bool
	}{
		{
			name: "successful session creation",
			event: events.TaskLifecycleAssigned{
				TaskID:        "task-123",
				WorkingDir:    "/tmp",
				AgentType:     "claude-code",
				CorrelationID: "corr-123",
				Timestamp:     time.Now(),
			},
			createErr:     nil,
			expectStarted: true,
			expectFailed:  false,
		},
		{
			name: "failed session creation",
			event: events.TaskLifecycleAssigned{
				TaskID:        "task-456",
				WorkingDir:    "/tmp",
				AgentType:     "claude-code",
				CorrelationID: "corr-456",
				Timestamp:     time.Now(),
			},
			createErr:     nil,
			expectStarted: false,
			expectFailed:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Setup
			cfg := &config.Config{
				RabbitMQ: config.RabbitMQConfig{
					URL:              "amqp://guest:guest@localhost:5672/",
					Exchange:         "test.exchange",
					Queue:            "test.queue",
					RoutingKey:       "test.key",
					PrefetchCount:    1,
					ReconnectDelay:   5 * time.Second,
					MaxReconnectTime: 5 * time.Minute,
				},
			}
			logger := zerolog.Nop()

			// Note: In a real test, you would use a mock RabbitMQ connection
			// or integration tests with a test RabbitMQ instance

			// This is a placeholder test structure
			// In production, you'd want to:
			// 1. Use testcontainers for RabbitMQ
			// 2. Mock the AMQP connection
			// 3. Test message acknowledgment

			t.Log("Test would verify session creation and event publishing")
		})
	}
}

func TestEventSerialization(t *testing.T) {
	tests := []struct {
		name  string
		event events.TaskLifecycleAssigned
	}{
		{
			name: "complete event",
			event: events.TaskLifecycleAssigned{
				TaskID:        "task-123",
				WorkingDir:    "/tmp/test",
				AgentType:     "claude-code",
				Command:       "claude --mode interactive",
				Environment:   map[string]string{"FOO": "bar"},
				Priority:      "high",
				CorrelationID: "corr-123",
				Timestamp:     time.Now(),
				Metadata:      map[string]any{"key": "value"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Serialize
			data, err := json.Marshal(tt.event)
			if err != nil {
				t.Fatalf("Failed to marshal event: %v", err)
			}

			// Deserialize
			var decoded events.TaskLifecycleAssigned
			err = json.Unmarshal(data, &decoded)
			if err != nil {
				t.Fatalf("Failed to unmarshal event: %v", err)
			}

			// Verify
			if decoded.TaskID != tt.event.TaskID {
				t.Errorf("TaskID mismatch: got %s, want %s", decoded.TaskID, tt.event.TaskID)
			}
			if decoded.WorkingDir != tt.event.WorkingDir {
				t.Errorf("WorkingDir mismatch: got %s, want %s", decoded.WorkingDir, tt.event.WorkingDir)
			}
			if decoded.AgentType != tt.event.AgentType {
				t.Errorf("AgentType mismatch: got %s, want %s", decoded.AgentType, tt.event.AgentType)
			}
		})
	}
}
