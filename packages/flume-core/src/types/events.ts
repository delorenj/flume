/**
 * Event Types - Bloodbank integration
 *
 * Every significant action in Flume emits a Bloodbank event.
 * Events follow CloudEvents spec with 33GOD extensions.
 *
 * @category Event
 */

/**
 * Base Bloodbank event interface.
 * All events must be traceable through correlation chains.
 */
export interface BloodbankEvent {
  /** Event type (e.g., 'yi.agent.state.changed') */
  event: string;

  /** Schema version */
  version: string;

  /** Event payload */
  data: Record<string, unknown>;

  /** RabbitMQ exchange */
  exchange: string;

  /** Routing key for topic exchange */
  routingKey: string;

  /** Links related events across the system */
  correlationId: string;

  /** What triggered this event (parent event ID) */
  causationId?: string;

  /** ISO timestamp */
  timestamp: string;

  /** Component that emitted the event */
  source: string;
}

/**
 * Event categories for routing.
 */
export const EVENT_CATEGORIES = {
  // Agent lifecycle events
  AGENT_CREATED: 'yi.agent.created',
  AGENT_ONBOARDING: 'yi.agent.onboarding',
  AGENT_STATE_CHANGED: 'yi.agent.state.changed',
  AGENT_TERMINATED: 'yi.agent.terminated',

  // Task lifecycle events
  TASK_CREATED: 'flume.task.created',
  TASK_ASSIGNED: 'flume.task.assigned',
  TASK_STARTED: 'flume.task.started',
  TASK_COMPLETED: 'flume.task.completed',
  TASK_FAILED: 'flume.task.failed',
  TASK_BLOCKED: 'flume.task.blocked',
  TASK_DELEGATED: 'flume.task.delegated',

  // Selection events
  SELECTION_STARTED: 'yi.selection.started',
  SELECTION_CANDIDATE_EVALUATED: 'yi.selection.candidate.evaluated',
  SELECTION_COMPLETED: 'yi.selection.completed',

  // Team events
  TEAM_RECRUIT_REQUESTED: 'yi.team.recruit.requested',
  TEAM_MEMBER_ADDED: 'yi.team.member.added',
  TEAM_MEMBER_REMOVED: 'yi.team.member.removed',

  // Artifact events
  ARTIFACT_CREATED: 'flume.artifact.created',
} as const;

/**
 * Event publisher interface.
 * Implementations connect to RabbitMQ or other message brokers.
 */
export interface EventPublisher {
  /**
   * Publish an event to Bloodbank.
   */
  publish(event: BloodbankEvent): Promise<void>;

  /**
   * Close the connection.
   */
  close(): Promise<void>;
}

/**
 * Event subscriber interface.
 * Used for consuming events (e.g., for observability).
 */
export interface EventSubscriber {
  /**
   * Subscribe to events matching a pattern.
   * @param pattern - Routing key pattern (e.g., 'yi.agent.*')
   * @param handler - Callback for each event
   */
  subscribe(
    pattern: string,
    handler: (event: BloodbankEvent) => Promise<void>
  ): Promise<void>;

  /**
   * Unsubscribe from a pattern.
   */
  unsubscribe(pattern: string): Promise<void>;

  /**
   * Close the connection.
   */
  close(): Promise<void>;
}

/**
 * Create a standard event with required fields.
 */
export function createEvent(
  eventType: string,
  data: Record<string, unknown>,
  correlationId: string,
  source: string,
  causationId?: string
): BloodbankEvent {
  return {
    event: eventType,
    version: '1.0.0',
    data,
    exchange: 'amq.topic',
    routingKey: eventType,
    correlationId,
    causationId,
    timestamp: new Date().toISOString(),
    source,
  };
}
