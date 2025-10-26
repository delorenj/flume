# CLI Shell Integration: Wrapper Architecture

**Version:** 1.0.0
**Component:** flume-agent wrapper
**Date:** 2025-10-22
**Architect:** System Architect

---

## Executive Summary

The `flume-agent` wrapper is the **critical integration layer** that bridges AI agent CLIs (Claude Code, Gemini, etc.) with the Flume task lifecycle system. It provides context injection, lifecycle management, progress monitoring, and bidirectional event communication.

**Key Responsibilities:**
- Parse and inject task context into agent CLIs
- Monitor agent execution and emit lifecycle events
- Handle completion detection (success/failure/timeout)
- Manage cleanup and session termination
- Provide observability into agent activities

---

## Architecture Overview

### Design Philosophy

**Single Responsibility:** The wrapper is a thin orchestration layer. It does NOT:
- Implement business logic
- Maintain persistent state (delegates to RabbitMQ/Monitor)
- Modify agent behavior (only injects context)

**Composability:** Works with any CLI agent through configuration
**Observability-First:** Every action emits structured events
**Fail-Safe:** Graceful degradation on errors, always emits failure events

### Component Structure

```
flume-agent (Go binary)
├── cmd/
│   └── main.go                 # Entry point, CLI parsing
├── pkg/
│   ├── context/
│   │   ├── injector.go         # Task context injection
│   │   └── template.go         # Prompt template rendering
│   ├── monitor/
│   │   ├── heartbeat.go        # Periodic progress events
│   │   ├── watcher.go          # File/git activity tracking
│   │   └── completion.go       # Exit/completion detection
│   ├── agent/
│   │   ├── launcher.go         # Agent CLI invocation
│   │   └── registry.go         # Agent configuration lookup
│   ├── events/
│   │   ├── publisher.go        # RabbitMQ event emission
│   │   └── types.go            # Event payload structures
│   └── config/
│       └── loader.go           # Configuration loading
└── internal/
    └── util/
        ├── env.go              # Environment variable handling
        └── file.go             # File operations
```

---

## Detailed Design

### 1. Input Processing

#### 1.1 Command-Line Interface

```bash
flume-agent \
  --task-id TASK-001 \
  --agent claude-code \
  --working-dir /code/project \
  --task-file /tmp/TASK-001.md \
  --event-source evt_abc_123 \
  [--heartbeat-interval 60] \
  [--timeout 14400] \
  [--config ~/.config/flume/config.yaml] \
  [--verbose]
```

**Required Arguments:**
- `--task-id`: Unique task identifier (e.g., TASK-001)
- `--agent`: Agent type (claude-code, gemini, etc.)
- `--working-dir`: Working directory for agent execution
- `--task-file`: Path to TASK.md file with instructions

**Optional Arguments:**
- `--event-source`: Correlation ID from originating event (default: generated UUID)
- `--heartbeat-interval`: Seconds between progress events (default: 60)
- `--timeout`: Maximum execution time in seconds (default: 14400 = 4 hours)
- `--config`: Path to config file (default: ~/.config/flume/config.yaml)
- `--verbose`: Enable debug logging

#### 1.2 Input Validation

```go
type WrapperInput struct {
    TaskID           string
    AgentType        string
    WorkingDir       string
    TaskFilePath     string
    EventSource      string
    HeartbeatInterval int
    Timeout          int
    ConfigPath       string
}

func (w *WrapperInput) Validate() error {
    if w.TaskID == "" {
        return fmt.Errorf("task-id is required")
    }
    if w.AgentType == "" {
        return fmt.Errorf("agent is required")
    }
    if !fileExists(w.WorkingDir) {
        return fmt.Errorf("working-dir does not exist: %s", w.WorkingDir)
    }
    if !fileExists(w.TaskFilePath) {
        return fmt.Errorf("task-file does not exist: %s", w.TaskFilePath)
    }
    if w.HeartbeatInterval < 10 {
        return fmt.Errorf("heartbeat-interval must be >= 10 seconds")
    }
    if w.Timeout < 60 {
        return fmt.Errorf("timeout must be >= 60 seconds")
    }
    return nil
}
```

---

### 2. Configuration Loading

#### 2.1 Configuration Schema (YAML)

```yaml
# ~/.config/flume/config.yaml

rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "task.lifecycle"
  heartbeat: 60
  connection_timeout: 30

agents:
  claude-code:
    binary: "claude"
    context_flag: "@"
    args: ["--verbose"]
    env:
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
    supports_markdown: true

  gemini:
    binary: "gemini-cli"
    context_flag: "-f"
    args: ["--json-output"]
    env:
      GOOGLE_API_KEY: "${GOOGLE_API_KEY}"
    supports_markdown: true

  gpt-cli:
    binary: "gpt"
    context_flag: "--task"
    args: []
    supports_markdown: true

monitoring:
  heartbeat_interval: 60
  stale_threshold: 300
  enable_activity_capture: true
  enable_git_tracking: true
  log_directory: "/var/log/flume/sessions"

completion:
  auto_detect: true
  detect_methods: ["exit_code", "task_status", "timeout"]
  cleanup_delay: 3600
```

#### 2.2 Configuration Struct

```go
type Config struct {
    RabbitMQ   RabbitMQConfig
    Agents     map[string]AgentConfig
    Monitoring MonitoringConfig
    Completion CompletionConfig
}

type AgentConfig struct {
    Binary           string            `yaml:"binary"`
    ContextFlag      string            `yaml:"context_flag"`
    Args             []string          `yaml:"args"`
    Env              map[string]string `yaml:"env"`
    SupportsMarkdown bool              `yaml:"supports_markdown"`
}

type MonitoringConfig struct {
    HeartbeatInterval     int    `yaml:"heartbeat_interval"`
    StaleThreshold        int    `yaml:"stale_threshold"`
    EnableActivityCapture bool   `yaml:"enable_activity_capture"`
    EnableGitTracking     bool   `yaml:"enable_git_tracking"`
    LogDirectory          string `yaml:"log_directory"`
}
```

---

### 3. Task Context Injection

#### 3.1 Context Preparation

The wrapper extracts context from multiple sources:
1. **TASK.md file** (task description, instructions)
2. **Command-line arguments** (task ID, working dir)
3. **Event metadata** (correlation IDs, timestamps)
4. **Git repository** (project name, current branch)

```go
type TaskContext struct {
    TaskID           string
    Title            string
    Description      string
    Instructions     string
    ProjectName      string
    WorkingDir       string
    Priority         string
    EventID          string
    AssignedAt       time.Time
    AgentType        string
    SessionID        string
    CorrelationID    string
    GitBranch        string
    GitRemote        string
}

func extractTaskContext(input *WrapperInput) (*TaskContext, error) {
    // Read TASK.md
    taskContent, err := os.ReadFile(input.TaskFilePath)
    if err != nil {
        return nil, fmt.Errorf("failed to read task file: %w", err)
    }

    // Parse frontmatter and content
    ctx := &TaskContext{
        TaskID:        input.TaskID,
        WorkingDir:    input.WorkingDir,
        AgentType:     input.AgentType,
        EventID:       input.EventSource,
        AssignedAt:    time.Now(),
        CorrelationID: input.EventSource,
    }

    // Parse TASK.md structure
    parsedTask := parseTaskMarkdown(taskContent)
    ctx.Title = parsedTask.Title
    ctx.Description = parsedTask.Description
    ctx.Instructions = parsedTask.Instructions
    ctx.Priority = parsedTask.Priority

    // Extract git context
    if gitCtx := extractGitContext(input.WorkingDir); gitCtx != nil {
        ctx.ProjectName = gitCtx.ProjectName
        ctx.GitBranch = gitCtx.Branch
        ctx.GitRemote = gitCtx.Remote
    }

    return ctx, nil
}
```

#### 3.2 Environment Variable Injection

```go
func injectEnvironmentVariables(ctx *TaskContext) []string {
    env := os.Environ()

    // Flume-specific environment variables
    env = append(env,
        fmt.Sprintf("FLUME_TASK_ID=%s", ctx.TaskID),
        fmt.Sprintf("FLUME_EVENT_ID=%s", ctx.EventID),
        fmt.Sprintf("FLUME_PROJECT_PATH=%s", ctx.WorkingDir),
        fmt.Sprintf("FLUME_AGENT_TYPE=%s", ctx.AgentType),
        fmt.Sprintf("FLUME_PRIORITY=%s", ctx.Priority),
        fmt.Sprintf("FLUME_SESSION_ID=%s", ctx.SessionID),
        fmt.Sprintf("FLUME_CORRELATION_ID=%s", ctx.CorrelationID),
    )

    return env
}
```

#### 3.3 Prompt Template Construction

**Template Strategy:**
- Use Go `text/template` for flexibility
- Support agent-specific templates
- Include lifecycle instructions

```go
const defaultPromptTemplate = `# TASK: {{.TaskID}} - {{.Title}}

{{.Description}}

## Context
- Project: {{.ProjectName}}
- Working Directory: {{.WorkingDir}}
- Git Branch: {{.GitBranch}}
- Priority: {{.Priority}}
- Event ID: {{.EventID}}
- Assigned: {{.AssignedAt.Format "2006-01-02 15:04:05 MST"}}

## Instructions
{{.Instructions}}

## Lifecycle Integration
This task is part of the Flume lifecycle system. You are expected to:

1. **Report Progress**: The wrapper monitors your activity and emits progress events automatically
2. **Use Tools**: Leverage TodoWrite, Read, Edit, and other tools as needed
3. **Document Decisions**: Update TASK.md with significant decisions or blockers
4. **Complete Properly**: When done, exit cleanly or mark completion in TASK.md

**Event System:** task.lifecycle.* events are being tracked
**Session ID:** {{.SessionID}}
**Correlation ID:** {{.CorrelationID}}

Begin working on this task now.
`

func renderPromptTemplate(ctx *TaskContext, agentCfg *AgentConfig) (string, error) {
    tmpl, err := template.New("prompt").Parse(defaultPromptTemplate)
    if err != nil {
        return "", fmt.Errorf("failed to parse template: %w", err)
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, ctx); err != nil {
        return "", fmt.Errorf("failed to execute template: %w", err)
    }

    return buf.String(), nil
}
```

#### 3.4 Agent Invocation

```go
func buildAgentCommand(ctx *TaskContext, cfg *AgentConfig, promptFile string) *exec.Cmd {
    args := []string{}

    // Add configured default args
    args = append(args, cfg.Args...)

    // Add context file with agent-specific flag
    if cfg.SupportsMarkdown {
        args = append(args, cfg.ContextFlag + promptFile)
    } else {
        args = append(args, cfg.ContextFlag, promptFile)
    }

    cmd := exec.Command(cfg.Binary, args...)
    cmd.Dir = ctx.WorkingDir
    cmd.Env = injectEnvironmentVariables(ctx)

    // Merge agent-specific environment variables
    for k, v := range cfg.Env {
        // Expand environment variables like ${ANTHROPIC_API_KEY}
        expanded := os.ExpandEnv(v)
        cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, expanded))
    }

    return cmd
}
```

---

### 4. Event Emission Strategy

#### 4.1 Event Types and Payloads

The wrapper emits the following lifecycle events:

**1. task.lifecycle.started**
```go
type TaskLifecycleStarted struct {
    TaskID         string            `json:"task_id"`
    SessionID      string            `json:"session_id"`
    AgentType      string            `json:"agent_type"`
    AgentPID       int               `json:"agent_pid"`
    WorkingDir     string            `json:"working_dir"`
    StartedAt      time.Time         `json:"started_at"`
    CorrelationID  string            `json:"correlation_id"`
    ParentEventID  string            `json:"parent_event_id"`
    Metadata       map[string]any    `json:"metadata,omitempty"`
}
```

**2. task.lifecycle.in_progress** (Heartbeat)
```go
type TaskLifecycleInProgress struct {
    TaskID              string         `json:"task_id"`
    SessionID           string         `json:"session_id"`
    ProgressPercentage  int            `json:"progress_percentage"`
    CurrentActivity     string         `json:"current_activity"`
    FilesModified       []string       `json:"files_modified"`
    CommandsExecuted    int            `json:"commands_executed"`
    ElapsedTimeSeconds  int            `json:"elapsed_time_seconds"`
    Timestamp           time.Time      `json:"timestamp"`
    CorrelationID       string         `json:"correlation_id"`
    GitStats            *GitStats      `json:"git_stats,omitempty"`
}

type GitStats struct {
    FilesChanged int `json:"files_changed"`
    Insertions   int `json:"insertions"`
    Deletions    int `json:"deletions"`
}
```

**3. task.lifecycle.completed**
```go
type TaskLifecycleCompleted struct {
    TaskID            string         `json:"task_id"`
    SessionID         string         `json:"session_id"`
    ExitCode          int            `json:"exit_code"`
    Summary           string         `json:"summary"`
    FilesModified     []string       `json:"files_modified"`
    TotalTimeSeconds  int            `json:"total_time_seconds"`
    CompletedAt       time.Time      `json:"completed_at"`
    CorrelationID     string         `json:"correlation_id"`
    Metadata          map[string]any `json:"metadata,omitempty"`
}
```

**4. task.lifecycle.failed**
```go
type TaskLifecycleFailed struct {
    TaskID        string         `json:"task_id"`
    SessionID     string         `json:"session_id"`
    Reason        string         `json:"reason"`
    ErrorDetails  string         `json:"error_details"`
    ExitCode      int            `json:"exit_code"`
    FailedAt      time.Time      `json:"failed_at"`
    CorrelationID string         `json:"correlation_id"`
    Metadata      map[string]any `json:"metadata,omitempty"`
}
```

#### 4.2 Event Publisher Implementation

```go
type EventPublisher struct {
    conn      *amqp.Connection
    channel   *amqp.Channel
    exchange  string
    logger    *zerolog.Logger
}

func NewEventPublisher(url, exchange string, logger *zerolog.Logger) (*EventPublisher, error) {
    conn, err := amqp.Dial(url)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to RabbitMQ: %w", err)
    }

    ch, err := conn.Channel()
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("failed to open channel: %w", err)
    }

    // Declare exchange (idempotent)
    err = ch.ExchangeDeclare(
        exchange,   // name
        "topic",    // type
        true,       // durable
        false,      // auto-deleted
        false,      // internal
        false,      // no-wait
        nil,        // arguments
    )
    if err != nil {
        ch.Close()
        conn.Close()
        return nil, fmt.Errorf("failed to declare exchange: %w", err)
    }

    return &EventPublisher{
        conn:     conn,
        channel:  ch,
        exchange: exchange,
        logger:   logger,
    }, nil
}

func (p *EventPublisher) EmitStarted(event *TaskLifecycleStarted) error {
    return p.publish("task.lifecycle.started", event)
}

func (p *EventPublisher) EmitInProgress(event *TaskLifecycleInProgress) error {
    return p.publish("task.lifecycle.in_progress", event)
}

func (p *EventPublisher) EmitCompleted(event *TaskLifecycleCompleted) error {
    return p.publish("task.lifecycle.completed", event)
}

func (p *EventPublisher) EmitFailed(event *TaskLifecycleFailed) error {
    return p.publish("task.lifecycle.failed", event)
}

func (p *EventPublisher) publish(routingKey string, payload interface{}) error {
    body, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("failed to marshal payload: %w", err)
    }

    err = p.channel.Publish(
        p.exchange,  // exchange
        routingKey,  // routing key
        false,       // mandatory
        false,       // immediate
        amqp.Publishing{
            ContentType:  "application/json",
            DeliveryMode: amqp.Persistent,
            Timestamp:    time.Now(),
            Body:         body,
        },
    )

    if err != nil {
        return fmt.Errorf("failed to publish event: %w", err)
    }

    p.logger.Debug().
        Str("routing_key", routingKey).
        Msg("Event published successfully")

    return nil
}

func (p *EventPublisher) Close() {
    if p.channel != nil {
        p.channel.Close()
    }
    if p.conn != nil {
        p.conn.Close()
    }
}
```

#### 4.3 Heartbeat Emission

**Strategy:** Emit progress events every N seconds (default: 60)

```go
type HeartbeatMonitor struct {
    publisher *EventPublisher
    ctx       *TaskContext
    interval  time.Duration
    ticker    *time.Ticker
    stopCh    chan struct{}
    logger    *zerolog.Logger

    // State tracking
    startTime      time.Time
    lastGitStats   *GitStats
    activityLog    []string
}

func NewHeartbeatMonitor(
    publisher *EventPublisher,
    ctx *TaskContext,
    interval int,
    logger *zerolog.Logger,
) *HeartbeatMonitor {
    return &HeartbeatMonitor{
        publisher:   publisher,
        ctx:         ctx,
        interval:    time.Duration(interval) * time.Second,
        stopCh:      make(chan struct{}),
        logger:      logger,
        startTime:   time.Now(),
        activityLog: make([]string, 0),
    }
}

func (h *HeartbeatMonitor) Start() {
    h.ticker = time.NewTicker(h.interval)

    go func() {
        for {
            select {
            case <-h.ticker.C:
                h.emitHeartbeat()
            case <-h.stopCh:
                h.ticker.Stop()
                return
            }
        }
    }()
}

func (h *HeartbeatMonitor) Stop() {
    close(h.stopCh)
}

func (h *HeartbeatMonitor) emitHeartbeat() {
    // Collect activity metrics
    gitStats := h.collectGitStats()
    filesModified := h.detectModifiedFiles()
    activity := h.detectCurrentActivity()

    elapsed := int(time.Since(h.startTime).Seconds())

    event := &TaskLifecycleInProgress{
        TaskID:             h.ctx.TaskID,
        SessionID:          h.ctx.SessionID,
        ProgressPercentage: h.estimateProgress(),
        CurrentActivity:    activity,
        FilesModified:      filesModified,
        ElapsedTimeSeconds: elapsed,
        Timestamp:          time.Now(),
        CorrelationID:      h.ctx.CorrelationID,
        GitStats:           gitStats,
    }

    if err := h.publisher.EmitInProgress(event); err != nil {
        h.logger.Error().Err(err).Msg("Failed to emit heartbeat")
    }
}

func (h *HeartbeatMonitor) collectGitStats() *GitStats {
    cmd := exec.Command("git", "diff", "--shortstat", "HEAD")
    cmd.Dir = h.ctx.WorkingDir

    output, err := cmd.Output()
    if err != nil {
        return nil
    }

    // Parse: "3 files changed, 45 insertions(+), 12 deletions(-)"
    stats := parseGitDiffShortstat(string(output))
    h.lastGitStats = stats
    return stats
}

func (h *HeartbeatMonitor) detectModifiedFiles() []string {
    cmd := exec.Command("git", "diff", "--name-only", "HEAD")
    cmd.Dir = h.ctx.WorkingDir

    output, err := cmd.Output()
    if err != nil {
        return []string{}
    }

    files := strings.Split(strings.TrimSpace(string(output)), "\n")
    return files
}

func (h *HeartbeatMonitor) detectCurrentActivity() string {
    // Simple heuristic: check most recently modified file
    files := h.detectModifiedFiles()
    if len(files) == 0 {
        return "Working on task"
    }

    return fmt.Sprintf("Modifying %s", filepath.Base(files[0]))
}

func (h *HeartbeatMonitor) estimateProgress() int {
    // Simple heuristic based on elapsed time and git activity
    // This is a placeholder - could be enhanced with ML or heuristics
    if h.lastGitStats == nil {
        return 10
    }

    // More changes = higher progress
    totalChanges := h.lastGitStats.Insertions + h.lastGitStats.Deletions
    if totalChanges > 100 {
        return 60
    } else if totalChanges > 50 {
        return 40
    } else if totalChanges > 10 {
        return 20
    }

    return 15
}
```

---

### 5. Completion Detection

#### 5.1 Detection Strategies

**Multiple detection methods** (prioritized):

1. **Exit Code Detection** (Primary)
   - Agent process exits with code 0 = success
   - Agent process exits with code != 0 = failure

2. **Timeout Detection**
   - Maximum execution time exceeded
   - Emit failure event with timeout reason

3. **Signal Detection**
   - SIGTERM/SIGINT received
   - Graceful shutdown with cleanup

4. **TASK.md Status Detection** (Optional)
   - Parse TASK.md for status markers
   - Detect "completed", "failed", "blocked" in frontmatter

```go
type CompletionDetector struct {
    ctx        *TaskContext
    cmd        *exec.Cmd
    timeout    time.Duration
    publisher  *EventPublisher
    logger     *zerolog.Logger
    startTime  time.Time
}

func (d *CompletionDetector) Wait() (*CompletionResult, error) {
    done := make(chan error, 1)

    // Wait for process to exit
    go func() {
        done <- d.cmd.Wait()
    }()

    // Wait with timeout
    select {
    case err := <-done:
        return d.handleProcessExit(err)

    case <-time.After(d.timeout):
        return d.handleTimeout()
    }
}

func (d *CompletionDetector) handleProcessExit(err error) (*CompletionResult, error) {
    elapsed := int(time.Since(d.startTime).Seconds())

    if err == nil {
        // Success
        result := &CompletionResult{
            Success:          true,
            ExitCode:         0,
            TotalTimeSeconds: elapsed,
        }

        event := &TaskLifecycleCompleted{
            TaskID:           d.ctx.TaskID,
            SessionID:        d.ctx.SessionID,
            ExitCode:         0,
            Summary:          "Agent completed successfully",
            TotalTimeSeconds: elapsed,
            CompletedAt:      time.Now(),
            CorrelationID:    d.ctx.CorrelationID,
        }

        d.publisher.EmitCompleted(event)
        return result, nil
    }

    // Failure
    exitErr, ok := err.(*exec.ExitError)
    exitCode := 1
    if ok {
        exitCode = exitErr.ExitCode()
    }

    result := &CompletionResult{
        Success:          false,
        ExitCode:         exitCode,
        ErrorMessage:     err.Error(),
        TotalTimeSeconds: elapsed,
    }

    event := &TaskLifecycleFailed{
        TaskID:        d.ctx.TaskID,
        SessionID:     d.ctx.SessionID,
        Reason:        "agent_exit_error",
        ErrorDetails:  err.Error(),
        ExitCode:      exitCode,
        FailedAt:      time.Now(),
        CorrelationID: d.ctx.CorrelationID,
    }

    d.publisher.EmitFailed(event)
    return result, nil
}

func (d *CompletionDetector) handleTimeout() (*CompletionResult, error) {
    // Kill the process
    if d.cmd.Process != nil {
        d.cmd.Process.Kill()
    }

    elapsed := int(time.Since(d.startTime).Seconds())

    result := &CompletionResult{
        Success:          false,
        ExitCode:         -1,
        ErrorMessage:     "timeout exceeded",
        TotalTimeSeconds: elapsed,
    }

    event := &TaskLifecycleFailed{
        TaskID:        d.ctx.TaskID,
        SessionID:     d.ctx.SessionID,
        Reason:        "timeout",
        ErrorDetails:  fmt.Sprintf("Agent exceeded timeout of %d seconds", int(d.timeout.Seconds())),
        ExitCode:      -1,
        FailedAt:      time.Now(),
        CorrelationID: d.ctx.CorrelationID,
    }

    d.publisher.EmitFailed(event)
    return result, nil
}

type CompletionResult struct {
    Success          bool
    ExitCode         int
    ErrorMessage     string
    TotalTimeSeconds int
}
```

---

### 6. Main Execution Flow

```go
func main() {
    // 1. Parse CLI arguments
    input := parseCLIArgs()

    // 2. Validate input
    if err := input.Validate(); err != nil {
        log.Fatal().Err(err).Msg("Invalid input")
    }

    // 3. Load configuration
    cfg, err := config.Load(input.ConfigPath)
    if err != nil {
        log.Fatal().Err(err).Msg("Failed to load config")
    }

    // 4. Initialize event publisher
    publisher, err := NewEventPublisher(cfg.RabbitMQ.URL, cfg.RabbitMQ.Exchange, &log)
    if err != nil {
        log.Fatal().Err(err).Msg("Failed to initialize publisher")
    }
    defer publisher.Close()

    // 5. Extract task context
    ctx, err := extractTaskContext(input)
    if err != nil {
        emitFailure(publisher, input.TaskID, "context_extraction_error", err.Error())
        log.Fatal().Err(err).Msg("Failed to extract task context")
    }

    // 6. Generate session ID
    ctx.SessionID = fmt.Sprintf("sess_%s_%d", ctx.TaskID, time.Now().Unix())

    // 7. Render prompt template
    agentCfg := cfg.Agents[input.AgentType]
    promptContent, err := renderPromptTemplate(ctx, &agentCfg)
    if err != nil {
        emitFailure(publisher, input.TaskID, "template_render_error", err.Error())
        log.Fatal().Err(err).Msg("Failed to render prompt")
    }

    // 8. Write prompt to temporary file
    promptFile := filepath.Join(os.TempDir(), fmt.Sprintf("flume_prompt_%s.md", ctx.TaskID))
    if err := os.WriteFile(promptFile, []byte(promptContent), 0644); err != nil {
        emitFailure(publisher, input.TaskID, "prompt_write_error", err.Error())
        log.Fatal().Err(err).Msg("Failed to write prompt file")
    }
    defer os.Remove(promptFile)

    // 9. Build agent command
    cmd := buildAgentCommand(ctx, &agentCfg, promptFile)

    // 10. Start agent process
    if err := cmd.Start(); err != nil {
        emitFailure(publisher, input.TaskID, "agent_start_error", err.Error())
        log.Fatal().Err(err).Msg("Failed to start agent")
    }

    // 11. Emit started event
    startedEvent := &TaskLifecycleStarted{
        TaskID:        ctx.TaskID,
        SessionID:     ctx.SessionID,
        AgentType:     ctx.AgentType,
        AgentPID:      cmd.Process.Pid,
        WorkingDir:    ctx.WorkingDir,
        StartedAt:     time.Now(),
        CorrelationID: ctx.CorrelationID,
        ParentEventID: input.EventSource,
    }
    publisher.EmitStarted(startedEvent)

    // 12. Start heartbeat monitor
    heartbeat := NewHeartbeatMonitor(publisher, ctx, input.HeartbeatInterval, &log)
    heartbeat.Start()
    defer heartbeat.Stop()

    // 13. Wait for completion with timeout
    detector := &CompletionDetector{
        ctx:       ctx,
        cmd:       cmd,
        timeout:   time.Duration(input.Timeout) * time.Second,
        publisher: publisher,
        logger:    &log,
        startTime: time.Now(),
    }

    result, err := detector.Wait()

    // 14. Log result
    if result.Success {
        log.Info().
            Str("task_id", ctx.TaskID).
            Int("duration", result.TotalTimeSeconds).
            Msg("Agent completed successfully")
        os.Exit(0)
    } else {
        log.Error().
            Str("task_id", ctx.TaskID).
            Int("exit_code", result.ExitCode).
            Str("error", result.ErrorMessage).
            Msg("Agent failed")
        os.Exit(result.ExitCode)
    }
}
```

---

## Performance Characteristics

### Target Metrics

| Metric | Target | Rationale |
|--------|--------|-----------|
| Wrapper Startup | < 200ms | Minimal overhead before agent starts |
| Context Injection | < 100ms | Fast template rendering and env setup |
| Heartbeat Overhead | < 1% CPU | Background monitoring should be lightweight |
| Memory Footprint | < 20MB | Wrapper process should be negligible |
| Event Emission Latency | < 50ms | Near real-time event delivery |

### Resource Constraints

- **Memory:** Max 50MB per wrapper instance
- **CPU:** < 5% during heartbeat intervals
- **Network:** Burst to 10KB/s during event emission
- **Disk I/O:** Minimal (only temp file writes)

---

## Error Handling Strategy

### Error Categories

1. **Configuration Errors** → Exit code 2, emit failure event
2. **Connection Errors** → Retry 3x, then exit code 3
3. **Agent Errors** → Emit failure event, exit with agent's code
4. **Timeout Errors** → Kill agent, emit failure, exit code 124
5. **Signal Errors** → Graceful shutdown, emit failure if incomplete

### Retry Logic

```go
func publishWithRetry(publisher *EventPublisher, event interface{}, maxRetries int) error {
    var lastErr error

    for i := 0; i < maxRetries; i++ {
        if err := publisher.publish(event); err == nil {
            return nil
        } else {
            lastErr = err
            time.Sleep(time.Duration(i+1) * time.Second)
        }
    }

    return fmt.Errorf("failed after %d retries: %w", maxRetries, lastErr)
}
```

---

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Secret Leakage in Events | Never include env vars in event payloads |
| Agent CLI Injection | Validate all inputs, use exec.Command properly |
| File System Access | Validate working dir, no path traversal |
| Resource Exhaustion | Hard timeouts, memory limits via cgroups |
| RabbitMQ Credential Exposure | Use TLS, restrict config file permissions |

### Implementation

```go
// Sanitize environment variables before logging
func sanitizeEnv(env []string) []string {
    sanitized := make([]string, 0, len(env))
    for _, e := range env {
        if strings.Contains(e, "API_KEY") || strings.Contains(e, "SECRET") {
            parts := strings.SplitN(e, "=", 2)
            sanitized = append(sanitized, fmt.Sprintf("%s=***", parts[0]))
        } else {
            sanitized = append(sanitized, e)
        }
    }
    return sanitized
}
```

---

## Testing Strategy

### Unit Tests

```go
func TestContextExtraction(t *testing.T) {
    input := &WrapperInput{
        TaskID:       "TASK-001",
        TaskFilePath: "testdata/TASK-001.md",
        WorkingDir:   "/tmp/test",
    }

    ctx, err := extractTaskContext(input)
    assert.NoError(t, err)
    assert.Equal(t, "TASK-001", ctx.TaskID)
    assert.NotEmpty(t, ctx.Title)
}

func TestPromptTemplateRendering(t *testing.T) {
    ctx := &TaskContext{
        TaskID:      "TASK-001",
        Title:       "Test Task",
        Description: "Test description",
    }

    agentCfg := &AgentConfig{SupportsMarkdown: true}

    prompt, err := renderPromptTemplate(ctx, agentCfg)
    assert.NoError(t, err)
    assert.Contains(t, prompt, "TASK-001")
    assert.Contains(t, prompt, "Test Task")
}
```

### Integration Tests

```go
func TestEndToEndExecution(t *testing.T) {
    // Setup test RabbitMQ
    publisher := setupTestPublisher(t)
    defer publisher.Close()

    // Create test agent (simple bash script)
    createTestAgent(t, "testdata/agent.sh")

    // Execute wrapper
    result := executeWrapper(t, &WrapperInput{
        TaskID:     "TEST-001",
        AgentType:  "test-agent",
        WorkingDir: "/tmp/test",
        // ...
    })

    assert.True(t, result.Success)
    assert.Equal(t, 0, result.ExitCode)
}
```

---

## Deployment Considerations

### Installation

```bash
# Install binary
go build -o /usr/local/bin/flume-agent cmd/main.go

# Create config directory
mkdir -p ~/.config/flume

# Install default config
cp config.yaml.example ~/.config/flume/config.yaml
```

### Monitoring

The wrapper itself is **stateless and ephemeral**, but should be observable:

1. **Logging:** Structured logs to stdout (JSON format)
2. **Metrics:** Expose basic metrics (optional Prometheus endpoint)
3. **Tracing:** Correlation IDs in all events for distributed tracing

---

## Future Enhancements

### Phase 2

- **Activity Parsing:** Parse agent output for intelligent progress estimation
- **Cost Tracking:** Monitor API usage and costs per task
- **Multi-Agent Support:** Run multiple agents in parallel
- **Session Recovery:** Reconnect to existing sessions after crash

### Phase 3

- **ML-Based Progress:** Train model to predict task completion
- **Adaptive Heartbeats:** Adjust frequency based on activity level
- **Remote Execution:** Support distributed agent execution
- **Resource Profiling:** Track CPU/memory/network per agent

---

## Appendix A: Agent CLI Support Matrix

| Agent | Binary | Context Flag | Markdown Support | Status |
|-------|--------|--------------|------------------|--------|
| Claude Code | `claude` | `@` | Yes | Production |
| Gemini CLI | `gemini-cli` | `-f` | Yes | Production |
| GPT CLI | `gpt` | `--task` | Yes | Beta |
| Cursor | `cursor` | TBD | Yes | Planned |
| Windsurf | `windsurf` | TBD | Yes | Planned |

---

## Appendix B: Example Execution

```bash
# Terminal 1: Start RabbitMQ (if not running)
docker run -d -p 5672:5672 rabbitmq:3-management

# Terminal 2: Run wrapper
flume-agent \
  --task-id TASK-001 \
  --agent claude-code \
  --working-dir /home/user/code/project \
  --task-file /tmp/TASK-001.md \
  --event-source evt_abc_123 \
  --verbose

# Wrapper output:
# {"level":"info","time":"2025-10-22T14:30:00Z","message":"Starting flume-agent wrapper"}
# {"level":"info","task_id":"TASK-001","session_id":"sess_TASK-001_1729608600","message":"Context extracted"}
# {"level":"info","agent_pid":12345,"message":"Agent started"}
# {"level":"info","message":"Heartbeat monitor started"}
# {"level":"info","duration":1823,"message":"Agent completed successfully"}
```

---

**End of Wrapper Architecture Document**
