package cliconfig

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

// CLIConfig holds configuration for all flume CLI tools
type CLIConfig struct {
	RabbitMQ   RabbitMQConfig   `yaml:"rabbitmq"`
	Monitoring MonitoringConfig `yaml:"monitoring"`
	Session    SessionConfig    `yaml:"session"`
}

// RabbitMQConfig holds RabbitMQ connection settings
type RabbitMQConfig struct {
	URL      string `yaml:"url"`
	Exchange string `yaml:"exchange"`
}

// MonitoringConfig holds task monitor API settings
type MonitoringConfig struct {
	APIURL         string        `yaml:"api_url"`
	Timeout        time.Duration `yaml:"timeout"`
	RetryAttempts  int           `yaml:"retry_attempts"`
	RetryDelay     time.Duration `yaml:"retry_delay"`
	WebSocketURL   string        `yaml:"websocket_url"`
	ConnectTimeout time.Duration `yaml:"connect_timeout"`
}

// SessionConfig holds session management settings
type SessionConfig struct {
	Manager         string        `yaml:"manager"` // "zellij" or "tmux"
	SessionPrefix   string        `yaml:"session_prefix"`
	StaleThreshold  time.Duration `yaml:"stale_threshold"`
	CleanupInterval time.Duration `yaml:"cleanup_interval"`
}

// Default configuration values
var defaultConfig = CLIConfig{
	RabbitMQ: RabbitMQConfig{
		URL:      "amqp://guest:guest@localhost:5672/",
		Exchange: "task.lifecycle",
	},
	Monitoring: MonitoringConfig{
		APIURL:         "http://localhost:8000",
		Timeout:        30 * time.Second,
		RetryAttempts:  3,
		RetryDelay:     2 * time.Second,
		WebSocketURL:   "ws://localhost:8000/ws",
		ConnectTimeout: 10 * time.Second,
	},
	Session: SessionConfig{
		Manager:         "zellij",
		SessionPrefix:   "task-",
		StaleThreshold:  24 * time.Hour,
		CleanupInterval: 1 * time.Hour,
	},
}

// Load loads configuration from the config file or returns defaults
func Load() (*CLIConfig, error) {
	configPath := getConfigPath()

	// If config file doesn't exist, return defaults
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		config := defaultConfig
		return &config, nil
	}

	// Read config file
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	// Parse YAML
	var config CLIConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	// Apply defaults for missing fields
	applyDefaults(&config)

	// Allow environment variable overrides
	applyEnvOverrides(&config)

	return &config, nil
}

// getConfigPath returns the path to the configuration file
func getConfigPath() string {
	// Check environment variable first
	if path := os.Getenv("FLUME_CONFIG_PATH"); path != "" {
		return path
	}

	// Check XDG_CONFIG_HOME
	if xdgConfig := os.Getenv("XDG_CONFIG_HOME"); xdgConfig != "" {
		return filepath.Join(xdgConfig, "flume", "config.yaml")
	}

	// Fallback to ~/.config/flume/config.yaml
	home, err := os.UserHomeDir()
	if err != nil {
		return "/etc/flume/config.yaml"
	}
	return filepath.Join(home, ".config", "flume", "config.yaml")
}

// applyDefaults fills in missing configuration with defaults
func applyDefaults(config *CLIConfig) {
	if config.RabbitMQ.URL == "" {
		config.RabbitMQ.URL = defaultConfig.RabbitMQ.URL
	}
	if config.RabbitMQ.Exchange == "" {
		config.RabbitMQ.Exchange = defaultConfig.RabbitMQ.Exchange
	}
	if config.Monitoring.APIURL == "" {
		config.Monitoring.APIURL = defaultConfig.Monitoring.APIURL
	}
	if config.Monitoring.Timeout == 0 {
		config.Monitoring.Timeout = defaultConfig.Monitoring.Timeout
	}
	if config.Monitoring.RetryAttempts == 0 {
		config.Monitoring.RetryAttempts = defaultConfig.Monitoring.RetryAttempts
	}
	if config.Monitoring.RetryDelay == 0 {
		config.Monitoring.RetryDelay = defaultConfig.Monitoring.RetryDelay
	}
	if config.Monitoring.WebSocketURL == "" {
		config.Monitoring.WebSocketURL = defaultConfig.Monitoring.WebSocketURL
	}
	if config.Monitoring.ConnectTimeout == 0 {
		config.Monitoring.ConnectTimeout = defaultConfig.Monitoring.ConnectTimeout
	}
	if config.Session.Manager == "" {
		config.Session.Manager = defaultConfig.Session.Manager
	}
	if config.Session.SessionPrefix == "" {
		config.Session.SessionPrefix = defaultConfig.Session.SessionPrefix
	}
	if config.Session.StaleThreshold == 0 {
		config.Session.StaleThreshold = defaultConfig.Session.StaleThreshold
	}
	if config.Session.CleanupInterval == 0 {
		config.Session.CleanupInterval = defaultConfig.Session.CleanupInterval
	}
}

// applyEnvOverrides allows environment variables to override config
func applyEnvOverrides(config *CLIConfig) {
	if url := os.Getenv("RABBITMQ_URL"); url != "" {
		config.RabbitMQ.URL = url
	}
	if exchange := os.Getenv("RABBITMQ_EXCHANGE"); exchange != "" {
		config.RabbitMQ.Exchange = exchange
	}
	if apiURL := os.Getenv("FLUME_API_URL"); apiURL != "" {
		config.Monitoring.APIURL = apiURL
	}
	if wsURL := os.Getenv("FLUME_WS_URL"); wsURL != "" {
		config.Monitoring.WebSocketURL = wsURL
	}
	if manager := os.Getenv("FLUME_SESSION_MANAGER"); manager != "" {
		config.Session.Manager = manager
	}
}

// Validate checks if the configuration is valid
func (c *CLIConfig) Validate() error {
	if c.RabbitMQ.URL == "" {
		return fmt.Errorf("rabbitmq.url is required")
	}
	if c.RabbitMQ.Exchange == "" {
		return fmt.Errorf("rabbitmq.exchange is required")
	}
	if c.Monitoring.APIURL == "" {
		return fmt.Errorf("monitoring.api_url is required")
	}
	if c.Session.Manager != "zellij" && c.Session.Manager != "tmux" {
		return fmt.Errorf("session.manager must be 'zellij' or 'tmux'")
	}
	return nil
}
