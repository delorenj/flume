/**
 * Unit tests for HealthChecker
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HealthChecker, DEFAULT_HEALTH_CONFIG, type HealthStatus } from './health-checker.js';

// Mock BloodbankPublisher
function createMockBloodbank(isConnected: boolean = true) {
  return {
    isConnected: vi.fn().mockReturnValue(isConnected),
    connect: vi.fn(),
    close: vi.fn(),
    publish: vi.fn(),
  };
}

// Mock HRDepartment
function createMockHR(agentCount: number = 0) {
  return {
    getAgentCount: vi.fn().mockReturnValue(agentCount),
    fulfillRequest: vi.fn(),
    quickHire: vi.fn(),
    registerFactory: vi.fn(),
    registerTeamContext: vi.fn(),
  };
}

describe('HealthChecker', () => {
  let healthChecker: HealthChecker;

  beforeEach(() => {
    healthChecker = new HealthChecker({ enableHttpServer: false });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await healthChecker.stop();
  });

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const checker = new HealthChecker();
      expect(checker).toBeDefined();
    });

    it('should merge provided config with defaults', () => {
      const checker = new HealthChecker({ httpPort: 9999 });
      expect(checker).toBeDefined();
    });
  });

  describe('status()', () => {
    it('should return healthy status when all components are healthy', () => {
      const bloodbank = createMockBloodbank(true);
      const hr = createMockHR(5);

      healthChecker.setBloodbank(bloodbank as unknown as Parameters<typeof healthChecker.setBloodbank>[0]);
      healthChecker.setHRDepartment(hr as unknown as Parameters<typeof healthChecker.setHRDepartment>[0]);

      const status = healthChecker.status();

      expect(status.status).toBe('healthy');
      expect(status.components.rabbitmq.healthy).toBe(true);
      expect(status.components.agents.healthy).toBe(true);
      expect(status.components.errorRate.healthy).toBe(true);
      expect(status.metrics.agentCount).toBe(5);
    });

    it('should return unhealthy status when RabbitMQ is disconnected', () => {
      const bloodbank = createMockBloodbank(false);
      healthChecker.setBloodbank(bloodbank as unknown as Parameters<typeof healthChecker.setBloodbank>[0]);

      const status = healthChecker.status();

      expect(status.status).toBe('unhealthy');
      expect(status.components.rabbitmq.healthy).toBe(false);
      expect(status.components.rabbitmq.message).toBe('Not connected to RabbitMQ');
    });

    it('should return degraded status when error rate exceeds threshold', () => {
      const bloodbank = createMockBloodbank(true);
      healthChecker.setBloodbank(bloodbank as unknown as Parameters<typeof healthChecker.setBloodbank>[0]);

      // Record many errors
      for (let i = 0; i < 10; i++) {
        healthChecker.recordRequest();
      }
      for (let i = 0; i < 5; i++) {
        healthChecker.recordError(); // 50% error rate
      }

      const status = healthChecker.status();

      expect(status.status).toBe('degraded');
      expect(status.components.errorRate.healthy).toBe(false);
      expect(status.metrics.errorRate).toBe(0.5);
    });

    it('should include correct timestamp format', () => {
      const status = healthChecker.status();

      expect(status.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should include uptime in seconds', () => {
      const status = healthChecker.status();

      expect(status.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof status.uptime).toBe('number');
    });
  });

  describe('request and error tracking', () => {
    it('should track total requests', () => {
      healthChecker.recordRequest();
      healthChecker.recordRequest();
      healthChecker.recordRequest();

      const status = healthChecker.status();

      expect(status.metrics.totalRequests).toBe(3);
    });

    it('should track errors within time window', () => {
      healthChecker.recordError();
      healthChecker.recordError();

      const status = healthChecker.status();

      expect(status.metrics.totalErrors).toBe(2);
    });

    it('should calculate error rate correctly', () => {
      healthChecker.recordRequest();
      healthChecker.recordRequest();
      healthChecker.recordRequest();
      healthChecker.recordRequest();
      healthChecker.recordError();

      const status = healthChecker.status();

      expect(status.metrics.errorRate).toBe(0.25);
    });

    it('should return 0 error rate when no requests', () => {
      const status = healthChecker.status();

      expect(status.metrics.errorRate).toBe(0);
    });
  });

  describe('active task tracking', () => {
    it('should track active task count', () => {
      healthChecker.setActiveTaskCount(5);

      const status = healthChecker.status();

      expect(status.metrics.activeTaskCount).toBe(5);
    });

    it('should increment active tasks', () => {
      healthChecker.incrementActiveTasks();
      healthChecker.incrementActiveTasks();
      healthChecker.incrementActiveTasks();

      const status = healthChecker.status();

      expect(status.metrics.activeTaskCount).toBe(3);
    });

    it('should decrement active tasks', () => {
      healthChecker.setActiveTaskCount(5);
      healthChecker.decrementActiveTasks();
      healthChecker.decrementActiveTasks();

      const status = healthChecker.status();

      expect(status.metrics.activeTaskCount).toBe(3);
    });

    it('should not go below zero when decrementing', () => {
      healthChecker.setActiveTaskCount(1);
      healthChecker.decrementActiveTasks();
      healthChecker.decrementActiveTasks();

      const status = healthChecker.status();

      expect(status.metrics.activeTaskCount).toBe(0);
    });
  });

  describe('component health checks', () => {
    it('should report unhealthy when bloodbank not configured', () => {
      const status = healthChecker.status();

      expect(status.components.rabbitmq.healthy).toBe(false);
      expect(status.components.rabbitmq.message).toBe('Bloodbank not configured');
    });

    it('should report healthy agents when HR not configured', () => {
      const status = healthChecker.status();

      // Should still be healthy, just with 0 agents
      expect(status.components.agents.healthy).toBe(true);
      expect(status.metrics.agentCount).toBe(0);
    });
  });

  describe('HTTP server', () => {
    it('should not start server when disabled', async () => {
      const checker = new HealthChecker({ enableHttpServer: false });
      await checker.start();
      // Should not throw and should complete quickly
      await checker.stop();
    });

    it('should start and stop server when enabled', async () => {
      // Use a random high port to avoid conflicts
      const port = 40000 + Math.floor(Math.random() * 10000);
      const checker = new HealthChecker({ enableHttpServer: true, httpPort: port });

      await checker.start();
      // Server should be running - we can verify by stopping it
      await checker.stop();
    });

    it('should handle /health endpoint', async () => {
      const port = 40000 + Math.floor(Math.random() * 10000);
      const checker = new HealthChecker({ enableHttpServer: true, httpPort: port });
      const bloodbank = createMockBloodbank(true);
      checker.setBloodbank(bloodbank as unknown as Parameters<typeof checker.setBloodbank>[0]);

      await checker.start();

      // Make HTTP request
      const response = await fetch(`http://localhost:${port}/health`);
      const data = await response.json() as HealthStatus;

      expect(response.status).toBe(200);
      expect(data.status).toBeDefined();
      expect(data.components).toBeDefined();
      expect(data.metrics).toBeDefined();

      await checker.stop();
    });

    it('should handle /ready endpoint', async () => {
      const port = 40000 + Math.floor(Math.random() * 10000);
      const checker = new HealthChecker({ enableHttpServer: true, httpPort: port });
      const bloodbank = createMockBloodbank(true);
      checker.setBloodbank(bloodbank as unknown as Parameters<typeof checker.setBloodbank>[0]);

      await checker.start();

      const response = await fetch(`http://localhost:${port}/ready`);
      const data = await response.json() as { ready: boolean };

      expect(response.status).toBe(200);
      expect(data.ready).toBe(true);

      await checker.stop();
    });

    it('should return 503 for /ready when not ready', async () => {
      const port = 40000 + Math.floor(Math.random() * 10000);
      const checker = new HealthChecker({ enableHttpServer: true, httpPort: port });
      const bloodbank = createMockBloodbank(false);
      checker.setBloodbank(bloodbank as unknown as Parameters<typeof checker.setBloodbank>[0]);

      await checker.start();

      const response = await fetch(`http://localhost:${port}/ready`);

      expect(response.status).toBe(503);

      await checker.stop();
    });

    it('should handle /live endpoint', async () => {
      const port = 40000 + Math.floor(Math.random() * 10000);
      const checker = new HealthChecker({ enableHttpServer: true, httpPort: port });

      await checker.start();

      const response = await fetch(`http://localhost:${port}/live`);
      const data = await response.json() as { alive: boolean };

      expect(response.status).toBe(200);
      expect(data.alive).toBe(true);

      await checker.stop();
    });

    it('should return 404 for unknown endpoints', async () => {
      const port = 40000 + Math.floor(Math.random() * 10000);
      const checker = new HealthChecker({ enableHttpServer: true, httpPort: port });

      await checker.start();

      const response = await fetch(`http://localhost:${port}/unknown`);

      expect(response.status).toBe(404);

      await checker.stop();
    });
  });
});
