package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all service configuration
type Config struct {
	RabbitMQ      RabbitMQConfig
	Session       SessionConfig
	Service       ServiceConfig
	AgentCommands map[string]string
}

// RabbitMQConfig holds RabbitMQ connection settings
type RabbitMQConfig struct {
	URL              string
	Exchange         string
	Queue            string
	RoutingKey       string
	PrefetchCount    int
	ReconnectDelay   time.Duration
	MaxReconnectTime time.Duration
}

// SessionConfig holds session manager settings
type SessionConfig struct {
	PreferredManager string // "zellij" or "tmux"
	SessionNameTpl   string
	DefaultWorkDir   string
	StartupTimeout   time.Duration
}

// ServiceConfig holds general service settings
type ServiceConfig struct {
	LogLevel        string
	ShutdownTimeout time.Duration
	HealthCheckPort int
}

// Load loads configuration from environment variables with sensible defaults
func Load() (*Config, error) {
	cfg := &Config{
		RabbitMQ: RabbitMQConfig{
			URL:              getEnv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/"),
			Exchange:         getEnv("RABBITMQ_EXCHANGE", "task.lifecycle"),
			Queue:            getEnv("RABBITMQ_QUEUE", "task.session.assigned"),
			RoutingKey:       getEnv("RABBITMQ_ROUTING_KEY", "task.lifecycle.assigned"),
			PrefetchCount:    getEnvInt("RABBITMQ_PREFETCH_COUNT", 1),
			ReconnectDelay:   getEnvDuration("RABBITMQ_RECONNECT_DELAY", 5*time.Second),
			MaxReconnectTime: getEnvDuration("RABBITMQ_MAX_RECONNECT_TIME", 5*time.Minute),
		},
		Session: SessionConfig{
			PreferredManager: getEnv("FLUME_SESSION_MANAGER", "zellij"),
			SessionNameTpl:   getEnv("SESSION_NAME_TEMPLATE", "task-{{.TaskID}}"),
			DefaultWorkDir:   getEnv("DEFAULT_WORK_DIR", "/tmp"),
			StartupTimeout:   getEnvDuration("SESSION_STARTUP_TIMEOUT", 30*time.Second),
		},
		Service: ServiceConfig{
			LogLevel:        getEnv("LOG_LEVEL", "info"),
			ShutdownTimeout: getEnvDuration("SHUTDOWN_TIMEOUT", 30*time.Second),
			HealthCheckPort: getEnvInt("HEALTH_CHECK_PORT", 9344),
		},
		AgentCommands: make(map[string]string),
	}

	// Load agent command mappings
	cfg.AgentCommands["claude-code"] = getEnv("AGENT_CMD_CLAUDE", "claude")
	cfg.AgentCommands["gemini-cli"] = getEnv("AGENT_CMD_GEMINI", "gemini")
	cfg.AgentCommands["gpt-cli"] = getEnv("AGENT_CMD_GPT", "gpt")
	cfg.AgentCommands["default"] = getEnv("AGENT_CMD_DEFAULT", "bash")

	// Validate configuration
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	return cfg, nil
}

// Validate checks if the configuration is valid
func (c *Config) Validate() error {
	if c.RabbitMQ.URL == "" {
		return fmt.Errorf("RABBITMQ_URL is required")
	}
	if c.RabbitMQ.Exchange == "" {
		return fmt.Errorf("RABBITMQ_EXCHANGE is required")
	}
	if c.RabbitMQ.Queue == "" {
		return fmt.Errorf("RABBITMQ_QUEUE is required")
	}
	if c.RabbitMQ.RoutingKey == "" {
		return fmt.Errorf("RABBITMQ_ROUTING_KEY is required")
	}
	if c.Session.PreferredManager != "zellij" && c.Session.PreferredManager != "tmux" {
		return fmt.Errorf("FLUME_SESSION_MANAGER must be 'zellij' or 'tmux'")
	}
	return nil
}

// Helper functions
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intVal, err := strconv.Atoi(value); err == nil {
			return intVal
		}
	}
	return defaultValue
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}
