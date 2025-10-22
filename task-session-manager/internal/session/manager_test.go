package session

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/33GOD/cortex/task-session-manager/internal/config"
	"github.com/33GOD/cortex/task-session-manager/pkg/events"
	"github.com/rs/zerolog"
)

func TestIsCommandAvailable(t *testing.T) {
	cfg := &config.Config{
		Session: config.SessionConfig{
			PreferredManager: "tmux",
		},
		AgentCommands: map[string]string{
			"default": "bash",
		},
	}
	logger := zerolog.Nop()

	m, err := New(cfg, logger)
	if err != nil && err.Error() != "no session manager (tmux or zellij) available on system" {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Test common commands
	if !m.isCommandAvailable("ls") {
		t.Error("ls should be available")
	}
	if m.isCommandAvailable("this-command-definitely-does-not-exist-12345") {
		t.Error("Non-existent command should not be available")
	}
}

func TestGetAgentCommand(t *testing.T) {
	tests := []struct {
		name      string
		agentType string
		expected  string
	}{
		{"claude agent", "claude-code", "claude"},
		{"gemini agent", "gemini-cli", "gemini"},
		{"unknown agent", "unknown-agent", "bash"},
	}

	cfg := &config.Config{
		Session: config.SessionConfig{
			PreferredManager: "tmux",
		},
		AgentCommands: map[string]string{
			"claude-code": "claude",
			"gemini-cli":  "gemini",
			"default":     "bash",
		},
	}
	logger := zerolog.Nop()

	m := &Manager{
		cfg:    cfg,
		logger: logger,
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := m.getAgentCommand(tt.agentType)
			if result != tt.expected {
				t.Errorf("getAgentCommand(%s) = %s; want %s", tt.agentType, result, tt.expected)
			}
		})
	}
}

func TestCreateSession_WorkingDirValidation(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available, skipping test")
	}

	cfg := &config.Config{
		Session: config.SessionConfig{
			PreferredManager: "tmux",
			DefaultWorkDir:   "/tmp",
			StartupTimeout:   30 * time.Second,
		},
		AgentCommands: map[string]string{
			"default": "echo",
		},
	}
	logger := zerolog.Nop()

	m, err := New(cfg, logger)
	if err != nil {
		t.Fatalf("Failed to create manager: %v", err)
	}

	event := &events.TaskLifecycleAssigned{
		TaskID:        "test-invalid-dir",
		WorkingDir:    "/this/directory/does/not/exist/at/all",
		AgentType:     "test",
		CorrelationID: "test-corr",
		Timestamp:     time.Now(),
	}

	ctx := context.Background()
	_, err = m.CreateSession(ctx, event)
	if err == nil {
		t.Error("Expected error for non-existent working directory")
	}
}

func TestCreateSession_DefaultWorkingDir(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available, skipping test")
	}

	tmpDir := os.TempDir()
	cfg := &config.Config{
		Session: config.SessionConfig{
			PreferredManager: "tmux",
			DefaultWorkDir:   tmpDir,
			StartupTimeout:   30 * time.Second,
		},
		AgentCommands: map[string]string{
			"default": "echo test",
		},
	}
	logger := zerolog.Nop()

	m, err := New(cfg, logger)
	if err != nil {
		t.Fatalf("Failed to create manager: %v", err)
	}

	// Use a unique task ID to avoid conflicts
	taskID := "test-default-dir-" + time.Now().Format("20060102150405")
	event := &events.TaskLifecycleAssigned{
		TaskID:        taskID,
		WorkingDir:    "", // Empty should use default
		AgentType:     "test",
		CorrelationID: "test-corr",
		Timestamp:     time.Now(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	info, err := m.CreateSession(ctx, event)
	if err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	defer m.KillSession(context.Background(), info.SessionID)

	if info.WorkingDir != tmpDir {
		t.Errorf("Expected working dir %s, got %s", tmpDir, info.WorkingDir)
	}
}

func BenchmarkCreateSession(b *testing.B) {
	if _, err := exec.LookPath("tmux"); err != nil {
		b.Skip("tmux not available, skipping benchmark")
	}

	cfg := &config.Config{
		Session: config.SessionConfig{
			PreferredManager: "tmux",
			DefaultWorkDir:   os.TempDir(),
			StartupTimeout:   30 * time.Second,
		},
		AgentCommands: map[string]string{
			"default": "sleep 1",
		},
	}
	logger := zerolog.Nop()

	m, err := New(cfg, logger)
	if err != nil {
		b.Fatalf("Failed to create manager: %v", err)
	}

	ctx := context.Background()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		event := &events.TaskLifecycleAssigned{
			TaskID:        "bench-task-" + time.Now().Format("20060102150405.000000"),
			WorkingDir:    os.TempDir(),
			AgentType:     "test",
			CorrelationID: "bench-corr",
			Timestamp:     time.Now(),
		}

		info, err := m.CreateSession(ctx, event)
		if err != nil {
			b.Fatalf("Failed to create session: %v", err)
		}

		// Clean up
		m.KillSession(ctx, info.SessionID)
	}
}
