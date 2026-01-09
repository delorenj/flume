/**
 * Health Checker - Monitor Yi process health
 *
 * Provides health status for:
 * - RabbitMQ connection status
 * - Agent count
 * - Error rate tracking
 * - Optional HTTP endpoint
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { BloodbankPublisher } from '../events/bloodbank-publisher.js';
import type { HRDepartment } from '../hr/hr-department.js';

/**
 * Health check configuration.
 */
export interface HealthCheckerConfig {
  /** Enable HTTP server for /health endpoint */
  enableHttpServer: boolean;
  /** HTTP server port (default: 8080) */
  httpPort: number;
  /** Error rate threshold for unhealthy status (0-1, default: 0.1 = 10%) */
  errorRateThreshold: number;
  /** Window size in ms for error rate calculation (default: 60000 = 1 minute) */
  errorRateWindowMs: number;
}

/**
 * Default health checker configuration.
 */
export const DEFAULT_HEALTH_CONFIG: HealthCheckerConfig = {
  enableHttpServer: true,
  httpPort: parseInt(process.env.HEALTH_PORT ?? '8080', 10),
  errorRateThreshold: 0.1,
  errorRateWindowMs: 60000,
};

/**
 * Health status for a single component.
 */
export interface ComponentHealth {
  healthy: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Overall health status.
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  components: {
    rabbitmq: ComponentHealth;
    agents: ComponentHealth;
    errorRate: ComponentHealth;
  };
  metrics: {
    totalRequests: number;
    totalErrors: number;
    errorRate: number;
    agentCount: number;
    activeTaskCount: number;
  };
}

/**
 * Error tracking entry.
 */
interface ErrorEntry {
  timestamp: number;
}

/**
 * Health checker for Yi adapter.
 */
export class HealthChecker {
  private config: HealthCheckerConfig;
  private server: Server | null = null;
  private startTime: number;
  private totalRequests = 0;
  private errorHistory: ErrorEntry[] = [];
  private bloodbank: BloodbankPublisher | null = null;
  private hr: HRDepartment | null = null;
  private activeTaskCount = 0;

  constructor(config: Partial<HealthCheckerConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
    this.startTime = Date.now();
  }

  /**
   * Set the Bloodbank publisher for connection status checks.
   */
  setBloodbank(bloodbank: BloodbankPublisher): void {
    this.bloodbank = bloodbank;
  }

  /**
   * Set the HR department for agent count checks.
   */
  setHRDepartment(hr: HRDepartment): void {
    this.hr = hr;
  }

  /**
   * Start the HTTP health server if enabled.
   */
  async start(): Promise<void> {
    if (!this.config.enableHttpServer) {
      console.log('[HealthChecker] HTTP server disabled');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        console.error('[HealthChecker] Server error:', error);
        reject(error);
      });

      this.server.listen(this.config.httpPort, () => {
        console.log(`[HealthChecker] HTTP server listening on port ${this.config.httpPort}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log('[HealthChecker] HTTP server stopped');
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * Handle incoming HTTP requests.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health' || req.url === '/healthz') {
      const status = this.status();
      const statusCode = status.status === 'healthy' ? 200 : status.status === 'degraded' ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
    } else if (req.url === '/ready' || req.url === '/readyz') {
      // Readiness probe - only healthy if all critical components are up
      const status = this.status();
      const isReady = status.components.rabbitmq.healthy;
      const statusCode = isReady ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: isReady, timestamp: status.timestamp }));
    } else if (req.url === '/live' || req.url === '/livez') {
      // Liveness probe - always healthy if process is running
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive: true, timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  /**
   * Record a request for metrics.
   */
  recordRequest(): void {
    this.totalRequests++;
  }

  /**
   * Record an error for metrics.
   */
  recordError(): void {
    this.errorHistory.push({ timestamp: Date.now() });
    this.pruneErrorHistory();
  }

  /**
   * Update active task count.
   */
  setActiveTaskCount(count: number): void {
    this.activeTaskCount = count;
  }

  /**
   * Increment active task count.
   */
  incrementActiveTasks(): void {
    this.activeTaskCount++;
  }

  /**
   * Decrement active task count.
   */
  decrementActiveTasks(): void {
    this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
  }

  /**
   * Get current health status.
   */
  status(): HealthStatus {
    this.pruneErrorHistory();

    const now = Date.now();
    const uptime = (now - this.startTime) / 1000; // seconds
    const errorRate = this.calculateErrorRate();
    const agentCount = this.getAgentCount();

    // Check RabbitMQ connection
    const rabbitmqHealth = this.checkRabbitMQ();

    // Check agent status
    const agentsHealth = this.checkAgents(agentCount);

    // Check error rate
    const errorRateHealth = this.checkErrorRate(errorRate);

    // Determine overall status
    const components = {
      rabbitmq: rabbitmqHealth,
      agents: agentsHealth,
      errorRate: errorRateHealth,
    };

    const healthyCount = Object.values(components).filter((c) => c.healthy).length;
    const totalCount = Object.values(components).length;

    let status: HealthStatus['status'];
    if (healthyCount === totalCount) {
      status = 'healthy';
    } else if (!rabbitmqHealth.healthy) {
      // RabbitMQ is critical
      status = 'unhealthy';
    } else {
      status = 'degraded';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime,
      components,
      metrics: {
        totalRequests: this.totalRequests,
        totalErrors: this.errorHistory.length,
        errorRate,
        agentCount,
        activeTaskCount: this.activeTaskCount,
      },
    };
  }

  /**
   * Check RabbitMQ connection status.
   */
  private checkRabbitMQ(): ComponentHealth {
    if (!this.bloodbank) {
      return {
        healthy: false,
        message: 'Bloodbank not configured',
      };
    }

    // Check if bloodbank has isConnected method
    const isConnected = (this.bloodbank as unknown as { isConnected?: () => boolean }).isConnected?.() ?? false;

    return {
      healthy: isConnected,
      message: isConnected ? 'Connected to RabbitMQ' : 'Not connected to RabbitMQ',
    };
  }

  /**
   * Check agent status.
   */
  private checkAgents(agentCount: number): ComponentHealth {
    if (!this.hr) {
      return {
        healthy: true,
        message: 'HR department not configured',
        details: { agentCount: 0 },
      };
    }

    return {
      healthy: true,
      message: `${agentCount} agents registered`,
      details: { agentCount },
    };
  }

  /**
   * Check error rate.
   */
  private checkErrorRate(errorRate: number): ComponentHealth {
    const healthy = errorRate <= this.config.errorRateThreshold;

    return {
      healthy,
      message: healthy
        ? `Error rate ${(errorRate * 100).toFixed(2)}% is within threshold`
        : `Error rate ${(errorRate * 100).toFixed(2)}% exceeds threshold of ${this.config.errorRateThreshold * 100}%`,
      details: {
        errorRate,
        threshold: this.config.errorRateThreshold,
        windowMs: this.config.errorRateWindowMs,
      },
    };
  }

  /**
   * Calculate current error rate.
   */
  private calculateErrorRate(): number {
    if (this.totalRequests === 0) {
      return 0;
    }

    return this.errorHistory.length / this.totalRequests;
  }

  /**
   * Get current agent count from HR department.
   */
  private getAgentCount(): number {
    if (!this.hr) {
      return 0;
    }

    // Check if HR has getAgentCount method
    const agentCount = (this.hr as unknown as { getAgentCount?: () => number }).getAgentCount?.() ?? 0;
    return agentCount;
  }

  /**
   * Remove old errors from history.
   */
  private pruneErrorHistory(): void {
    const cutoff = Date.now() - this.config.errorRateWindowMs;
    this.errorHistory = this.errorHistory.filter((e) => e.timestamp >= cutoff);
  }
}
