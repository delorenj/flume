package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/33GOD/cortex/task-session-manager/internal/config"
	"github.com/33GOD/cortex/task-session-manager/pkg/events"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/rs/zerolog"
)

// Publisher handles publishing events to RabbitMQ
type Publisher struct {
	conn    *amqp.Connection
	channel *amqp.Channel
	cfg     *config.Config
	logger  zerolog.Logger
}

// New creates a new publisher
func New(cfg *config.Config, logger zerolog.Logger) (*Publisher, error) {
	p := &Publisher{
		cfg:    cfg,
		logger: logger.With().Str("component", "publisher").Logger(),
	}

	if err := p.connect(); err != nil {
		return nil, err
	}

	return p, nil
}

// connect establishes connection to RabbitMQ
func (p *Publisher) connect() error {
	conn, err := amqp.Dial(p.cfg.RabbitMQ.URL)
	if err != nil {
		return fmt.Errorf("failed to connect to RabbitMQ: %w", err)
	}

	ch, err := conn.Channel()
	if err != nil {
		conn.Close()
		return fmt.Errorf("failed to open channel: %w", err)
	}

	// Declare the exchange
	err = ch.ExchangeDeclare(
		p.cfg.RabbitMQ.Exchange,
		"topic",
		true,  // durable
		false, // auto-deleted
		false, // internal
		false, // no-wait
		nil,   // arguments
	)
	if err != nil {
		ch.Close()
		conn.Close()
		return fmt.Errorf("failed to declare exchange: %w", err)
	}

	p.conn = conn
	p.channel = ch

	p.logger.Info().Msg("Publisher connected to RabbitMQ")
	return nil
}

// PublishStarted publishes a task.lifecycle.started event
func (p *Publisher) PublishStarted(ctx context.Context, event *events.TaskLifecycleStarted) error {
	return p.publish(ctx, "task.lifecycle.started", event)
}

// PublishFailed publishes a task.lifecycle.failed event
func (p *Publisher) PublishFailed(ctx context.Context, event *events.TaskLifecycleFailed) error {
	return p.publish(ctx, "task.lifecycle.failed", event)
}

// publish publishes an event to RabbitMQ
func (p *Publisher) publish(ctx context.Context, routingKey string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal event: %w", err)
	}

	msg := amqp.Publishing{
		DeliveryMode: amqp.Persistent,
		ContentType:  "application/json",
		Timestamp:    time.Now(),
		Body:         body,
	}

	// Extract correlation ID if available
	if correlatable, ok := payload.(interface{ GetCorrelationID() string }); ok {
		msg.CorrelationId = correlatable.GetCorrelationID()
	}

	err = p.channel.PublishWithContext(
		ctx,
		p.cfg.RabbitMQ.Exchange,
		routingKey,
		false, // mandatory
		false, // immediate
		msg,
	)

	if err != nil {
		return fmt.Errorf("failed to publish message: %w", err)
	}

	p.logger.Debug().
		Str("routing_key", routingKey).
		Str("correlation_id", msg.CorrelationId).
		Msg("Event published")

	return nil
}

// Close closes the publisher connection
func (p *Publisher) Close() error {
	if p.channel != nil {
		if err := p.channel.Close(); err != nil {
			p.logger.Error().Err(err).Msg("Error closing channel")
		}
	}
	if p.conn != nil {
		if err := p.conn.Close(); err != nil {
			p.logger.Error().Err(err).Msg("Error closing connection")
		}
	}
	p.logger.Info().Msg("Publisher closed")
	return nil
}

// IsConnected checks if the publisher is connected
func (p *Publisher) IsConnected() bool {
	return p.conn != nil && !p.conn.IsClosed()
}

// Reconnect attempts to reconnect to RabbitMQ
func (p *Publisher) Reconnect() error {
	p.logger.Info().Msg("Attempting to reconnect publisher")
	p.Close()
	return p.connect()
}
