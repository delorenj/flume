# CLI Shell Integration: Configuration Architecture

**Version:** 1.0.0
**Component:** Centralized Configuration System
**Date:** 2025-10-22
**Architect:** System Architect

---

## Executive Summary

This document defines the complete configuration architecture for the CLI shell integration system, including YAML schema design, environment variable injection patterns, agent CLI support matrix implementation, and cross-platform considerations.

**Design Goals:**
- **Zero-config defaults:** Work out-of-box for common scenarios
- **Progressive enhancement:** Advanced features via explicit configuration
- **Environment parity:** Consistent behavior across dev/staging/prod
- **Security-first:** Secrets management and credential isolation

---

## Configuration File Structure

### Primary Configuration File

**Location:** `~/.config/flume/config.yaml`

**Complete Schema:**

```yaml
# Flume CLI Shell Integration Configuration
# Version: 1.0.0

###########################################
# RabbitMQ Connection
###########################################
rabbitmq:
  # Connection URL (supports amqp:// and amqps://)
  url: "amqp://guest:guest@localhost:5672/"

  # Topic exchange name
  exchange: "task.lifecycle"

  # Connection settings
  vhost: "/"
  heartbeat: 60
  connection_timeout: 30
  prefetch_count: 10

  # TLS Configuration (optional)
  tls:
    enabled: false
    ca_cert: "/path/to/ca.pem"
    client_cert: "/path/to/client.pem"
    client_key: "/path/to/client-key.pem"
    skip_verify: false

  # Reconnection strategy
  reconnect:
    max_attempts: 5
    initial_delay: 5s
    max_delay: 300s
    backoff_multiplier: 2.0

###########################################
# Agent CLI Configurations
###########################################
agents:
  # Claude Code CLI
  claude-code:
    binary: "claude"
    context_flag: "@"
    supports_markdown: true
    default_args:
      - "--verbose"
    env:
      # Environment variables for agent
      # Use ${VAR} syntax to reference host environment
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
    timeout: 14400  # 4 hours

  # Gemini CLI
  gemini:
    binary: "gemini-cli"
    context_flag: "-f"
    supports_markdown: true
    default_args:
      - "--json-output"
    env:
      GOOGLE_API_KEY: "${GOOGLE_API_KEY}"
    timeout: 14400

  # GPT CLI
  gpt-cli:
    binary: "gpt"
    context_flag: "--task"
    supports_markdown: true
    default_args: []
    env:
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
    timeout: 14400

  # Cursor (Future)
  cursor:
    binary: "cursor"
    context_flag: "--context"
    supports_markdown: true
    default_args: []
    timeout: 14400

  # Custom agent template
  custom-agent:
    binary: "/path/to/custom-agent"
    context_flag: "--input"
    supports_markdown: false
    default_args:
      - "--mode=autonomous"
    env:
      CUSTOM_API_KEY: "${CUSTOM_API_KEY}"
    timeout: 7200

###########################################
# Session Management
###########################################
session:
  # Preferred terminal multiplexer: "zellij" or "tmux"
  manager: "zellij"

  # Session naming template (supports Go templates)
  session_name_template: "task-{{.TaskID}}"

  # Default working directory (if not specified in task)
  default_work_dir: "${HOME}/code"

  # Session creation timeout
  startup_timeout: 30s

  # Session persistence
  database_path: "${HOME}/.local/share/flume/sessions.db"

  # Session recovery on restart
  recover_on_startup: true

  # Attach to session after creation (opens terminal window)
  auto_attach: false

###########################################
# Monitoring & Observability
###########################################
monitoring:
  # Heartbeat interval (seconds)
  heartbeat_interval: 60

  # Stale session threshold (seconds)
  stale_threshold: 300

  # Periodic stale check interval
  stale_check_interval: 60s

  # Activity capture settings
  enable_activity_capture: true
  enable_command_logging: true
  enable_file_tracking: true
  enable_git_tracking: true

  # Resource monitoring
  enable_resource_monitoring: true
  resource_sample_interval: 30s

  # Log storage
  log_directory: "${HOME}/.local/share/flume/logs/sessions"
  log_rotation: "daily"
  log_retention_days: 30
  log_compression: true

  # Metrics export (optional)
  prometheus:
    enabled: false
    port: 9090
    path: "/metrics"

  # OpenTelemetry (optional)
  opentelemetry:
    enabled: false
    endpoint: "localhost:4317"
    service_name: "flume-wrapper"

###########################################
# Completion & Cleanup
###########################################
completion:
  # Auto-detect completion from agent exit
  auto_detect: true

  # Detection methods (priority order)
  detect_methods:
    - "exit_code"
    - "timeout"
    - "signal"

  # Timeout for agent execution (seconds)
  default_timeout: 14400  # 4 hours

  # Delay before cleanup after completion (seconds)
  cleanup_delay: 3600  # 1 hour

  # Cleanup scheduler interval
  cleanup_interval: 300s  # 5 minutes

  # Archive completed sessions
  archive_sessions: true
  archive_directory: "${HOME}/.local/share/flume/archives"
  archive_retention_days: 90

###########################################
# Task Context
###########################################
context:
  # Prompt template file (optional override)
  prompt_template_file: ""

  # Default prompt template (inline)
  prompt_template: |
    # TASK: {{.TaskID}} - {{.Title}}

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
    This task is part of the Flume lifecycle system.

    **Event System:** task.lifecycle.* events are being tracked
    **Session ID:** {{.SessionID}}

    Begin working on this task now.

  # Include git context in prompt
  include_git_context: true

  # Include environment info in prompt
  include_environment_info: false

###########################################
# Security
###########################################
security:
  # Never log these environment variable names
  secret_env_vars:
    - "API_KEY"
    - "SECRET"
    - "PASSWORD"
    - "TOKEN"
    - "CREDENTIALS"

  # Validate agent binary paths
  validate_agent_binaries: true

  # Restrict working directory to these paths
  allowed_work_dirs:
    - "${HOME}/code"
    - "${HOME}/projects"
    - "/tmp"

  # Maximum session count per user
  max_sessions_per_user: 50

  # Resource limits (optional)
  resource_limits:
    max_memory_mb: 4096
    max_cpu_percent: 80
    max_disk_io_mbps: 100

###########################################
# Platform-Specific Settings
###########################################
platform:
  # Linux
  linux:
    terminal_emulator: "gnome-terminal"
    terminal_args:
      - "--"
    shell: "/bin/bash"

  # macOS
  darwin:
    terminal_emulator: "Terminal.app"
    terminal_args: []
    shell: "/bin/zsh"

  # Windows WSL
  windows:
    terminal_emulator: "wsl.exe"
    terminal_args:
      - "-e"
    shell: "/bin/bash"

###########################################
# Developer Settings
###########################################
developer:
  # Logging level: debug, info, warn, error
  log_level: "info"

  # Enable verbose logging for components
  verbose_components:
    - "event_publisher"
    - "session_manager"

  # Enable debug mode (disables some security checks)
  debug_mode: false

  # Enable profiling
  profiling:
    enabled: false
    cpu_profile_path: "/tmp/flume-cpu.prof"
    mem_profile_path: "/tmp/flume-mem.prof"
```

---

## Environment Variable Reference

### Core Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `FLUME_CONFIG_PATH` | Path to config.yaml | `~/.config/flume/config.yaml` | No |
| `FLUME_DATA_DIR` | Data storage directory | `~/.local/share/flume` | No |
| `FLUME_LOG_LEVEL` | Logging level | `info` | No |

### RabbitMQ Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `RABBITMQ_URL` | RabbitMQ connection URL | `amqp://guest:guest@localhost:5672/` | No |
| `RABBITMQ_EXCHANGE` | Exchange name | `task.lifecycle` | No |
| `RABBITMQ_VHOST` | Virtual host | `/` | No |

### Session Manager Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SESSION_MANAGER` | Multiplexer type | `zellij` | No |
| `SESSION_DB_PATH` | Database path | `~/.local/share/flume/sessions.db` | No |
| `DEFAULT_WORK_DIR` | Default working directory | `/tmp` | No |

### Agent API Keys (Secrets)

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Claude API key | For claude-code |
| `GOOGLE_API_KEY` | Gemini API key | For gemini |
| `OPENAI_API_KEY` | OpenAI API key | For gpt-cli |

### Wrapper-Injected Variables

These are injected by `flume-agent` into the agent's environment:

| Variable | Description | Example |
|----------|-------------|---------|
| `FLUME_TASK_ID` | Current task ID | `TASK-001` |
| `FLUME_EVENT_ID` | Originating event ID | `evt_abc_123` |
| `FLUME_PROJECT_PATH` | Working directory | `/home/user/code/project` |
| `FLUME_AGENT_TYPE` | Agent type | `claude-code` |
| `FLUME_PRIORITY` | Task priority | `high` |
| `FLUME_SESSION_ID` | Session identifier | `sess_TASK-001_1729608603` |
| `FLUME_CORRELATION_ID` | Event correlation ID | `corr_xyz789` |

---

## Configuration Loading Hierarchy

**Priority (highest to lowest):**

1. **Command-line flags** (e.g., `--config /path/to/config.yaml`)
2. **Environment variables** (e.g., `RABBITMQ_URL`)
3. **Config file** (`~/.config/flume/config.yaml`)
4. **Built-in defaults** (hardcoded in application)

### Example Configuration Loader (Go)

```go
package config

import (
    "fmt"
    "os"
    "path/filepath"

    "gopkg.in/yaml.v3"
)

// LoadConfig loads configuration from file with environment variable expansion
func LoadConfig(configPath string) (*Config, error) {
    // Determine config file path
    if configPath == "" {
        configPath = getDefaultConfigPath()
    }

    // Expand ~ to home directory
    configPath = expandPath(configPath)

    // Read config file
    data, err := os.ReadFile(configPath)
    if err != nil {
        if os.IsNotExist(err) {
            // Config file doesn't exist, use defaults
            return getDefaultConfig(), nil
        }
        return nil, fmt.Errorf("failed to read config: %w", err)
    }

    // Parse YAML
    var cfg Config
    if err := yaml.Unmarshal(data, &cfg); err != nil {
        return nil, fmt.Errorf("failed to parse config: %w", err)
    }

    // Expand environment variables
    cfg = expandEnvVars(cfg)

    // Apply environment variable overrides
    cfg = applyEnvOverrides(cfg)

    // Validate configuration
    if err := cfg.Validate(); err != nil {
        return nil, fmt.Errorf("invalid config: %w", err)
    }

    return &cfg, nil
}

func getDefaultConfigPath() string {
    home, _ := os.UserHomeDir()
    return filepath.Join(home, ".config", "flume", "config.yaml")
}

func expandPath(path string) string {
    if strings.HasPrefix(path, "~") {
        home, _ := os.UserHomeDir()
        return filepath.Join(home, path[1:])
    }
    return path
}

func expandEnvVars(cfg Config) Config {
    // Expand ${VAR} syntax in configuration
    // Example: ${HOME} -> /home/user

    // RabbitMQ URL
    cfg.RabbitMQ.URL = os.ExpandEnv(cfg.RabbitMQ.URL)

    // Agent environment variables
    for agentName, agentCfg := range cfg.Agents {
        for key, value := range agentCfg.Env {
            agentCfg.Env[key] = os.ExpandEnv(value)
        }
        cfg.Agents[agentName] = agentCfg
    }

    // Session paths
    cfg.Session.DefaultWorkDir = os.ExpandEnv(cfg.Session.DefaultWorkDir)
    cfg.Session.DatabasePath = os.ExpandEnv(cfg.Session.DatabasePath)

    // Monitoring paths
    cfg.Monitoring.LogDirectory = os.ExpandEnv(cfg.Monitoring.LogDirectory)

    return cfg
}

func applyEnvOverrides(cfg Config) Config {
    // Environment variable overrides
    if url := os.Getenv("RABBITMQ_URL"); url != "" {
        cfg.RabbitMQ.URL = url
    }
    if exchange := os.Getenv("RABBITMQ_EXCHANGE"); exchange != "" {
        cfg.RabbitMQ.Exchange = exchange
    }
    if manager := os.Getenv("SESSION_MANAGER"); manager != "" {
        cfg.Session.Manager = manager
    }
    if logLevel := os.Getenv("FLUME_LOG_LEVEL"); logLevel != "" {
        cfg.Developer.LogLevel = logLevel
    }

    return cfg
}

func getDefaultConfig() *Config {
    return &Config{
        RabbitMQ: RabbitMQConfig{
            URL:              "amqp://guest:guest@localhost:5672/",
            Exchange:         "task.lifecycle",
            VHost:            "/",
            Heartbeat:        60,
            ConnectionTimeout: 30,
            PrefetchCount:    10,
        },
        Session: SessionConfig{
            Manager:            "zellij",
            SessionNameTemplate: "task-{{.TaskID}}",
            DefaultWorkDir:     "/tmp",
            StartupTimeout:     30,
            RecoverOnStartup:   true,
        },
        Monitoring: MonitoringConfig{
            HeartbeatInterval:      60,
            StaleThreshold:         300,
            EnableActivityCapture:  true,
            EnableGitTracking:      true,
            LogDirectory:           "~/.local/share/flume/logs",
        },
        Completion: CompletionConfig{
            AutoDetect:    true,
            DefaultTimeout: 14400,
            CleanupDelay:   3600,
        },
        Developer: DeveloperConfig{
            LogLevel: "info",
        },
    }
}
```

---

## Agent CLI Support Matrix Implementation

### Agent Registry

```go
package agent

import (
    "fmt"
    "os/exec"
)

// AgentConfig represents an agent CLI configuration
type AgentConfig struct {
    Name             string            `yaml:"-"`
    Binary           string            `yaml:"binary"`
    ContextFlag      string            `yaml:"context_flag"`
    SupportsMarkdown bool              `yaml:"supports_markdown"`
    DefaultArgs      []string          `yaml:"default_args"`
    Env              map[string]string `yaml:"env"`
    Timeout          int               `yaml:"timeout"`
}

// Registry manages agent configurations
type Registry struct {
    agents map[string]AgentConfig
}

func NewRegistry(configs map[string]AgentConfig) *Registry {
    return &Registry{agents: configs}
}

func (r *Registry) Get(agentType string) (AgentConfig, error) {
    cfg, ok := r.agents[agentType]
    if !ok {
        return AgentConfig{}, fmt.Errorf("unknown agent type: %s", agentType)
    }

    return cfg, nil
}

func (r *Registry) IsAvailable(agentType string) bool {
    cfg, err := r.Get(agentType)
    if err != nil {
        return false
    }

    _, err = exec.LookPath(cfg.Binary)
    return err == nil
}

func (r *Registry) ListAvailable() []string {
    available := []string{}
    for name := range r.agents {
        if r.IsAvailable(name) {
            available = append(available, name)
        }
    }
    return available
}
```

### Agent Detection

```go
// DetectAvailableAgents scans system for available agent CLIs
func DetectAvailableAgents() map[string]string {
    knownAgents := map[string]string{
        "claude":     "claude-code",
        "gemini-cli": "gemini",
        "gpt":        "gpt-cli",
        "cursor":     "cursor",
    }

    detected := make(map[string]string)

    for binary, agentType := range knownAgents {
        if path, err := exec.LookPath(binary); err == nil {
            detected[agentType] = path
        }
    }

    return detected
}
```

---

## Cross-Platform Terminal Launching

### Platform-Specific Implementations

```go
package platform

import (
    "fmt"
    "os/exec"
    "runtime"
)

// TerminalLauncher handles platform-specific terminal launching
type TerminalLauncher struct {
    platform string
    config   PlatformConfig
}

type PlatformConfig struct {
    TerminalEmulator string   `yaml:"terminal_emulator"`
    TerminalArgs     []string `yaml:"terminal_args"`
    Shell            string   `yaml:"shell"`
}

func NewTerminalLauncher(config PlatformConfig) *TerminalLauncher {
    return &TerminalLauncher{
        platform: runtime.GOOS,
        config:   config,
    }
}

// LaunchTerminal opens a new terminal window and attaches to session
func (t *TerminalLauncher) LaunchTerminal(sessionName string) error {
    var cmd *exec.Cmd

    switch t.platform {
    case "linux":
        cmd = t.launchLinux(sessionName)
    case "darwin":
        cmd = t.launchDarwin(sessionName)
    case "windows":
        cmd = t.launchWindows(sessionName)
    default:
        return fmt.Errorf("unsupported platform: %s", t.platform)
    }

    return cmd.Start()
}

func (t *TerminalLauncher) launchLinux(sessionName string) *exec.Cmd {
    // gnome-terminal -- zellij attach task-001
    args := append(t.config.TerminalArgs, "zellij", "attach", sessionName)
    return exec.Command(t.config.TerminalEmulator, args...)
}

func (t *TerminalLauncher) launchDarwin(sessionName string) *exec.Cmd {
    // open -a Terminal.app zellij attach task-001
    script := fmt.Sprintf("zellij attach %s", sessionName)
    return exec.Command("osascript", "-e",
        fmt.Sprintf(`tell application "Terminal" to do script "%s"`, script))
}

func (t *TerminalLauncher) launchWindows(sessionName string) *exec.Cmd {
    // wsl.exe -e zellij attach task-001
    args := append(t.config.TerminalArgs, "zellij", "attach", sessionName)
    return exec.Command(t.config.TerminalEmulator, args...)
}
```

---

## Configuration Validation

```go
// Validate checks configuration validity
func (c *Config) Validate() error {
    // RabbitMQ
    if c.RabbitMQ.URL == "" {
        return fmt.Errorf("rabbitmq.url is required")
    }
    if c.RabbitMQ.Exchange == "" {
        return fmt.Errorf("rabbitmq.exchange is required")
    }

    // Session
    if c.Session.Manager != "zellij" && c.Session.Manager != "tmux" {
        return fmt.Errorf("session.manager must be 'zellij' or 'tmux'")
    }

    // Agents
    if len(c.Agents) == 0 {
        return fmt.Errorf("at least one agent must be configured")
    }

    for name, agent := range c.Agents {
        if agent.Binary == "" {
            return fmt.Errorf("agent '%s' missing binary", name)
        }
        if agent.ContextFlag == "" {
            return fmt.Errorf("agent '%s' missing context_flag", name)
        }
    }

    // Monitoring
    if c.Monitoring.HeartbeatInterval < 10 {
        return fmt.Errorf("monitoring.heartbeat_interval must be >= 10 seconds")
    }

    if c.Monitoring.StaleThreshold < 60 {
        return fmt.Errorf("monitoring.stale_threshold must be >= 60 seconds")
    }

    // Security
    if c.Security.MaxSessionsPerUser < 1 {
        return fmt.Errorf("security.max_sessions_per_user must be >= 1")
    }

    return nil
}
```

---

## Minimal Configuration Example

For users who just want defaults:

```yaml
# ~/.config/flume/config.yaml (minimal)

agents:
  claude-code:
    binary: "claude"
    context_flag: "@"
    env:
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"

session:
  manager: "zellij"
```

---

## Advanced Configuration Example

For power users:

```yaml
# ~/.config/flume/config.yaml (advanced)

rabbitmq:
  url: "amqps://user:pass@rabbitmq.prod.example.com:5671/"
  exchange: "prod.task.lifecycle"
  tls:
    enabled: true
    ca_cert: "/etc/flume/ca.pem"
    client_cert: "/etc/flume/client.pem"
    client_key: "/etc/flume/client-key.pem"
  reconnect:
    max_attempts: 10
    initial_delay: 5s

agents:
  claude-code:
    binary: "/usr/local/bin/claude"
    context_flag: "@"
    default_args:
      - "--verbose"
      - "--no-color"
    env:
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
      ANTHROPIC_LOG_LEVEL: "debug"
    timeout: 7200

session:
  manager: "tmux"
  database_path: "/var/lib/flume/sessions.db"
  default_work_dir: "/workspace"

monitoring:
  heartbeat_interval: 30
  stale_threshold: 180
  enable_resource_monitoring: true
  log_directory: "/var/log/flume/sessions"
  prometheus:
    enabled: true
    port: 9090

security:
  allowed_work_dirs:
    - "/workspace"
  max_sessions_per_user: 20
  resource_limits:
    max_memory_mb: 2048
    max_cpu_percent: 50

developer:
  log_level: "debug"
  verbose_components:
    - "session_manager"
    - "event_publisher"
```

---

## Configuration Migration Tool

```go
// MigrateConfig converts old config format to new format
func MigrateConfig(oldPath, newPath string) error {
    // Read old config
    oldData, err := os.ReadFile(oldPath)
    if err != nil {
        return err
    }

    var oldCfg OldConfig
    if err := yaml.Unmarshal(oldData, &oldCfg); err != nil {
        return err
    }

    // Convert to new format
    newCfg := convertConfig(oldCfg)

    // Write new config
    newData, err := yaml.Marshal(newCfg)
    if err != nil {
        return err
    }

    return os.WriteFile(newPath, newData, 0644)
}
```

---

## Environment-Specific Configs

Support multiple environments:

```bash
# Development
~/.config/flume/config.yaml

# Staging
~/.config/flume/config.staging.yaml

# Production
~/.config/flume/config.production.yaml

# Usage
export FLUME_ENV=staging
flume-agent --config ~/.config/flume/config.${FLUME_ENV}.yaml
```

---

## Configuration Best Practices

### Security

1. **Never commit API keys** to version control
2. **Use environment variables** for secrets
3. **Restrict config file permissions**: `chmod 600 ~/.config/flume/config.yaml`
4. **Rotate credentials** regularly
5. **Use TLS** for RabbitMQ connections in production

### Performance

1. **Tune heartbeat_interval** based on workload
2. **Adjust prefetch_count** for RabbitMQ throughput
3. **Enable compression** for log files
4. **Configure retention** to manage disk usage

### Reliability

1. **Configure reconnection** for transient failures
2. **Set appropriate timeouts** for long-running tasks
3. **Enable session recovery** for crash resilience
4. **Archive completed sessions** for audit trail

---

**End of Configuration Architecture Document**
