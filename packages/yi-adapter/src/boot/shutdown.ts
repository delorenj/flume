/**
 * Graceful Shutdown Handler
 *
 * Handles graceful shutdown of the Yi system:
 * - Registers SIGTERM/SIGINT signal handlers
 * - Stops accepting new tasks
 * - Waits for in-flight tasks to complete (with timeout)
 * - Closes connections cleanly
 * - Emits shutdown event to Bloodbank
 */

import type { BloodbankPublisher } from '../events/bloodbank-publisher.js';
import type { HealthChecker } from './health-checker.js';

/**
 * Shutdown configuration.
 */
export interface ShutdownConfig {
  /** Shutdown timeout in milliseconds (default: 30000 = 30s) */
  timeoutMs: number;
  /** Interval to check for in-flight tasks in milliseconds (default: 100) */
  checkIntervalMs: number;
  /** Whether to register signal handlers (default: true) */
  registerSignalHandlers: boolean;
}

/**
 * Default shutdown configuration.
 */
export const DEFAULT_SHUTDOWN_CONFIG: ShutdownConfig = {
  timeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '30000', 10),
  checkIntervalMs: 100,
  registerSignalHandlers: true,
};

/**
 * Shutdown state.
 */
export type ShutdownState = 'running' | 'shutting_down' | 'shutdown';

/**
 * Shutdown result.
 */
export interface ShutdownResult {
  success: boolean;
  state: ShutdownState;
  inFlightTasksAtStart: number;
  inFlightTasksAtEnd: number;
  timeoutReached: boolean;
  durationMs: number;
  errors: Error[];
}

/**
 * Shutdown callback type.
 */
export type ShutdownCallback = () => Promise<void>;

/**
 * Graceful shutdown handler for Yi system.
 */
export class ShutdownHandler {
  private config: ShutdownConfig;
  private state: ShutdownState = 'running';
  private bloodbank: BloodbankPublisher | null = null;
  private healthChecker: HealthChecker | null = null;
  private serviceName: string;
  private correlationId: string;
  private callbacks: ShutdownCallback[] = [];
  private signalHandlersRegistered = false;

  constructor(
    serviceName: string,
    correlationId: string,
    config: Partial<ShutdownConfig> = {}
  ) {
    this.serviceName = serviceName;
    this.correlationId = correlationId;
    this.config = { ...DEFAULT_SHUTDOWN_CONFIG, ...config };
  }

  /**
   * Set the Bloodbank publisher for shutdown events.
   */
  setBloodbank(bloodbank: BloodbankPublisher): void {
    this.bloodbank = bloodbank;
  }

  /**
   * Set the health checker for in-flight task tracking.
   */
  setHealthChecker(healthChecker: HealthChecker): void {
    this.healthChecker = healthChecker;
  }

  /**
   * Register a callback to be called during shutdown.
   * Callbacks are executed in order of registration.
   */
  onShutdown(callback: ShutdownCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Register signal handlers for graceful shutdown.
   */
  registerSignalHandlers(): void {
    if (this.signalHandlersRegistered || !this.config.registerSignalHandlers) {
      return;
    }

    const handleSignal = (signal: string) => {
      console.log(`\n[Shutdown] Received ${signal}, initiating graceful shutdown...`);
      this.shutdown()
        .then((result) => {
          const exitCode = result.success ? 0 : 1;
          console.log(`[Shutdown] Exiting with code ${exitCode}`);
          process.exit(exitCode);
        })
        .catch((error) => {
          console.error('[Shutdown] Shutdown failed:', error);
          process.exit(1);
        });
    };

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));

    this.signalHandlersRegistered = true;
    console.log('[Shutdown] Signal handlers registered (SIGTERM, SIGINT)');
  }

  /**
   * Check if shutdown is in progress.
   */
  isShuttingDown(): boolean {
    return this.state === 'shutting_down';
  }

  /**
   * Check if system has shut down.
   */
  hasShutdown(): boolean {
    return this.state === 'shutdown';
  }

  /**
   * Get current state.
   */
  getState(): ShutdownState {
    return this.state;
  }

  /**
   * Initiate graceful shutdown.
   */
  async shutdown(): Promise<ShutdownResult> {
    if (this.state !== 'running') {
      return {
        success: this.state === 'shutdown',
        state: this.state,
        inFlightTasksAtStart: 0,
        inFlightTasksAtEnd: 0,
        timeoutReached: false,
        durationMs: 0,
        errors: [],
      };
    }

    const startTime = Date.now();
    const errors: Error[] = [];
    let timeoutReached = false;

    console.log('[Shutdown] Starting graceful shutdown...');
    this.state = 'shutting_down';

    // Get in-flight task count
    const inFlightTasksAtStart = this.getInFlightTaskCount();
    console.log(`[Shutdown] In-flight tasks at start: ${inFlightTasksAtStart}`);

    // Step 1: Emit shutdown starting event
    await this.emitShutdownEvent('yi.system.shutdown.starting', {
      inFlightTasks: inFlightTasksAtStart,
      timeoutMs: this.config.timeoutMs,
    });

    // Step 2: Wait for in-flight tasks (with timeout)
    if (inFlightTasksAtStart > 0) {
      console.log(`[Shutdown] Waiting for ${inFlightTasksAtStart} in-flight tasks...`);
      timeoutReached = await this.waitForInFlightTasks();
    }

    const inFlightTasksAtEnd = this.getInFlightTaskCount();

    if (timeoutReached) {
      console.warn(`[Shutdown] Timeout reached with ${inFlightTasksAtEnd} tasks still in flight`);
    } else {
      console.log('[Shutdown] All in-flight tasks completed');
    }

    // Step 3: Execute registered callbacks
    console.log(`[Shutdown] Executing ${this.callbacks.length} shutdown callbacks...`);
    for (const callback of this.callbacks) {
      try {
        await callback();
      } catch (error) {
        console.error('[Shutdown] Callback error:', error);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Step 4: Emit shutdown complete event
    await this.emitShutdownEvent('yi.system.shutdown', {
      inFlightTasksAtStart,
      inFlightTasksAtEnd,
      timeoutReached,
      durationMs: Date.now() - startTime,
      errorCount: errors.length,
    });

    // Step 5: Close Bloodbank connection
    if (this.bloodbank) {
      try {
        await this.bloodbank.close();
        console.log('[Shutdown] Bloodbank connection closed');
      } catch (error) {
        console.error('[Shutdown] Error closing Bloodbank:', error);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.state = 'shutdown';
    const durationMs = Date.now() - startTime;
    const success = errors.length === 0 && !timeoutReached;

    console.log(`[Shutdown] Shutdown complete in ${durationMs}ms (success: ${success})`);

    return {
      success,
      state: this.state,
      inFlightTasksAtStart,
      inFlightTasksAtEnd,
      timeoutReached,
      durationMs,
      errors,
    };
  }

  /**
   * Get current in-flight task count from health checker.
   */
  private getInFlightTaskCount(): number {
    if (!this.healthChecker) {
      return 0;
    }
    const status = this.healthChecker.status();
    return status.metrics.activeTaskCount;
  }

  /**
   * Wait for in-flight tasks to complete.
   * Returns true if timeout was reached, false if all tasks completed.
   */
  private async waitForInFlightTasks(): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.config.timeoutMs) {
      const inFlightCount = this.getInFlightTaskCount();

      if (inFlightCount === 0) {
        return false; // All tasks completed
      }

      await this.sleep(this.config.checkIntervalMs);
    }

    return true; // Timeout reached
  }

  /**
   * Emit shutdown event to Bloodbank.
   */
  private async emitShutdownEvent(
    eventName: string,
    data: Record<string, unknown>
  ): Promise<void> {
    if (!this.bloodbank) {
      return;
    }

    try {
      await this.bloodbank.publish({
        event: eventName,
        version: '1.0.0',
        data: {
          serviceName: this.serviceName,
          shutdownTime: new Date().toISOString(),
          ...data,
        },
        exchange: 'amq.topic',
        routingKey: eventName,
        correlationId: this.correlationId,
        timestamp: new Date().toISOString(),
        source: this.serviceName,
      });
    } catch (error) {
      console.error(`[Shutdown] Failed to emit ${eventName}:`, error);
    }
  }

  /**
   * Sleep for specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
