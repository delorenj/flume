package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/33GOD/flume/task-session-manager/pkg/cliconfig"
	"github.com/33GOD/flume/task-session-manager/pkg/events"
	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"
)

const (
	exitSuccess       = 0
	exitUsageError    = 1
	exitConfigError   = 2
	exitConnectionErr = 3
	exitPublishErr    = 4
)

var (
	version = "1.0.0"
)

type flags struct {
	taskID   string
	status   string
	summary  string
	errMsg   string
	metadata string
	verbose  bool
	helpFlag bool
	version  bool
}

func main() {
	os.Exit(run())
}

func run() int {
	var f flags

	// Define flags
	flag.StringVar(&f.taskID, "task-id", "", "Task identifier (required)")
	flag.StringVar(&f.status, "status", "completed", "Task status: completed, failed, paused")
	flag.StringVar(&f.summary, "summary", "", "Completion summary")
	flag.StringVar(&f.errMsg, "error", "", "Error message (for failed status)")
	flag.StringVar(&f.metadata, "metadata", "{}", "Additional JSON metadata")
	flag.BoolVar(&f.verbose, "verbose", false, "Enable verbose output")
	flag.BoolVar(&f.verbose, "v", false, "Enable verbose output (shorthand)")
	flag.BoolVar(&f.helpFlag, "help", false, "Show help message")
	flag.BoolVar(&f.helpFlag, "h", false, "Show help message (shorthand)")
	flag.BoolVar(&f.version, "version", false, "Show version")

	flag.Parse()

	// Handle version flag
	if f.version {
		fmt.Printf("flume-complete version %s\n", version)
		return exitSuccess
	}

	// Handle help flag
	if f.helpFlag {
		printHelp()
		return exitSuccess
	}

	// Validate required flags
	if f.taskID == "" {
		fmt.Fprintln(os.Stderr, "Error: --task-id is required")
		fmt.Fprintln(os.Stderr, "Use --help for usage information")
		return exitUsageError
	}

	// Validate status
	validStatuses := map[string]bool{
		"completed": true,
		"failed":    true,
		"paused":    true,
	}
	if !validStatuses[f.status] {
		fmt.Fprintf(os.Stderr, "Error: invalid status '%s'. Must be: completed, failed, or paused\n", f.status)
		return exitUsageError
	}

	// Validate metadata JSON
	var metadata map[string]any
	if err := json.Unmarshal([]byte(f.metadata), &metadata); err != nil {
		fmt.Fprintf(os.Stderr, "Error: invalid JSON metadata: %v\n", err)
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

	if f.verbose {
		fmt.Printf("Using RabbitMQ: %s\n", config.RabbitMQ.URL)
		fmt.Printf("Exchange: %s\n", config.RabbitMQ.Exchange)
	}

	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Publish event
	if err := publishEvent(ctx, config, &f); err != nil {
		fmt.Fprintf(os.Stderr, "Error publishing event: %v\n", err)
		return exitPublishErr
	}

	// Update TASK.md if it exists
	if err := updateTaskFile(&f); err != nil {
		if f.verbose {
			fmt.Fprintf(os.Stderr, "Warning: failed to update TASK.md: %v\n", err)
		}
		// Don't fail the command if TASK.md update fails
	}

	// Print success message
	fmt.Printf("Task %s marked as %s\n", f.taskID, f.status)
	if f.summary != "" {
		fmt.Printf("Summary: %s\n", f.summary)
	}

	return exitSuccess
}

func publishEvent(ctx context.Context, config *cliconfig.CLIConfig, f *flags) error {
	// Connect to RabbitMQ
	conn, err := amqp.Dial(config.RabbitMQ.URL)
	if err != nil {
		return fmt.Errorf("failed to connect to RabbitMQ: %w", err)
	}
	defer conn.Close()

	// Create channel
	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("failed to open channel: %w", err)
	}
	defer ch.Close()

	// Declare exchange (idempotent)
	err = ch.ExchangeDeclare(
		config.RabbitMQ.Exchange,
		"topic",
		true,  // durable
		false, // auto-deleted
		false, // internal
		false, // no-wait
		nil,   // arguments
	)
	if err != nil {
		return fmt.Errorf("failed to declare exchange: %w", err)
	}

	// Parse metadata
	var metadata map[string]any
	json.Unmarshal([]byte(f.metadata), &metadata)

	// Generate correlation ID
	correlationID := uuid.New().String()
	now := time.Now()

	// Create event based on status
	var routingKey string
	var payload any

	switch f.status {
	case "completed":
		routingKey = "task.lifecycle.completed"
		payload = events.TaskLifecycleCompleted{
			TaskID:        f.taskID,
			Summary:       f.summary,
			CompletedAt:   now,
			CorrelationID: correlationID,
			Metadata:      metadata,
		}
	case "failed":
		routingKey = "task.lifecycle.failed"
		payload = events.TaskLifecycleFailed{
			TaskID:        f.taskID,
			Reason:        f.summary,
			ErrorDetails:  f.errMsg,
			FailedAt:      now,
			CorrelationID: correlationID,
			Metadata:      metadata,
		}
	case "paused":
		routingKey = "task.lifecycle.paused"
		payload = events.TaskLifecyclePaused{
			TaskID:        f.taskID,
			Reason:        f.summary,
			PausedAt:      now,
			CorrelationID: correlationID,
			Metadata:      metadata,
		}
	}

	// Marshal payload
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal event: %w", err)
	}

	// Publish message
	msg := amqp.Publishing{
		DeliveryMode:  amqp.Persistent,
		ContentType:   "application/json",
		Timestamp:     now,
		CorrelationId: correlationID,
		Body:          body,
	}

	err = ch.PublishWithContext(
		ctx,
		config.RabbitMQ.Exchange,
		routingKey,
		false, // mandatory
		false, // immediate
		msg,
	)
	if err != nil {
		return fmt.Errorf("failed to publish message: %w", err)
	}

	if f.verbose {
		fmt.Printf("Published event: %s\n", routingKey)
		fmt.Printf("Correlation ID: %s\n", correlationID)
	}

	return nil
}

func updateTaskFile(f *flags) error {
	// Look for TASK.md in current directory
	taskFile := "TASK.md"
	if _, err := os.Stat(taskFile); os.IsNotExist(err) {
		return fmt.Errorf("TASK.md not found in current directory")
	}

	// Read file
	content, err := os.ReadFile(taskFile)
	if err != nil {
		return fmt.Errorf("failed to read TASK.md: %w", err)
	}

	lines := strings.Split(string(content), "\n")
	updated := false

	// Update status in file
	for i, line := range lines {
		// Look for status line in frontmatter or markdown
		if strings.Contains(strings.ToLower(line), "status:") {
			lines[i] = fmt.Sprintf("status: %s", f.status)
			updated = true
		}
	}

	// If no status line found, add one
	if !updated {
		// Try to add after frontmatter if it exists
		inFrontmatter := false
		frontmatterEnd := -1
		for i, line := range lines {
			if line == "---" {
				if !inFrontmatter {
					inFrontmatter = true
				} else {
					frontmatterEnd = i
					break
				}
			}
		}

		if frontmatterEnd > 0 {
			// Insert before closing ---
			newLines := append(lines[:frontmatterEnd], fmt.Sprintf("status: %s", f.status))
			lines = append(newLines, lines[frontmatterEnd:]...)
		}
	}

	// Write back to file
	updatedContent := strings.Join(lines, "\n")
	return os.WriteFile(taskFile, []byte(updatedContent), 0644)
}

func printHelp() {
	fmt.Printf(`flume-complete - Mark tasks as completed, failed, or paused

USAGE:
    flume-complete --task-id TASK-001 --status completed --summary "Task done"

OPTIONS:
    --task-id <id>         Task identifier (required)
    --status <status>      Task status: completed, failed, paused (default: completed)
    --summary <text>       Completion summary or reason
    --error <text>         Error message (for failed status)
    --metadata <json>      Additional JSON metadata (default: {})
    -v, --verbose          Enable verbose output
    -h, --help             Show this help message
    --version              Show version information

EXAMPLES:
    # Mark task as completed
    flume-complete --task-id TASK-001 --status completed --summary "Implemented auth"

    # Mark task as failed
    flume-complete --task-id TASK-002 --status failed --error "API key missing"

    # Mark task as paused
    flume-complete --task-id TASK-003 --status paused --summary "Waiting for review"

    # With custom metadata
    flume-complete --task-id TASK-004 --status completed \
        --metadata '{"files_changed": 5, "tests_added": 12}'

EXIT CODES:
    0  Success
    1  Usage error (invalid arguments)
    2  Configuration error
    3  Connection error (cannot reach RabbitMQ)
    4  Publish error

CONFIGURATION:
    Configuration is loaded from ~/.config/flume/config.yaml
    See documentation for configuration options.

    Environment variables:
        RABBITMQ_URL        - Override RabbitMQ URL
        RABBITMQ_EXCHANGE   - Override exchange name
        FLUME_CONFIG_PATH   - Override config file path
`)
}
