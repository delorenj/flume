/**
 * Unit tests for BloodbankPublisher and ConsoleEventPublisher
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BloodbankPublisher, ConsoleEventPublisher, DEFAULT_BLOODBANK_CONFIG } from './bloodbank-publisher.js';
import type { BloodbankEvent } from '@flume/core';

/**
 * Create a mock event for testing.
 */
function createMockEvent(overrides: Partial<BloodbankEvent> = {}): BloodbankEvent {
  return {
    event: 'yi.agent.created',
    version: '1.0.0',
    data: { agentId: 'agent-123' },
    exchange: 'amq.topic',
    routingKey: 'yi.agent.created',
    correlationId: 'corr-456',
    timestamp: new Date().toISOString(),
    source: 'yi.adapter',
    ...overrides,
  };
}

describe('DEFAULT_BLOODBANK_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_BLOODBANK_CONFIG.exchange).toBe('amq.topic');
    expect(DEFAULT_BLOODBANK_CONFIG.url).toBeDefined();
  });
});

describe('BloodbankPublisher', () => {
  let publisher: BloodbankPublisher;

  beforeEach(() => {
    publisher = new BloodbankPublisher();
  });

  describe('constructor', () => {
    it('should create publisher with default config', () => {
      const pub = new BloodbankPublisher();
      expect(pub.isConnected()).toBe(false);
    });

    it('should create publisher with custom config', () => {
      const customConfig = {
        url: 'amqp://localhost:5672',
        exchange: 'custom.exchange',
      };
      const pub = new BloodbankPublisher(customConfig);
      expect(pub.isConnected()).toBe(false);
    });

    it('should create publisher with custom source', () => {
      const pub = new BloodbankPublisher(DEFAULT_BLOODBANK_CONFIG, 'custom.source');
      expect(pub.isConnected()).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('should return false before connect', () => {
      expect(publisher.isConnected()).toBe(false);
    });
  });

  describe('publish (when not connected)', () => {
    it('should queue events when not connected', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const event = createMockEvent();

      await publisher.publish(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queueing event')
      );
      consoleSpy.mockRestore();
    });

    it('should queue multiple events', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await publisher.publish(createMockEvent({ event: 'event.1' }));
      await publisher.publish(createMockEvent({ event: 'event.2' }));
      await publisher.publish(createMockEvent({ event: 'event.3' }));

      expect(consoleSpy).toHaveBeenCalledTimes(3);
      consoleSpy.mockRestore();
    });
  });

  describe('emitStateChange', () => {
    it('should queue state change event when not connected', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await publisher.emitStateChange(
        'agent-123',
        'Test Agent',
        'idle',
        'working',
        'task_assigned',
        'corr-456',
        'task-789'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queueing event')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('emitAgentCreated', () => {
    it('should queue agent created event when not connected', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await publisher.emitAgentCreated(
        'agent-123',
        'Test Agent',
        'developer',
        'team-1',
        'corr-456'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queueing event')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('emitTaskDelegated', () => {
    it('should queue task delegated event when not connected', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await publisher.emitTaskDelegated(
        'task-123',
        'manager-1',
        'contributor-1',
        'Test objective',
        'corr-456',
        1
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queueing event')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('emitTaskCompleted', () => {
    it('should queue task completed event when not connected', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await publisher.emitTaskCompleted(
        'task-123',
        'agent-1',
        'success',
        1500,
        'corr-456'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queueing event')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('emitSelectionCompleted', () => {
    it('should queue selection completed event when not connected', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await publisher.emitSelectionCompleted(
        'task-123',
        'manager-1',
        'contributor-1',
        'round-robin',
        5,
        'corr-456'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queueing event')
      );
      consoleSpy.mockRestore();
    });

    it('should handle null selected agent', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await publisher.emitSelectionCompleted(
        'task-123',
        'manager-1',
        null,
        'first-match',
        3,
        'corr-456'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queueing event')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('close (when not connected)', () => {
    it('should not throw when closing without connection', async () => {
      await expect(publisher.close()).resolves.not.toThrow();
    });
  });
});

describe('ConsoleEventPublisher', () => {
  let publisher: ConsoleEventPublisher;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    publisher = new ConsoleEventPublisher();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should create publisher with default source', () => {
      const pub = new ConsoleEventPublisher();
      expect(pub).toBeDefined();
    });

    it('should create publisher with custom source', () => {
      const pub = new ConsoleEventPublisher('custom.source');
      expect(pub).toBeDefined();
    });
  });

  describe('publish', () => {
    it('should log event details to console', async () => {
      const event = createMockEvent();

      await publisher.publish(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EVENT]')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Routing:')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Correlation:')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Data:')
      );
    });

    it('should include event name in output', async () => {
      const event = createMockEvent({ event: 'yi.custom.event' });

      await publisher.publish(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('yi.custom.event')
      );
    });

    it('should include routing key in output', async () => {
      const event = createMockEvent({ routingKey: 'custom.routing.key' });

      await publisher.publish(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('custom.routing.key')
      );
    });

    it('should include correlation ID in output', async () => {
      const event = createMockEvent({ correlationId: 'unique-correlation-123' });

      await publisher.publish(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('unique-correlation-123')
      );
    });
  });

  describe('close', () => {
    it('should complete without error', async () => {
      await expect(publisher.close()).resolves.not.toThrow();
    });

    it('should be idempotent', async () => {
      await publisher.close();
      await publisher.close();
      await publisher.close();
      // Should not throw
    });
  });
});
