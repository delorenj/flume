package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/33GOD/flume/task-session-manager/internal/config"
	"github.com/33GOD/flume/task-session-manager/internal/consumer"
	"github.com/33GOD/flume/task-session-manager/internal/publisher"
	"github.com/33GOD/flume/task-session-manager/internal/session"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

const (
	serviceName    = "task-session-manager"
	serviceVersion = "1.0.0"
)

func main() {
	// Setup logger
	setupLogger()

	log.Info().
		Str("service", serviceName).
		Str("version", serviceVersion).
		Msg("Starting Task Session Manager")

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to load configuration")
	}

	log.Info().
		Str("rabbitmq_url", maskURL(cfg.RabbitMQ.URL)).
		Str("queue", cfg.RabbitMQ.Queue).
		Str("routing_key", cfg.RabbitMQ.RoutingKey).
		Str("session_manager", cfg.Session.PreferredManager).
		Msg("Configuration loaded")

	// Create context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize session manager
	sessionMgr, err := session.New(cfg, log.Logger)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize session manager")
	}

	// Initialize publisher
	pub, err := publisher.New(cfg, log.Logger)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize publisher")
	}
	defer pub.Close()

	// Initialize consumer
	cons, err := consumer.New(cfg, log.Logger, sessionMgr, pub)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize consumer")
	}
	defer cons.Close()

	// Start health check server
	healthSrv := startHealthCheckServer(cfg.Service.HealthCheckPort)

	// Start consumer in goroutine
	errChan := make(chan error, 1)
	go func() {
		if err := cons.Start(ctx); err != nil {
			errChan <- err
		}
	}()

	log.Info().Msg("Service started successfully")

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-sigChan:
		log.Info().Str("signal", sig.String()).Msg("Shutdown signal received")
	case err := <-errChan:
		log.Error().Err(err).Msg("Consumer error")
	}

	// Graceful shutdown
	log.Info().Msg("Starting graceful shutdown")

	// Create shutdown context with timeout
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), cfg.Service.ShutdownTimeout)
	defer shutdownCancel()

	// Stop consumer
	cons.Stop()

	// Shutdown health check server
	if err := healthSrv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("Error shutting down health check server")
	}

	log.Info().Msg("Service stopped")
}

// setupLogger configures the global logger
func setupLogger() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix

	// Pretty console logging for development
	if os.Getenv("ENVIRONMENT") != "production" {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})
	}

	// Set log level
	level := os.Getenv("LOG_LEVEL")
	switch level {
	case "debug":
		zerolog.SetGlobalLevel(zerolog.DebugLevel)
	case "info":
		zerolog.SetGlobalLevel(zerolog.InfoLevel)
	case "warn":
		zerolog.SetGlobalLevel(zerolog.WarnLevel)
	case "error":
		zerolog.SetGlobalLevel(zerolog.ErrorLevel)
	default:
		zerolog.SetGlobalLevel(zerolog.InfoLevel)
	}

	log.Logger = log.With().
		Str("service", serviceName).
		Str("version", serviceVersion).
		Logger()
}

// startHealthCheckServer starts a simple HTTP server for health checks
func startHealthCheckServer(port int) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})

	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ready"}`))
	})

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", port),
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Info().Int("port", port).Msg("Health check server started")
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Error().Err(err).Msg("Health check server error")
		}
	}()

	return srv
}

// maskURL masks sensitive parts of a URL
func maskURL(url string) string {
	// Simple masking for demonstration
	// In production, use a proper URL parser
	return "amqp://***:***@localhost:5672/"
}
