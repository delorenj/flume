package session

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/33GOD/flume/task-session-manager/internal/config"
	"github.com/33GOD/flume/task-session-manager/pkg/events"
	"github.com/rs/zerolog"
)

// Manager represents the available session managers
type ManagerType string

const (
	Zellij ManagerType = "zellij"
	Tmux   ManagerType = "tmux"
)

// Manager handles terminal session creation and management
type Manager struct {
	cfg          *config.Config
	logger       zerolog.Logger
	managerType  ManagerType
	managerAvail map[ManagerType]bool
}

// SessionInfo contains information about a created session
type SessionInfo struct {
	SessionID      string
	SessionManager ManagerType
	AgentPID       int
	Command        string
	WorkingDir     string
}

// New creates a new session manager
func New(cfg *config.Config, logger zerolog.Logger) (*Manager, error) {
	m := &Manager{
		cfg:          cfg,
		logger:       logger.With().Str("component", "session_manager").Logger(),
		managerAvail: make(map[ManagerType]bool),
	}

	// Check which session managers are available
	m.managerAvail[Zellij] = m.isCommandAvailable("zellij")
	m.managerAvail[Tmux] = m.isCommandAvailable("tmux")

	m.logger.Info().
		Bool("zellij_available", m.managerAvail[Zellij]).
		Bool("tmux_available", m.managerAvail[Tmux]).
		Msg("Detected available session managers")

	// Determine which manager to use
	preferred := ManagerType(cfg.Session.PreferredManager)
	if m.managerAvail[preferred] {
		m.managerType = preferred
	} else if m.managerAvail[Zellij] {
		m.managerType = Zellij
		m.logger.Warn().Msgf("Preferred manager %s not available, using zellij", preferred)
	} else if m.managerAvail[Tmux] {
		m.managerType = Tmux
		m.logger.Warn().Msgf("Preferred manager %s not available, using tmux", preferred)
	} else {
		return nil, fmt.Errorf("no session manager (tmux or zellij) available on system")
	}

	m.logger.Info().Str("manager", string(m.managerType)).Msg("Session manager initialized")
	return m, nil
}

// CreateSession creates a new terminal session for a task
func (m *Manager) CreateSession(ctx context.Context, event *events.TaskLifecycleAssigned) (*SessionInfo, error) {
	log := m.logger.With().
		Str("task_id", event.TaskID).
		Str("agent_type", event.AgentType).
		Logger()

	log.Info().Msg("Creating terminal session")

	// Determine session name
	sessionName := fmt.Sprintf("task-%s", event.TaskID)

	// Determine working directory
	workDir := event.WorkingDir
	if workDir == "" {
		workDir = m.cfg.Session.DefaultWorkDir
	}

	// Validate working directory
	if _, err := os.Stat(workDir); os.IsNotExist(err) {
		return nil, fmt.Errorf("working directory does not exist: %s", workDir)
	}

	// Determine agent command
	agentCmd := m.getAgentCommand(event.AgentType)
	if event.Command != "" {
		agentCmd = event.Command
	}

	log.Info().
		Str("session_name", sessionName).
		Str("work_dir", workDir).
		Str("agent_cmd", agentCmd).
		Str("manager", string(m.managerType)).
		Msg("Session configuration")

	// Create session based on manager type
	var info *SessionInfo
	var err error

	switch m.managerType {
	case Zellij:
		info, err = m.createZellijSession(ctx, sessionName, workDir, agentCmd, event.Environment)
	case Tmux:
		info, err = m.createTmuxSession(ctx, sessionName, workDir, agentCmd, event.Environment)
	default:
		return nil, fmt.Errorf("unsupported session manager: %s", m.managerType)
	}

	if err != nil {
		log.Error().Err(err).Msg("Failed to create session")
		return nil, err
	}

	log.Info().
		Str("session_id", info.SessionID).
		Int("agent_pid", info.AgentPID).
		Msg("Session created successfully")

	return info, nil
}

// createZellijSession creates a zellij session
func (m *Manager) createZellijSession(ctx context.Context, name, workDir, command string, env map[string]string) (*SessionInfo, error) {
	// Create zellij session in detached mode
	cmd := exec.CommandContext(ctx, "zellij",
		"--session", name,
		"options", "--default-cwd", workDir,
	)

	// Set environment variables
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to create zellij session: %w (stderr: %s)", err, stderr.String())
	}

	// Start the agent command in the session
	runCmd := exec.CommandContext(ctx, "zellij",
		"--session", name,
		"run", "--",
		"sh", "-c", command,
	)
	runCmd.Dir = workDir
	runCmd.Env = cmd.Env

	if err := runCmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start agent in zellij session: %w", err)
	}

	// Get the PID (this is the zellij process, not the actual agent)
	pid := runCmd.Process.Pid

	// Try to find the actual agent PID
	time.Sleep(1 * time.Second)
	actualPID, err := m.findProcessPID(name, command)
	if err == nil && actualPID > 0 {
		pid = actualPID
	}

	return &SessionInfo{
		SessionID:      name,
		SessionManager: Zellij,
		AgentPID:       pid,
		Command:        command,
		WorkingDir:     workDir,
	}, nil
}

// createTmuxSession creates a tmux session
func (m *Manager) createTmuxSession(ctx context.Context, name, workDir, command string, env map[string]string) (*SessionInfo, error) {
	// Create tmux session in detached mode
	cmd := exec.CommandContext(ctx, "tmux",
		"new-session",
		"-d",
		"-s", name,
		"-c", workDir,
		command,
	)

	// Set environment variables
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to create tmux session: %w (stderr: %s)", err, stderr.String())
	}

	// Get the PID of the process running in the session
	time.Sleep(1 * time.Second)
	pid, err := m.getTmuxPanePID(name)
	if err != nil {
		// Fallback to finding by process name
		pid, _ = m.findProcessPID(name, command)
	}

	return &SessionInfo{
		SessionID:      name,
		SessionManager: Tmux,
		AgentPID:       pid,
		Command:        command,
		WorkingDir:     workDir,
	}, nil
}

// getTmuxPanePID gets the PID of a process in a tmux pane
func (m *Manager) getTmuxPanePID(sessionName string) (int, error) {
	cmd := exec.Command("tmux", "list-panes", "-t", sessionName, "-F", "#{pane_pid}")
	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}

	pidStr := strings.TrimSpace(string(output))
	return strconv.Atoi(pidStr)
}

// findProcessPID attempts to find a process PID by command name
func (m *Manager) findProcessPID(sessionName, command string) (int, error) {
	// Extract the base command (first word)
	cmdParts := strings.Fields(command)
	if len(cmdParts) == 0 {
		return 0, fmt.Errorf("empty command")
	}
	baseCmd := cmdParts[0]

	// Use pgrep to find the process
	cmd := exec.Command("pgrep", "-f", baseCmd)
	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return 0, fmt.Errorf("no process found")
	}

	// Return the first PID found
	return strconv.Atoi(lines[0])
}

// getAgentCommand returns the command to execute for a given agent type
func (m *Manager) getAgentCommand(agentType string) string {
	if cmd, ok := m.cfg.AgentCommands[agentType]; ok {
		return cmd
	}
	return m.cfg.AgentCommands["default"]
}

// isCommandAvailable checks if a command is available in PATH
func (m *Manager) isCommandAvailable(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// ListSessions lists all active sessions
func (m *Manager) ListSessions(ctx context.Context) ([]string, error) {
	var cmd *exec.Cmd
	switch m.managerType {
	case Zellij:
		cmd = exec.CommandContext(ctx, "zellij", "list-sessions")
	case Tmux:
		cmd = exec.CommandContext(ctx, "tmux", "list-sessions", "-F", "#{session_name}")
	default:
		return nil, fmt.Errorf("unsupported session manager")
	}

	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	sessions := strings.Split(strings.TrimSpace(string(output)), "\n")
	return sessions, nil
}

// KillSession terminates a session
func (m *Manager) KillSession(ctx context.Context, sessionName string) error {
	var cmd *exec.Cmd
	switch m.managerType {
	case Zellij:
		cmd = exec.CommandContext(ctx, "zellij", "delete-session", sessionName)
	case Tmux:
		cmd = exec.CommandContext(ctx, "tmux", "kill-session", "-t", sessionName)
	default:
		return fmt.Errorf("unsupported session manager")
	}

	return cmd.Run()
}
