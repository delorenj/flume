package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/33GOD/cortex/task-session-manager/internal/config"
	"github.com/33GOD/cortex/task-session-manager/internal/publisher"
	"github.com/33GOD/cortex/task-session-manager/internal/session"
	"github.com/33GOD/cortex/task-session-manager/pkg/events"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/rs/zerolog"
)

// Consumer handles consuming messages from RabbitMQ
type Consumer struct {
	conn            *amqp.Connection
	channel         *amqp.Channel
	cfg             *config.Config
	logger          zerolog.Logger
	sessionManager  *session.Manager
	publisher       *publisher.Publisher
	mu              sync.Mutex
	reconnecting    bool
	stopChan        chan struct{}
	doneChan        chan struct{}
}

// New creates a new consumer
func New(cfg *config.Config, logger zerolog.Logger, sessionMgr *session.Manager, pub *publisher.Publisher) (*Consumer, error) {
	c := &Consumer{
		cfg:            cfg,
		logger:         logger.With().Str("component", "consumer").Logger(),
		sessionManager: sessionMgr,
		publisher:      pub,
		stopChan:       make(chan struct{}),
		doneChan:       make(chan struct{}),
	}

	if err := c.connect(); err != nil {
		return nil, err
	}

	return c, nil
}

// connect establishes connection to RabbitMQ
func (c *Consumer) connect() error {
	conn, err := amqp.Dial(c.cfg.RabbitMQ.URL)
	if err != nil {
		return fmt.Errorf("failed to connect to RabbitMQ: %w", err)
	}

	ch, err := conn.Channel()
	if err != nil {
		conn.Close()
		return fmt.Errorf("failed to open channel: %w", err)
	}

	// Set QoS
	err = ch.Qos(
		c.cfg.RabbitMQ.PrefetchCount,
		0,
		false,
	)
	if err != nil {
		ch.Close()
		conn.Close()
		return fmt.Errorf("failed to set QoS: %w", err)
	}

	// Declare exchange
	err = ch.ExchangeDeclare(
		c.cfg.RabbitMQ.Exchange,
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

	// Declare queue
	q, err := ch.QueueDeclare(
		c.cfg.RabbitMQ.Queue,
		true,  // durable
		false, // delete when unused
		false, // exclusive
		false, // no-wait
		nil,   // arguments
	)
	if err != nil {
		ch.Close()
		conn.Close()
		return fmt.Errorf("failed to declare queue: %w", err)
	}

	// Bind queue to exchange
	err = ch.QueueBind(
		q.Name,
		c.cfg.RabbitMQ.RoutingKey,
		c.cfg.RabbitMQ.Exchange,
		false,
		nil,
	)
	if err != nil {
		ch.Close()
		conn.Close()
		return fmt.Errorf("failed to bind queue: %w", err)
	}

	c.conn = conn
	c.channel = ch

	c.logger.Info().
		Str("queue", q.Name).
		Str("routing_key", c.cfg.RabbitMQ.RoutingKey).
		Msg("Consumer connected to RabbitMQ")

	return nil
}

// Start starts consuming messages
func (c *Consumer) Start(ctx context.Context) error {
	c.logger.Info().Msg("Starting consumer")

	go c.handleConnectionErrors(ctx)

	for {
		select {
		case <-ctx.Done():
			c.logger.Info().Msg("Context cancelled, stopping consumer")
			close(c.doneChan)
			return ctx.Err()
		case <-c.stopChan:
			c.logger.Info().Msg("Stop signal received")
			close(c.doneChan)
			return nil
		default:
			if err := c.consume(ctx); err != nil {
				c.logger.Error().Err(err).Msg("Consumer error, attempting reconnect")
				if err := c.reconnect(); err != nil {
					c.logger.Error().Err(err).Msg("Reconnection failed")
					time.Sleep(c.cfg.RabbitMQ.ReconnectDelay)
				}
			}
		}
	}
}

// consume handles the actual message consumption
func (c *Consumer) consume(ctx context.Context) error {
	msgs, err := c.channel.Consume(
		c.cfg.RabbitMQ.Queue,
		"",    // consumer tag
		false, // auto-ack
		false, // exclusive
		false, // no-local
		false, // no-wait
		nil,   // args
	)
	if err != nil {
		return fmt.Errorf("failed to register consumer: %w", err)
	}

	c.logger.Info().Msg("Consuming messages")

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.stopChan:
			return nil
		case msg, ok := <-msgs:
			if !ok {
				return fmt.Errorf("message channel closed")
			}
			c.handleMessage(ctx, msg)
		}
	}
}

// handleMessage processes a single message
func (c *Consumer) handleMessage(ctx context.Context, msg amqp.Delivery) {
	log := c.logger.With().
		Str("correlation_id", msg.CorrelationId).
		Str("message_id", msg.MessageId).
		Logger()

	log.Debug().Msg("Processing message")

	// Parse the event
	var event events.TaskLifecycleAssigned
	if err := json.Unmarshal(msg.Body, &event); err != nil {
		log.Error().Err(err).Msg("Failed to parse event")
		msg.Nack(false, false) // Don't requeue malformed messages
		return
	}

	log = log.With().Str("task_id", event.TaskID).Logger()

	// Create session
	sessionInfo, err := c.sessionManager.CreateSession(ctx, &event)
	if err != nil {
		log.Error().Err(err).Msg("Failed to create session")

		// Publish failure event
		failedEvent := &events.TaskLifecycleFailed{
			TaskID:        event.TaskID,
			Reason:        "session_creation_failed",
			ErrorDetails:  err.Error(),
			FailedAt:      time.Now(),
			CorrelationID: event.CorrelationID,
			ParentEventID: msg.MessageId,
			Metadata:      event.Metadata,
		}

		if pubErr := c.publisher.PublishFailed(ctx, failedEvent); pubErr != nil {
			log.Error().Err(pubErr).Msg("Failed to publish failure event")
		}

		msg.Nack(false, false) // Don't requeue
		return
	}

	// Publish started event
	startedEvent := &events.TaskLifecycleStarted{
		TaskID:         event.TaskID,
		SessionID:      sessionInfo.SessionID,
		SessionManager: string(sessionInfo.SessionManager),
		AgentPID:       sessionInfo.AgentPID,
		AgentType:      event.AgentType,
		WorkingDir:     sessionInfo.WorkingDir,
		StartedAt:      time.Now(),
		CorrelationID:  event.CorrelationID,
		ParentEventID:  msg.MessageId,
		Metadata:       event.Metadata,
	}

	if err := c.publisher.PublishStarted(ctx, startedEvent); err != nil {
		log.Error().Err(err).Msg("Failed to publish started event")
		msg.Nack(false, true) // Requeue for retry
		return
	}

	log.Info().
		Str("session_id", sessionInfo.SessionID).
		Int("agent_pid", sessionInfo.AgentPID).
		Msg("Task session created and started event published")

	msg.Ack(false)
}

// handleConnectionErrors monitors for connection errors
func (c *Consumer) handleConnectionErrors(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopChan:
			return
		default:
			if c.conn != nil {
				notifyClose := make(chan *amqp.Error)
				c.conn.NotifyClose(notifyClose)

				select {
				case <-ctx.Done():
					return
				case <-c.stopChan:
					return
				case err := <-notifyClose:
					if err != nil {
						c.logger.Error().Err(err).Msg("Connection closed unexpectedly")
						if reconnectErr := c.reconnect(); reconnectErr != nil {
							c.logger.Error().Err(reconnectErr).Msg("Failed to reconnect")
						}
					}
				}
			}
		}
	}
}

// reconnect attempts to reconnect to RabbitMQ
func (c *Consumer) reconnect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.reconnecting {
		return nil
	}
	c.reconnecting = true
	defer func() { c.reconnecting = false }()

	c.logger.Info().Msg("Attempting to reconnect consumer")

	c.Close()

	startTime := time.Now()
	for {
		if time.Since(startTime) > c.cfg.RabbitMQ.MaxReconnectTime {
			return fmt.Errorf("max reconnect time exceeded")
		}

		err := c.connect()
		if err == nil {
			c.logger.Info().Msg("Successfully reconnected consumer")
			return nil
		}

		c.logger.Warn().Err(err).Msg("Reconnect attempt failed, retrying")
		time.Sleep(c.cfg.RabbitMQ.ReconnectDelay)
	}
}

// Stop stops the consumer
func (c *Consumer) Stop() {
	close(c.stopChan)
	<-c.doneChan
}

// Close closes the consumer connection
func (c *Consumer) Close() error {
	if c.channel != nil {
		if err := c.channel.Close(); err != nil {
			c.logger.Error().Err(err).Msg("Error closing channel")
		}
	}
	if c.conn != nil {
		if err := c.conn.Close(); err != nil {
			c.logger.Error().Err(err).Msg("Error closing connection")
		}
	}
	c.logger.Info().Msg("Consumer closed")
	return nil
}
