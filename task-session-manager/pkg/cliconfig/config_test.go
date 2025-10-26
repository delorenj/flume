package cliconfig

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoad_DefaultConfig(t *testing.T) {
	// Set a non-existent config path to force defaults
	os.Setenv("FLUME_CONFIG_PATH", "/nonexistent/config.yaml")
	defer os.Unsetenv("FLUME_CONFIG_PATH")

	config, err := Load()
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	if config.RabbitMQ.URL != "amqp://guest:guest@localhost:5672/" {
		t.Errorf("Expected default RabbitMQ URL, got: %s", config.RabbitMQ.URL)
	}

	if config.RabbitMQ.Exchange != "task.lifecycle" {
		t.Errorf("Expected default exchange, got: %s", config.RabbitMQ.Exchange)
	}

	if config.Monitoring.APIURL != "http://localhost:8000" {
		t.Errorf("Expected default API URL, got: %s", config.Monitoring.APIURL)
	}

	if config.Session.Manager != "zellij" {
		t.Errorf("Expected default session manager, got: %s", config.Session.Manager)
	}
}

func TestLoad_FromFile(t *testing.T) {
	// Clear any environment overrides
	envVars := []string{"RABBITMQ_URL", "RABBITMQ_EXCHANGE", "FLUME_API_URL", "FLUME_SESSION_MANAGER"}
	originalEnvs := make(map[string]string)
	for _, key := range envVars {
		originalEnvs[key] = os.Getenv(key)
		os.Unsetenv(key)
	}
	defer func() {
		for key, value := range originalEnvs {
			if value != "" {
				os.Setenv(key, value)
			}
		}
	}()

	// Create temporary config file
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.yaml")

	configContent := `
rabbitmq:
  url: "amqp://test:test@testhost:5672/"
  exchange: "test.exchange"

monitoring:
  api_url: "http://test:9999"
  timeout: 60s

session:
  manager: "tmux"
  session_prefix: "test-"
`

	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatalf("Failed to create test config: %v", err)
	}

	os.Setenv("FLUME_CONFIG_PATH", configPath)
	defer os.Unsetenv("FLUME_CONFIG_PATH")

	config, err := Load()
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	if config.RabbitMQ.URL != "amqp://test:test@testhost:5672/" {
		t.Errorf("Expected custom RabbitMQ URL, got: %s", config.RabbitMQ.URL)
	}

	if config.RabbitMQ.Exchange != "test.exchange" {
		t.Errorf("Expected custom exchange, got: %s", config.RabbitMQ.Exchange)
	}

	if config.Monitoring.APIURL != "http://test:9999" {
		t.Errorf("Expected custom API URL, got: %s", config.Monitoring.APIURL)
	}

	if config.Monitoring.Timeout != 60*time.Second {
		t.Errorf("Expected 60s timeout, got: %v", config.Monitoring.Timeout)
	}

	if config.Session.Manager != "tmux" {
		t.Errorf("Expected tmux manager, got: %s", config.Session.Manager)
	}
}

func TestLoad_EnvOverrides(t *testing.T) {
	// Create a temp config file with defaults
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.yaml")
	configContent := `
rabbitmq:
  url: "amqp://default:default@localhost:5672/"
  exchange: "default.exchange"
monitoring:
  api_url: "http://default:8000"
session:
  manager: "zellij"
`
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatalf("Failed to create test config: %v", err)
	}

	os.Setenv("FLUME_CONFIG_PATH", configPath)
	defer os.Unsetenv("FLUME_CONFIG_PATH")

	// Set environment overrides
	os.Setenv("RABBITMQ_URL", "amqp://env:env@envhost:5672/")
	os.Setenv("RABBITMQ_EXCHANGE", "env.exchange")
	os.Setenv("FLUME_API_URL", "http://env:8888")
	os.Setenv("FLUME_SESSION_MANAGER", "tmux")

	defer func() {
		os.Unsetenv("RABBITMQ_URL")
		os.Unsetenv("RABBITMQ_EXCHANGE")
		os.Unsetenv("FLUME_API_URL")
		os.Unsetenv("FLUME_SESSION_MANAGER")
	}()

	config, err := Load()
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	if config.RabbitMQ.URL != "amqp://env:env@envhost:5672/" {
		t.Errorf("Expected env RabbitMQ URL, got: %s", config.RabbitMQ.URL)
	}

	if config.RabbitMQ.Exchange != "env.exchange" {
		t.Errorf("Expected env exchange, got: %s", config.RabbitMQ.Exchange)
	}

	if config.Monitoring.APIURL != "http://env:8888" {
		t.Errorf("Expected env API URL, got: %s", config.Monitoring.APIURL)
	}

	if config.Session.Manager != "tmux" {
		t.Errorf("Expected env session manager, got: %s", config.Session.Manager)
	}
}

func TestValidate_Valid(t *testing.T) {
	config := &CLIConfig{
		RabbitMQ: RabbitMQConfig{
			URL:      "amqp://localhost:5672/",
			Exchange: "test.exchange",
		},
		Monitoring: MonitoringConfig{
			APIURL: "http://localhost:8000",
		},
		Session: SessionConfig{
			Manager: "zellij",
		},
	}

	if err := config.Validate(); err != nil {
		t.Errorf("Expected no validation error, got: %v", err)
	}
}

func TestValidate_InvalidManager(t *testing.T) {
	config := &CLIConfig{
		RabbitMQ: RabbitMQConfig{
			URL:      "amqp://localhost:5672/",
			Exchange: "test.exchange",
		},
		Monitoring: MonitoringConfig{
			APIURL: "http://localhost:8000",
		},
		Session: SessionConfig{
			Manager: "invalid",
		},
	}

	if err := config.Validate(); err == nil {
		t.Error("Expected validation error for invalid manager")
	}
}

func TestValidate_MissingURL(t *testing.T) {
	config := &CLIConfig{
		RabbitMQ: RabbitMQConfig{
			URL:      "",
			Exchange: "test.exchange",
		},
		Monitoring: MonitoringConfig{
			APIURL: "http://localhost:8000",
		},
		Session: SessionConfig{
			Manager: "zellij",
		},
	}

	if err := config.Validate(); err == nil {
		t.Error("Expected validation error for missing URL")
	}
}

func TestValidate_MissingExchange(t *testing.T) {
	config := &CLIConfig{
		RabbitMQ: RabbitMQConfig{
			URL:      "amqp://localhost:5672/",
			Exchange: "",
		},
		Monitoring: MonitoringConfig{
			APIURL: "http://localhost:8000",
		},
		Session: SessionConfig{
			Manager: "zellij",
		},
	}

	if err := config.Validate(); err == nil {
		t.Error("Expected validation error for missing exchange")
	}
}

func TestValidate_MissingAPIURL(t *testing.T) {
	config := &CLIConfig{
		RabbitMQ: RabbitMQConfig{
			URL:      "amqp://localhost:5672/",
			Exchange: "test.exchange",
		},
		Monitoring: MonitoringConfig{
			APIURL: "",
		},
		Session: SessionConfig{
			Manager: "zellij",
		},
	}

	if err := config.Validate(); err == nil {
		t.Error("Expected validation error for missing API URL")
	}
}

func TestApplyDefaults(t *testing.T) {
	config := &CLIConfig{
		RabbitMQ: RabbitMQConfig{
			URL: "amqp://custom:5672/",
			// Exchange missing - should be filled with default
		},
		Monitoring: MonitoringConfig{
			// All missing - should be filled with defaults
		},
		Session: SessionConfig{
			Manager: "tmux",
			// Other fields missing - should be filled with defaults
		},
	}

	applyDefaults(config)

	if config.RabbitMQ.URL != "amqp://custom:5672/" {
		t.Error("Custom URL should not be overwritten")
	}

	if config.RabbitMQ.Exchange != "task.lifecycle" {
		t.Errorf("Expected default exchange, got: %s", config.RabbitMQ.Exchange)
	}

	if config.Monitoring.APIURL != "http://localhost:8000" {
		t.Errorf("Expected default API URL, got: %s", config.Monitoring.APIURL)
	}

	if config.Monitoring.Timeout != 30*time.Second {
		t.Errorf("Expected default timeout, got: %v", config.Monitoring.Timeout)
	}

	if config.Session.Manager != "tmux" {
		t.Error("Custom manager should not be overwritten")
	}

	if config.Session.SessionPrefix != "task-" {
		t.Errorf("Expected default session prefix, got: %s", config.Session.SessionPrefix)
	}
}
