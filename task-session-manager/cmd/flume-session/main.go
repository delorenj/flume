package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/33GOD/flume/task-session-manager/pkg/cliconfig"
)

const (
	exitSuccess       = 0
	exitUsageError    = 1
	exitConfigError   = 2
	exitSessionError  = 4
	exitNotFoundError = 5
)

var (
	version = "1.0.0"
)

type SessionInfo struct {
	Name      string
	TaskID    string
	Manager   string
	Created   time.Time
	IsStale   bool
	PIDs      []int
	Attached  bool
	WindowCount int
}

func main() {
	os.Exit(run())
}

func run() int {
	// Parse subcommand
	if len(os.Args) < 2 {
		printHelp()
		return exitUsageError
	}

	// Load configuration
	config, err := cliconfig.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading configuration: %v\n", err)
		return exitConfigError
	}

	if err := config.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: invalid configuration: %v\n", err)
		return exitConfigError
	}

	subcommand := os.Args[1]

	switch subcommand {
	case "list", "ls":
		return cmdList(config)
	case "attach", "a":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "Error: task-id required for attach command")
			return exitUsageError
		}
		return cmdAttach(config, os.Args[2])
	case "kill", "k":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "Error: task-id required for kill command")
			return exitUsageError
		}
		return cmdKill(config, os.Args[2])
	case "cleanup":
		return cmdCleanup(config)
	case "help", "-h", "--help":
		printHelp()
		return exitSuccess
	case "version", "--version":
		fmt.Printf("flume-session version %s\n", version)
		return exitSuccess
	default:
		fmt.Fprintf(os.Stderr, "Error: unknown subcommand '%s'\n", subcommand)
		printHelp()
		return exitUsageError
	}
}

func cmdList(config *cliconfig.CLIConfig) int {
	ctx := context.Background()
	sessions, err := listSessions(ctx, config.Session.Manager)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error listing sessions: %v\n", err)
		return exitSessionError
	}

	if len(sessions) == 0 {
		fmt.Println("No active sessions")
		return exitSuccess
	}

	// Print header
	fmt.Printf("%-20s %-15s %-10s %-8s %-10s %s\n",
		"SESSION", "TASK-ID", "MANAGER", "WINDOWS", "STALE", "CREATED")
	fmt.Println(strings.Repeat("-", 85))

	// Print sessions
	for _, session := range sessions {
		staleStr := "no"
		if session.IsStale {
			staleStr = "yes"
		}

		created := session.Created.Format("2006-01-02")
		if session.Created.IsZero() {
			created = "unknown"
		}

		fmt.Printf("%-20s %-15s %-10s %-8d %-10s %s\n",
			session.Name,
			session.TaskID,
			session.Manager,
			session.WindowCount,
			staleStr,
			created,
		)
	}

	fmt.Printf("\nTotal sessions: %d\n", len(sessions))
	return exitSuccess
}

func cmdAttach(config *cliconfig.CLIConfig, taskID string) int {
	// Construct session name
	sessionName := config.Session.SessionPrefix + taskID

	// Check if session exists
	ctx := context.Background()
	sessions, err := listSessions(ctx, config.Session.Manager)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error checking sessions: %v\n", err)
		return exitSessionError
	}

	found := false
	for _, session := range sessions {
		if session.Name == sessionName || session.TaskID == taskID {
			found = true
			sessionName = session.Name
			break
		}
	}

	if !found {
		fmt.Fprintf(os.Stderr, "Error: session for task %s not found\n", taskID)
		fmt.Fprintln(os.Stderr, "Use 'flume-session list' to see available sessions")
		return exitNotFoundError
	}

	// Attach to session
	var cmd *exec.Cmd
	switch config.Session.Manager {
	case "zellij":
		cmd = exec.Command("zellij", "attach", sessionName)
	case "tmux":
		cmd = exec.Command("tmux", "attach-session", "-t", sessionName)
	default:
		fmt.Fprintf(os.Stderr, "Error: unsupported session manager: %s\n", config.Session.Manager)
		return exitConfigError
	}

	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	fmt.Printf("Attaching to session: %s\n", sessionName)
	fmt.Println("(Press Ctrl+b d for tmux, or Ctrl+g d for zellij to detach)")

	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error attaching to session: %v\n", err)
		return exitSessionError
	}

	return exitSuccess
}

func cmdKill(config *cliconfig.CLIConfig, taskID string) int {
	// Construct session name
	sessionName := config.Session.SessionPrefix + taskID

	// Check if session exists
	ctx := context.Background()
	sessions, err := listSessions(ctx, config.Session.Manager)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error checking sessions: %v\n", err)
		return exitSessionError
	}

	found := false
	for _, session := range sessions {
		if session.Name == sessionName || session.TaskID == taskID {
			found = true
			sessionName = session.Name
			break
		}
	}

	if !found {
		fmt.Fprintf(os.Stderr, "Error: session for task %s not found\n", taskID)
		return exitNotFoundError
	}

	// Kill session
	var cmd *exec.Cmd
	switch config.Session.Manager {
	case "zellij":
		cmd = exec.Command("zellij", "delete-session", sessionName)
	case "tmux":
		cmd = exec.Command("tmux", "kill-session", "-t", sessionName)
	default:
		fmt.Fprintf(os.Stderr, "Error: unsupported session manager: %s\n", config.Session.Manager)
		return exitConfigError
	}

	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error killing session: %v\n", err)
		return exitSessionError
	}

	fmt.Printf("Session %s killed successfully\n", sessionName)
	return exitSuccess
}

func cmdCleanup(config *cliconfig.CLIConfig) int {
	// Parse flags
	fs := flag.NewFlagSet("cleanup", flag.ExitOnError)
	staleThreshold := fs.Duration("stale-threshold", config.Session.StaleThreshold, "Age threshold for stale sessions")
	force := fs.Bool("force", false, "Force cleanup without confirmation")
	fs.Parse(os.Args[2:])

	ctx := context.Background()
	sessions, err := listSessions(ctx, config.Session.Manager)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error listing sessions: %v\n", err)
		return exitSessionError
	}

	// Find stale sessions
	var staleSessions []SessionInfo
	now := time.Now()
	for _, session := range sessions {
		if !session.Created.IsZero() {
			age := now.Sub(session.Created)
			if age > *staleThreshold {
				session.IsStale = true
				staleSessions = append(staleSessions, session)
			}
		}
	}

	if len(staleSessions) == 0 {
		fmt.Println("No stale sessions found")
		return exitSuccess
	}

	// Print stale sessions
	fmt.Printf("Found %d stale session(s):\n", len(staleSessions))
	for _, session := range staleSessions {
		age := now.Sub(session.Created)
		fmt.Printf("  - %s (age: %s)\n", session.Name, formatDuration(age))
	}

	// Confirm cleanup
	if !*force {
		fmt.Print("\nProceed with cleanup? [y/N]: ")
		var response string
		fmt.Scanln(&response)
		if strings.ToLower(response) != "y" && strings.ToLower(response) != "yes" {
			fmt.Println("Cleanup cancelled")
			return exitSuccess
		}
	}

	// Kill stale sessions
	cleaned := 0
	failed := 0
	for _, session := range staleSessions {
		var cmd *exec.Cmd
		switch config.Session.Manager {
		case "zellij":
			cmd = exec.Command("zellij", "delete-session", session.Name)
		case "tmux":
			cmd = exec.Command("tmux", "kill-session", "-t", session.Name)
		}

		if err := cmd.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to kill session %s: %v\n", session.Name, err)
			failed++
		} else {
			fmt.Printf("Cleaned up session: %s\n", session.Name)
			cleaned++
		}
	}

	fmt.Printf("\nCleanup complete: %d cleaned, %d failed\n", cleaned, failed)
	return exitSuccess
}

func listSessions(ctx context.Context, manager string) ([]SessionInfo, error) {
	var cmd *exec.Cmd
	switch manager {
	case "zellij":
		cmd = exec.CommandContext(ctx, "zellij", "list-sessions", "-n")
	case "tmux":
		cmd = exec.CommandContext(ctx, "tmux", "list-sessions", "-F", "#{session_name}|#{session_created}|#{session_windows}")
	default:
		return nil, fmt.Errorf("unsupported session manager: %s", manager)
	}

	output, err := cmd.Output()
	if err != nil {
		// If no sessions exist, that's not an error
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return []SessionInfo{}, nil
		}
		return nil, err
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	var sessions []SessionInfo

	for _, line := range lines {
		if line == "" {
			continue
		}

		session := SessionInfo{
			Manager: manager,
		}

		if manager == "tmux" {
			parts := strings.Split(line, "|")
			if len(parts) >= 1 {
				session.Name = parts[0]
			}
			if len(parts) >= 2 {
				if timestamp, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
					session.Created = time.Unix(timestamp, 0)
				}
			}
			if len(parts) >= 3 {
				if windows, err := strconv.Atoi(parts[2]); err == nil {
					session.WindowCount = windows
				}
			}
		} else {
			// Zellij format
			session.Name = line
			session.WindowCount = 1 // Zellij doesn't provide this info easily
		}

		// Extract task ID from session name
		if strings.HasPrefix(session.Name, "task-") {
			session.TaskID = strings.TrimPrefix(session.Name, "task-")
		} else {
			session.TaskID = session.Name
		}

		// Check if session has active processes
		if pids, err := getSessionPIDs(session.Name, manager); err == nil {
			session.PIDs = pids
		}

		sessions = append(sessions, session)
	}

	return sessions, nil
}

func getSessionPIDs(sessionName, manager string) ([]int, error) {
	var cmd *exec.Cmd
	switch manager {
	case "tmux":
		cmd = exec.Command("tmux", "list-panes", "-t", sessionName, "-F", "#{pane_pid}")
	case "zellij":
		// Zellij doesn't provide easy PID access
		return []int{}, nil
	default:
		return nil, fmt.Errorf("unsupported manager")
	}

	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	var pids []int
	for _, line := range lines {
		if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil {
			pids = append(pids, pid)
		}
	}

	return pids, nil
}

func isProcessRunning(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}

	// Send signal 0 to check if process exists
	err = process.Signal(syscall.Signal(0))
	return err == nil
}

func formatDuration(d time.Duration) string {
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	} else if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	} else {
		days := int(d.Hours() / 24)
		return fmt.Sprintf("%dd", days)
	}
}

func printHelp() {
	fmt.Printf(`flume-session - Manage task execution sessions

USAGE:
    flume-session <subcommand> [options]

SUBCOMMANDS:
    list, ls                  List all active sessions
    attach, a <task-id>       Attach to a session
    kill, k <task-id>         Kill a session forcefully
    cleanup                   Clean up stale sessions
    help                      Show this help message
    version                   Show version information

EXAMPLES:
    # List all sessions
    flume-session list

    # Attach to a session
    flume-session attach TASK-001

    # Kill a session
    flume-session kill TASK-002

    # Cleanup stale sessions (older than 24h by default)
    flume-session cleanup

    # Cleanup with custom threshold
    flume-session cleanup --stale-threshold 48h --force

CLEANUP OPTIONS:
    --stale-threshold <duration>   Age threshold (e.g., 24h, 7d) (default: 24h)
    --force                        Skip confirmation prompt

EXIT CODES:
    0  Success
    1  Usage error
    2  Configuration error
    4  Session error
    5  Session not found

CONFIGURATION:
    Configuration is loaded from ~/.config/flume/config.yaml
    See documentation for configuration options.

    Environment variables:
        FLUME_SESSION_MANAGER - Override session manager (zellij or tmux)
        FLUME_CONFIG_PATH     - Override config file path
`)
}
