/**
 * Bloodbank Publisher - RabbitMQ event publisher
 *
 * All state changes in Yi agents emit events to Bloodbank.
 * Uses amq.topic exchange per 33GOD standards.
 */

import type {
  BloodbankEvent,
  EventPublisher,
} from '@flume/core';
import { createEvent, EVENT_CATEGORIES } from '@flume/core';

/**
 * Configuration for Bloodbank connection.
 */
export interface BloodbankConfig {
  url: string;       // amqp://user:pass@host:port
  exchange: string;  // amq.topic
}

/**
 * Default Bloodbank configuration for 33GOD.
 */
export const DEFAULT_BLOODBANK_CONFIG: BloodbankConfig = {
  url: process.env.RABBITMQ_URL ?? 'amqp://delorenj:REDACTED_CREDENTIAL@192.168.1.12:5672',
  exchange: 'amq.topic',
};

/**
 * RabbitMQ-based Bloodbank event publisher.
 */
export class BloodbankPublisher implements EventPublisher {
  private connection: unknown = null;
  private channel: unknown = null;
  private connected = false;
  private pendingEvents: BloodbankEvent[] = [];

  constructor(
    private config: BloodbankConfig = DEFAULT_BLOODBANK_CONFIG,
    private source: string = 'yi.adapter'
  ) {}

  /**
   * Connect to RabbitMQ.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      // Dynamic import to avoid requiring amqplib during testing
      const amqp = await import('amqplib');
      this.connection = await amqp.connect(this.config.url);
      this.channel = await (this.connection as { createChannel: () => Promise<unknown> }).createChannel();

      // Assert exchange exists
      await (this.channel as { assertExchange: (name: string, type: string, options: { durable: boolean }) => Promise<void> }).assertExchange(
        this.config.exchange,
        'topic',
        { durable: true }
      );

      this.connected = true;
      console.log(`[Bloodbank] Connected to ${this.config.url}`);

      // Flush pending events
      for (const event of this.pendingEvents) {
        await this.publishToChannel(event);
      }
      this.pendingEvents = [];
    } catch (error) {
      console.error(`[Bloodbank] Connection failed:`, error);
      throw error;
    }
  }

  /**
   * Publish an event to Bloodbank.
   */
  async publish(event: BloodbankEvent): Promise<void> {
    if (!this.connected) {
      // Queue event for later if not connected
      console.log(`[Bloodbank] Queueing event: ${event.event}`);
      this.pendingEvents.push(event);
      return;
    }

    await this.publishToChannel(event);
  }

  /**
   * Publish to the actual channel.
   */
  private async publishToChannel(event: BloodbankEvent): Promise<void> {
    if (!this.channel) return;

    const message = JSON.stringify(event);
    const ch = this.channel as {
      publish: (
        exchange: string,
        routingKey: string,
        content: Buffer,
        options: { persistent: boolean; contentType: string; correlationId: string }
      ) => boolean;
    };

    ch.publish(
      this.config.exchange,
      event.routingKey,
      Buffer.from(message),
      {
        persistent: true,
        contentType: 'application/json',
        correlationId: event.correlationId,
      }
    );

    console.log(
      `[Bloodbank] Published: ${event.event} -> ${event.routingKey}`
    );
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    if (this.channel) {
      await (this.channel as { close: () => Promise<void> }).close();
    }
    if (this.connection) {
      await (this.connection as { close: () => Promise<void> }).close();
    }
    this.connected = false;
    console.log('[Bloodbank] Disconnected');
  }

  // ============================================================================
  // Convenience methods for common events
  // ============================================================================

  /**
   * Emit agent state change event.
   */
  async emitStateChange(
    agentId: string,
    agentName: string,
    fromState: string,
    toState: string,
    trigger: string,
    correlationId: string,
    taskId?: string
  ): Promise<void> {
    const event = createEvent(
      EVENT_CATEGORIES.AGENT_STATE_CHANGED,
      {
        agentId,
        agentName,
        fromState,
        toState,
        trigger,
        taskId,
      },
      correlationId,
      this.source
    );

    await this.publish(event);
  }

  /**
   * Emit agent created event.
   */
  async emitAgentCreated(
    agentId: string,
    agentName: string,
    role: string,
    teamId: string,
    correlationId: string
  ): Promise<void> {
    const event = createEvent(
      EVENT_CATEGORIES.AGENT_CREATED,
      {
        agentId,
        agentName,
        role,
        teamId,
      },
      correlationId,
      this.source
    );

    await this.publish(event);
  }

  /**
   * Emit task delegated event.
   */
  async emitTaskDelegated(
    taskId: string,
    fromAgentId: string,
    toAgentId: string,
    objective: string,
    correlationId: string,
    depth: number
  ): Promise<void> {
    const event = createEvent(
      EVENT_CATEGORIES.TASK_DELEGATED,
      {
        taskId,
        fromAgentId,
        toAgentId,
        objective,
        depth,
      },
      correlationId,
      this.source
    );

    await this.publish(event);
  }

  /**
   * Emit task completed event.
   */
  async emitTaskCompleted(
    taskId: string,
    agentId: string,
    status: string,
    durationMs: number,
    correlationId: string
  ): Promise<void> {
    const event = createEvent(
      EVENT_CATEGORIES.TASK_COMPLETED,
      {
        taskId,
        agentId,
        status,
        durationMs,
      },
      correlationId,
      this.source
    );

    await this.publish(event);
  }

  /**
   * Emit selection completed event.
   */
  async emitSelectionCompleted(
    taskId: string,
    managerId: string,
    selectedAgentId: string | null,
    strategyUsed: string,
    candidateCount: number,
    correlationId: string
  ): Promise<void> {
    const event = createEvent(
      EVENT_CATEGORIES.SELECTION_COMPLETED,
      {
        taskId,
        managerId,
        selectedAgentId,
        strategyUsed,
        candidateCount,
      },
      correlationId,
      this.source
    );

    await this.publish(event);
  }
}

/**
 * Console-based publisher for testing without RabbitMQ.
 */
export class ConsoleEventPublisher implements EventPublisher {
  private source: string;

  constructor(source = 'yi.adapter') {
    this.source = source;
  }

  async publish(event: BloodbankEvent): Promise<void> {
    console.log(`[EVENT] ${event.event}`);
    console.log(`  Routing: ${event.routingKey}`);
    console.log(`  Correlation: ${event.correlationId}`);
    console.log(`  Data: ${JSON.stringify(event.data, null, 2)}`);
  }

  async close(): Promise<void> {
    // No-op for console publisher
  }
}
