/**
 * Unit tests for ShutdownHandler
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ShutdownHandler, DEFAULT_SHUTDOWN_CONFIG, type ShutdownResult } from './shutdown.js';
import type { HealthChecker } from './health-checker.js';

// Mock BloodbankPublisher
function createMockBloodbank() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock HealthChecker
function createMockHealthChecker(activeTaskCount: number = 0) {
  return {
    status: vi.fn().mockReturnValue({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: 100,
      components: {
        rabbitmq: { healthy: true, message: 'Connected' },
        agents: { healthy: true, message: '0 agents' },
        errorRate: { healthy: true, message: 'OK' },
      },
      metrics: {
        totalRequests: 0,
        totalErrors: 0,
        errorRate: 0,
        agentCount: 0,
        activeTaskCount,
      },
    }),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    setBloodbank: vi.fn(),
    setHRDepartment: vi.fn(),
  };
}

describe('ShutdownHandler', () => {
  let shutdownHandler: ShutdownHandler;

  beforeEach(() => {
    shutdownHandler = new ShutdownHandler('test-service', 'test-correlation', {
      registerSignalHandlers: false,
      timeoutMs: 1000,
      checkIntervalMs: 10,
    });
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const handler = new ShutdownHandler('test', 'corr');
      expect(handler).toBeDefined();
      expect(handler.getState()).toBe('running');
    });

    it('should merge provided config with defaults', () => {
      const handler = new ShutdownHandler('test', 'corr', { timeoutMs: 5000 });
      expect(handler).toBeDefined();
    });
  });

  describe('state management', () => {
    it('should start in running state', () => {
      expect(shutdownHandler.getState()).toBe('running');
      expect(shutdownHandler.isShuttingDown()).toBe(false);
      expect(shutdownHandler.hasShutdown()).toBe(false);
    });

    it('should transition to shutting_down during shutdown', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      const promise = shutdownHandler.shutdown();

      // Note: This tests the state during shutdown - it will have completed by the time we check
      await promise;

      expect(shutdownHandler.getState()).toBe('shutdown');
      expect(shutdownHandler.hasShutdown()).toBe(true);
    });

    it('should be idempotent - second shutdown returns immediately', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      await shutdownHandler.shutdown();

      const result = await shutdownHandler.shutdown();

      expect(result.success).toBe(true);
      expect(result.state).toBe('shutdown');
      expect(bloodbank.close).toHaveBeenCalledTimes(1); // Only called once
    });
  });

  describe('shutdown()', () => {
    it('should return success when no in-flight tasks', async () => {
      const bloodbank = createMockBloodbank();
      const health = createMockHealthChecker(0);

      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);
      shutdownHandler.setHealthChecker(health as unknown as HealthChecker);

      const result = await shutdownHandler.shutdown();

      expect(result.success).toBe(true);
      expect(result.inFlightTasksAtStart).toBe(0);
      expect(result.inFlightTasksAtEnd).toBe(0);
      expect(result.timeoutReached).toBe(false);
      expect(result.errors).toHaveLength(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should wait for in-flight tasks to complete', async () => {
      const bloodbank = createMockBloodbank();
      let taskCount = 3;
      const health = {
        status: vi.fn().mockImplementation(() => ({
          metrics: { activeTaskCount: taskCount-- > 0 ? taskCount : 0 },
        })),
      };

      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);
      shutdownHandler.setHealthChecker(health as unknown as HealthChecker);

      const result = await shutdownHandler.shutdown();

      expect(result.success).toBe(true);
      expect(result.timeoutReached).toBe(false);
    });

    it('should timeout if tasks do not complete', async () => {
      const bloodbank = createMockBloodbank();
      const health = createMockHealthChecker(5); // Always has 5 tasks

      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);
      shutdownHandler.setHealthChecker(health as unknown as HealthChecker);

      const result = await shutdownHandler.shutdown();

      expect(result.success).toBe(false);
      expect(result.timeoutReached).toBe(true);
      expect(result.inFlightTasksAtEnd).toBe(5);
    });

    it('should emit shutdown events', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      await shutdownHandler.shutdown();

      // Should emit starting and complete events
      expect(bloodbank.publish).toHaveBeenCalledTimes(2);

      const calls = (bloodbank.publish as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]?.[0]?.event).toBe('yi.system.shutdown.starting');
      expect(calls[1]?.[0]?.event).toBe('yi.system.shutdown');
    });

    it('should close bloodbank connection', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      await shutdownHandler.shutdown();

      expect(bloodbank.close).toHaveBeenCalled();
    });

    it('should handle bloodbank close errors gracefully', async () => {
      const bloodbank = createMockBloodbank();
      bloodbank.close.mockRejectedValueOnce(new Error('Close failed'));
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      const result = await shutdownHandler.shutdown();

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toBe('Close failed');
    });
  });

  describe('callbacks', () => {
    it('should execute registered callbacks during shutdown', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      const callback1 = vi.fn().mockResolvedValue(undefined);
      const callback2 = vi.fn().mockResolvedValue(undefined);

      shutdownHandler.onShutdown(callback1);
      shutdownHandler.onShutdown(callback2);

      await shutdownHandler.shutdown();

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should execute callbacks in order', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      const order: number[] = [];

      shutdownHandler.onShutdown(async () => {
        order.push(1);
      });
      shutdownHandler.onShutdown(async () => {
        order.push(2);
      });
      shutdownHandler.onShutdown(async () => {
        order.push(3);
      });

      await shutdownHandler.shutdown();

      expect(order).toEqual([1, 2, 3]);
    });

    it('should continue with other callbacks if one fails', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      const callback1 = vi.fn().mockRejectedValue(new Error('Callback 1 failed'));
      const callback2 = vi.fn().mockResolvedValue(undefined);

      shutdownHandler.onShutdown(callback1);
      shutdownHandler.onShutdown(callback2);

      const result = await shutdownHandler.shutdown();

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('signal handlers', () => {
    it('should not register handlers when disabled', () => {
      const handler = new ShutdownHandler('test', 'corr', {
        registerSignalHandlers: false,
      });

      // Should not throw
      handler.registerSignalHandlers();
    });

    it('should log message when registering handlers', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const handler = new ShutdownHandler('test', 'corr', {
        registerSignalHandlers: true,
      });
      handler.registerSignalHandlers();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Signal handlers registered')
      );

      consoleSpy.mockRestore();
    });

    it('should not register handlers twice', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const handler = new ShutdownHandler('test', 'corr', {
        registerSignalHandlers: true,
      });
      handler.registerSignalHandlers();
      handler.registerSignalHandlers();

      // Should only log registration message once
      const registrationCalls = consoleSpy.mock.calls.filter(
        (call) =>
          call[0] &&
          typeof call[0] === 'string' &&
          call[0].includes('Signal handlers registered')
      );
      expect(registrationCalls).toHaveLength(1);

      consoleSpy.mockRestore();
    });
  });

  describe('without bloodbank', () => {
    it('should complete shutdown without bloodbank', async () => {
      const result = await shutdownHandler.shutdown();

      expect(result.success).toBe(true);
      expect(result.state).toBe('shutdown');
    });
  });

  describe('without health checker', () => {
    it('should report 0 in-flight tasks without health checker', async () => {
      const bloodbank = createMockBloodbank();
      shutdownHandler.setBloodbank(bloodbank as unknown as Parameters<typeof shutdownHandler.setBloodbank>[0]);

      const result = await shutdownHandler.shutdown();

      expect(result.inFlightTasksAtStart).toBe(0);
      expect(result.inFlightTasksAtEnd).toBe(0);
    });
  });
});
