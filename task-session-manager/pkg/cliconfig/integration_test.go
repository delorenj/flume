// +build integration

package cliconfig

import (
	"os"
	"testing"
)

// TestIntegration_LoadFromActualConfigFile tests loading from actual config file location
func TestIntegration_LoadFromActualConfigFile(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test")
	}

	// Try to load from actual config location
	config, err := Load()
	if err != nil {
		t.Logf("Note: Could not load config (this is ok if no config exists): %v", err)
		return
	}

	// Just validate that it loaded successfully
	if err := config.Validate(); err != nil {
		t.Errorf("Loaded config failed validation: %v", err)
	}

	t.Logf("Successfully loaded config from: %s", getConfigPath())
	t.Logf("RabbitMQ URL: %s", config.RabbitMQ.URL)
	t.Logf("Monitoring API: %s", config.Monitoring.APIURL)
	t.Logf("Session Manager: %s", config.Session.Manager)
}

// TestIntegration_ConfigPathResolution tests actual path resolution logic
func TestIntegration_ConfigPathResolution(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test")
	}

	// Clear any env override
	originalPath := os.Getenv("FLUME_CONFIG_PATH")
	os.Unsetenv("FLUME_CONFIG_PATH")
	defer func() {
		if originalPath != "" {
			os.Setenv("FLUME_CONFIG_PATH", originalPath)
		}
	}()

	path := getConfigPath()
	t.Logf("Resolved config path: %s", path)

	// Check if the path makes sense
	if path == "" {
		t.Error("Config path should not be empty")
	}

	// Check if path contains expected components
	if path != "/etc/flume/config.yaml" {
		// Should contain either .config/flume or /etc/flume
		if !(containsSubstring(path, ".config/flume") || containsSubstring(path, "/etc/flume")) {
			t.Errorf("Config path doesn't contain expected directory structure: %s", path)
		}
	}
}

func containsSubstring(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) && (s[0:len(substr)] == substr || s[len(s)-len(substr):] == substr || containsSubstringHelper(s, substr)))
}

func containsSubstringHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
