package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/33GOD/flume/task-session-manager/pkg/cliconfig"
)

const (
	exitSuccess      = 0
	exitUsageError   = 1
	exitConfigError  = 2
	exitConnectionErr = 3
	exitNotFoundError = 5
)

var (
	version = "1.0.0"
)

// Task represents task status from the monitoring API
type Task struct {
	TaskID             string                 `json:"task_id"`
	Status             string                 `json:"status"`
	AgentType          string                 `json:"agent_type"`
	WorkingDir         string                 `json:"working_dir"`
	Priority           string                 `json:"priority,omitempty"`
	ProgressPercentage int                    `json:"progress_percentage,omitempty"`
	CurrentActivity    string                 `json:"current_activity,omitempty"`
	FilesModified      []string               `json:"files_modified,omitempty"`
	CommandsExecuted   int                    `json:"commands_executed,omitempty"`
	CreatedAt          time.Time              `json:"created_at"`
	UpdatedAt          time.Time              `json:"updated_at"`
	CompletedAt        *time.Time             `json:"completed_at,omitempty"`
	Duration           int64                  `json:"duration_seconds,omitempty"`
	LastError          string                 `json:"last_error,omitempty"`
	Metadata           map[string]interface{} `json:"metadata,omitempty"`
}

// TasksResponse represents the API response for list of tasks
type TasksResponse struct {
	Tasks      []Task `json:"tasks"`
	Total      int    `json:"total"`
	Page       int    `json:"page"`
	PageSize   int    `json:"page_size"`
	TotalPages int    `json:"total_pages"`
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

	subcommand := os.Args[1]

	switch subcommand {
	case "status":
		return cmdStatus()
	case "help", "-h", "--help":
		printHelp()
		return exitSuccess
	case "version", "--version":
		fmt.Printf("flume version %s\n", version)
		return exitSuccess
	default:
		// If it doesn't match a known subcommand, treat it as a task ID for status
		return cmdStatusForTask(subcommand)
	}
}

func cmdStatus() int {
	// Parse flags
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	all := fs.Bool("all", false, "Show all active tasks")
	watch := fs.Bool("watch", false, "Watch status in real-time")
	jsonOutput := fs.Bool("json", false, "Output as JSON")
	statusFilter := fs.String("status", "", "Filter by status")
	fs.Parse(os.Args[2:])

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

	// Get remaining args (task IDs)
	taskIDs := fs.Args()

	if *all {
		return showAllTasks(config, *statusFilter, *jsonOutput, *watch)
	}

	if len(taskIDs) == 0 {
		fmt.Fprintln(os.Stderr, "Error: task-id required or use --all flag")
		fmt.Fprintln(os.Stderr, "Use --help for usage information")
		return exitUsageError
	}

	taskID := taskIDs[0]
	return showTaskStatus(config, taskID, *jsonOutput, *watch)
}

func cmdStatusForTask(taskID string) int {
	config, err := cliconfig.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading configuration: %v\n", err)
		return exitConfigError
	}

	if err := config.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: invalid configuration: %v\n", err)
		return exitConfigError
	}

	return showTaskStatus(config, taskID, false, false)
}

func showTaskStatus(config *cliconfig.CLIConfig, taskID string, jsonOutput, watch bool) int {
	if watch {
		return watchTaskStatus(config, taskID, jsonOutput)
	}

	task, err := fetchTaskStatus(config, taskID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fetching task status: %v\n", err)
		return exitConnectionErr
	}

	if task == nil {
		fmt.Fprintf(os.Stderr, "Task %s not found\n", taskID)
		return exitNotFoundError
	}

	if jsonOutput {
		data, _ := json.MarshalIndent(task, "", "  ")
		fmt.Println(string(data))
	} else {
		printTask(*task, true)
	}

	return exitSuccess
}

func showAllTasks(config *cliconfig.CLIConfig, statusFilter string, jsonOutput, watch bool) int {
	if watch {
		return watchAllTasks(config, statusFilter, jsonOutput)
	}

	tasks, err := fetchAllTasks(config, statusFilter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fetching tasks: %v\n", err)
		return exitConnectionErr
	}

	if len(tasks) == 0 {
		fmt.Print("No active tasks\n")
		return exitSuccess
	}

	if jsonOutput {
		data, _ := json.MarshalIndent(tasks, "", "  ")
		fmt.Println(string(data))
	} else {
		printTasksTable(tasks)
	}

	return exitSuccess
}

func watchTaskStatus(config *cliconfig.CLIConfig, taskID string, jsonOutput bool) int {
	fmt.Printf("Watching task %s (Press Ctrl+C to stop)\n\n", taskID)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		// Clear screen
		if !jsonOutput {
			fmt.Print("\033[H\033[2J")
		}

		task, err := fetchTaskStatus(config, taskID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			time.Sleep(2 * time.Second)
			continue
		}

		if task == nil {
			fmt.Fprintf(os.Stderr, "Task %s not found\n", taskID)
			return exitNotFoundError
		}

		if jsonOutput {
			data, _ := json.MarshalIndent(task, "", "  ")
			fmt.Println(string(data))
		} else {
			fmt.Printf("Last updated: %s\n\n", time.Now().Format("15:04:05"))
			printTask(*task, true)
		}

		<-ticker.C
	}
}

func watchAllTasks(config *cliconfig.CLIConfig, statusFilter string, jsonOutput bool) int {
	fmt.Println("Watching all tasks (Press Ctrl+C to stop)\n")

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		// Clear screen
		if !jsonOutput {
			fmt.Print("\033[H\033[2J")
		}

		tasks, err := fetchAllTasks(config, statusFilter)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			time.Sleep(2 * time.Second)
			continue
		}

		if jsonOutput {
			data, _ := json.MarshalIndent(tasks, "", "  ")
			fmt.Println(string(data))
		} else {
			fmt.Printf("Last updated: %s\n\n", time.Now().Format("15:04:05"))
			if len(tasks) == 0 {
				fmt.Println("No active tasks")
			} else {
				printTasksTable(tasks)
			}
		}

		<-ticker.C
	}
}

func fetchTaskStatus(config *cliconfig.CLIConfig, taskID string) (*Task, error) {
	ctx, cancel := context.WithTimeout(context.Background(), config.Monitoring.Timeout)
	defer cancel()

	url := fmt.Sprintf("%s/tasks/%s", config.Monitoring.APIURL, taskID)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	client := &http.Client{
		Timeout: config.Monitoring.Timeout,
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch task status: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var task Task
	if err := json.NewDecoder(resp.Body).Decode(&task); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &task, nil
}

func fetchAllTasks(config *cliconfig.CLIConfig, statusFilter string) ([]Task, error) {
	ctx, cancel := context.WithTimeout(context.Background(), config.Monitoring.Timeout)
	defer cancel()

	url := fmt.Sprintf("%s/tasks", config.Monitoring.APIURL)
	if statusFilter != "" {
		url += fmt.Sprintf("?status=%s", statusFilter)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	client := &http.Client{
		Timeout: config.Monitoring.Timeout,
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch tasks: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var response TasksResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Tasks, nil
}

func printTask(task Task, detailed bool) {
	// Status with color
	statusColor := getStatusColor(task.Status)
	fmt.Printf("Task: %s\n", task.TaskID)
	fmt.Printf("Status: %s%s%s\n", statusColor, task.Status, colorReset)
	fmt.Printf("Agent: %s\n", task.AgentType)

	if task.ProgressPercentage > 0 {
		fmt.Printf("Progress: %s\n", renderProgressBar(task.ProgressPercentage))
	}

	if task.CurrentActivity != "" {
		fmt.Printf("Current Activity: %s\n", task.CurrentActivity)
	}

	if detailed {
		fmt.Printf("\nDetails:\n")
		fmt.Printf("  Working Directory: %s\n", task.WorkingDir)
		if task.Priority != "" {
			fmt.Printf("  Priority: %s\n", task.Priority)
		}
		fmt.Printf("  Created: %s\n", task.CreatedAt.Format("2006-01-02 15:04:05"))
		fmt.Printf("  Updated: %s\n", task.UpdatedAt.Format("2006-01-02 15:04:05"))

		if task.Duration > 0 {
			fmt.Printf("  Duration: %s\n", formatDuration(time.Duration(task.Duration)*time.Second))
		} else if !task.CreatedAt.IsZero() {
			elapsed := time.Since(task.CreatedAt)
			fmt.Printf("  Elapsed: %s\n", formatDuration(elapsed))
		}

		if len(task.FilesModified) > 0 {
			fmt.Printf("  Files Modified: %d\n", len(task.FilesModified))
			for i, file := range task.FilesModified {
				if i >= 5 {
					fmt.Printf("    ... and %d more\n", len(task.FilesModified)-5)
					break
				}
				fmt.Printf("    - %s\n", file)
			}
		}

		if task.CommandsExecuted > 0 {
			fmt.Printf("  Commands Executed: %d\n", task.CommandsExecuted)
		}

		if task.LastError != "" {
			fmt.Printf("\n  %sLast Error:%s %s\n", colorRed, colorReset, task.LastError)
		}
	}
}

func printTasksTable(tasks []Task) {
	// Print header
	fmt.Printf("%-15s %-12s %-15s %-8s %-20s %s\n",
		"TASK-ID", "STATUS", "AGENT", "PROGRESS", "ACTIVITY", "UPDATED")
	fmt.Println(strings.Repeat("-", 95))

	// Print tasks
	for _, task := range tasks {
		statusStr := fmt.Sprintf("%s%s%s", getStatusColor(task.Status), task.Status, colorReset)
		progress := "-"
		if task.ProgressPercentage > 0 {
			progress = fmt.Sprintf("%d%%", task.ProgressPercentage)
		}

		activity := task.CurrentActivity
		if len(activity) > 20 {
			activity = activity[:17] + "..."
		}
		if activity == "" {
			activity = "-"
		}

		updated := task.UpdatedAt.Format("15:04:05")

		fmt.Printf("%-15s %-22s %-15s %-8s %-20s %s\n",
			truncate(task.TaskID, 15),
			statusStr,
			truncate(task.AgentType, 15),
			progress,
			activity,
			updated,
		)
	}

	fmt.Printf("\nTotal tasks: %d\n", len(tasks))
}

func renderProgressBar(percentage int) string {
	barWidth := 30
	filled := int(float64(barWidth) * float64(percentage) / 100.0)
	bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)
	return fmt.Sprintf("[%s] %d%%", bar, percentage)
}

func getStatusColor(status string) string {
	switch strings.ToLower(status) {
	case "assigned":
		return colorYellow
	case "started", "in_progress":
		return colorBlue
	case "completed":
		return colorGreen
	case "failed":
		return colorRed
	case "paused":
		return colorMagenta
	default:
		return ""
	}
}

func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	} else if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	} else if d < 24*time.Hour {
		hours := int(d.Hours())
		minutes := int(d.Minutes()) % 60
		return fmt.Sprintf("%dh %dm", hours, minutes)
	} else {
		days := int(d.Hours() / 24)
		hours := int(d.Hours()) % 24
		return fmt.Sprintf("%dd %dh", days, hours)
	}
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

// ANSI color codes
const (
	colorReset   = "\033[0m"
	colorRed     = "\033[31m"
	colorGreen   = "\033[32m"
	colorYellow  = "\033[33m"
	colorBlue    = "\033[34m"
	colorMagenta = "\033[35m"
)

func printHelp() {
	fmt.Printf(`flume - Task lifecycle monitoring and status

USAGE:
    flume status [task-id] [options]
    flume <task-id>                 # Shorthand for status

OPTIONS:
    --all                Show all active tasks
    --status <status>    Filter tasks by status (assigned, started, in_progress, completed, failed, paused)
    --watch              Update status in real-time (every 2 seconds)
    --json               Output as JSON
    -h, --help           Show this help message
    --version            Show version information

EXAMPLES:
    # Check status of specific task
    flume status TASK-001
    flume TASK-001                    # Shorthand

    # Show all active tasks
    flume status --all

    # Watch task in real-time
    flume status TASK-001 --watch

    # Show all in-progress tasks
    flume status --all --status in_progress

    # Get status as JSON
    flume status TASK-001 --json

    # Watch all tasks
    flume status --all --watch

EXIT CODES:
    0  Success
    1  Usage error
    2  Configuration error
    3  Connection error (cannot reach monitoring API)
    5  Task not found

CONFIGURATION:
    Configuration is loaded from ~/.config/flume/config.yaml
    See documentation for configuration options.

    Environment variables:
        FLUME_API_URL        - Override monitoring API URL
        FLUME_WS_URL         - Override WebSocket URL
        FLUME_CONFIG_PATH    - Override config file path
`)
}
