/**
 * State Machine - Agent state management with edge case handling
 *
 * Provides a robust state machine for agent lifecycle management
 * with guards, timeouts, error recovery, and audit trails.
 *
 * @category State
 */

import { AgentState, StateTransition, VALID_TRANSITIONS, isValidTransition } from '../types/state.js';

/**
 * State transition guard function.
 * Guards can prevent transitions based on custom logic.
 */
export type TransitionGuard = (
  from: AgentState,
  to: AgentState,
  context: TransitionContext
) => boolean | Promise<boolean>;

/**
 * Context provided to transition guards and hooks.
 */
export interface TransitionContext {
  employeeId: string;
  taskId?: string;
  trigger: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * State machine configuration.
 */
export interface StateMachineConfig {
  /** Maximum time to stay in working state before auto-timeout (ms) */
  workingTimeoutMs?: number;
  /** Maximum time to stay in delegating state before auto-timeout (ms) */
  delegatingTimeoutMs?: number;
  /** Maximum time to stay in blocked state before escalation (ms) */
  blockedTimeoutMs?: number;
  /** Maximum retry attempts from errored state */
  maxErrorRetries?: number;
  /** Custom transition guards */
  guards?: TransitionGuard[];
  /** Callback when state changes */
  onTransition?: (transition: StateTransition) => void | Promise<void>;
  /** Callback when invalid transition attempted */
  onInvalidTransition?: (from: AgentState, to: AgentState, context: TransitionContext) => void;
}

/**
 * Default state machine configuration.
 */
export const DEFAULT_STATE_MACHINE_CONFIG: Required<Omit<StateMachineConfig, 'guards' | 'onTransition' | 'onInvalidTransition'>> = {
  workingTimeoutMs: 30 * 60 * 1000,     // 30 minutes
  delegatingTimeoutMs: 60 * 60 * 1000,  // 1 hour
  blockedTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
  maxErrorRetries: 3,
};

/**
 * State machine error.
 */
export class StateMachineError extends Error {
  constructor(
    message: string,
    public readonly from: AgentState,
    public readonly to: AgentState,
    public readonly context: TransitionContext
  ) {
    super(message);
    this.name = 'StateMachineError';
  }
}

/**
 * Agent state machine for managing lifecycle with edge case handling.
 */
export class AgentStateMachine {
  private state: AgentState;
  private stateEnteredAt: number;
  private errorRetryCount = 0;
  private history: StateTransition[] = [];
  private config: Required<Omit<StateMachineConfig, 'guards' | 'onTransition' | 'onInvalidTransition'>> & StateMachineConfig;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly employeeId: string,
    initialState: AgentState = 'initializing',
    config: StateMachineConfig = {}
  ) {
    this.state = initialState;
    this.stateEnteredAt = Date.now();
    this.config = { ...DEFAULT_STATE_MACHINE_CONFIG, ...config };
  }

  /**
   * Get current state.
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Get time spent in current state (ms).
   */
  getTimeInState(): number {
    return Date.now() - this.stateEnteredAt;
  }

  /**
   * Get state transition history.
   */
  getHistory(): readonly StateTransition[] {
    return this.history;
  }

  /**
   * Get error retry count.
   */
  getErrorRetryCount(): number {
    return this.errorRetryCount;
  }

  /**
   * Check if a transition is allowed.
   */
  canTransition(to: AgentState): boolean {
    return isValidTransition(this.state, to);
  }

  /**
   * Get all valid transitions from current state.
   */
  getValidTransitions(): AgentState[] {
    return [...(VALID_TRANSITIONS[this.state] ?? [])];
  }

  /**
   * Transition to a new state.
   * @throws StateMachineError if transition is invalid or blocked by guard
   */
  async transition(
    to: AgentState,
    trigger: string,
    options: { taskId?: string; error?: string; metadata?: Record<string, unknown> } = {}
  ): Promise<StateTransition> {
    const context: TransitionContext = {
      employeeId: this.employeeId,
      taskId: options.taskId,
      trigger,
      timestamp: new Date().toISOString(),
      metadata: options.metadata,
    };

    // Validate transition
    if (!this.canTransition(to)) {
      this.config.onInvalidTransition?.(this.state, to, context);
      throw new StateMachineError(
        `Invalid transition from '${this.state}' to '${to}'`,
        this.state,
        to,
        context
      );
    }

    // Run guards
    if (this.config.guards) {
      for (const guard of this.config.guards) {
        const allowed = await guard(this.state, to, context);
        if (!allowed) {
          throw new StateMachineError(
            `Transition from '${this.state}' to '${to}' blocked by guard`,
            this.state,
            to,
            context
          );
        }
      }
    }

    // Clear any existing timeout
    this.clearTimeout();

    // Create transition record
    const transition: StateTransition = {
      employeeId: this.employeeId,
      fromState: this.state,
      toState: to,
      trigger,
      timestamp: context.timestamp,
      taskId: options.taskId,
      error: options.error,
    };

    // Update state
    const previousState = this.state;
    this.state = to;
    this.stateEnteredAt = Date.now();
    this.history.push(transition);

    // Handle state-specific logic
    await this.handleStateEntry(to, previousState, context);

    // Notify listener
    await this.config.onTransition?.(transition);

    return transition;
  }

  /**
   * Attempt to recover from errored state.
   * Returns false if max retries exceeded.
   */
  async attemptErrorRecovery(trigger = 'error_recovery'): Promise<boolean> {
    if (this.state !== 'errored') {
      return false;
    }

    if (this.errorRetryCount >= this.config.maxErrorRetries) {
      console.warn(`[StateMachine] Max error retries (${this.config.maxErrorRetries}) exceeded for ${this.employeeId}`);
      return false;
    }

    this.errorRetryCount++;
    await this.transition('idle', trigger, {
      metadata: { retryCount: this.errorRetryCount },
    });

    return true;
  }

  /**
   * Force terminate the agent (emergency stop).
   */
  async forceTerminate(reason = 'force_terminated'): Promise<StateTransition> {
    // terminated can be reached from any state (except itself)
    if (this.state === 'terminated') {
      throw new StateMachineError(
        'Agent is already terminated',
        this.state,
        'terminated',
        {
          employeeId: this.employeeId,
          trigger: reason,
          timestamp: new Date().toISOString(),
        }
      );
    }

    this.clearTimeout();

    const transition: StateTransition = {
      employeeId: this.employeeId,
      fromState: this.state,
      toState: 'terminated',
      trigger: reason,
      timestamp: new Date().toISOString(),
    };

    this.state = 'terminated';
    this.stateEnteredAt = Date.now();
    this.history.push(transition);

    await this.config.onTransition?.(transition);

    return transition;
  }

  /**
   * Handle timeout for current state.
   * Called internally when state timeout is reached.
   */
  private async handleTimeout(): Promise<void> {
    const timeInState = this.getTimeInState();

    switch (this.state) {
      case 'working':
        console.warn(`[StateMachine] Working timeout for ${this.employeeId} after ${timeInState}ms`);
        await this.transition('errored', 'working_timeout', {
          error: `Working state timed out after ${timeInState}ms`,
        });
        break;

      case 'delegating':
        console.warn(`[StateMachine] Delegating timeout for ${this.employeeId} after ${timeInState}ms`);
        await this.transition('errored', 'delegating_timeout', {
          error: `Delegating state timed out after ${timeInState}ms`,
        });
        break;

      case 'blocked':
        console.warn(`[StateMachine] Blocked timeout for ${this.employeeId} after ${timeInState}ms`);
        // Blocked timeout escalates but doesn't error - allow manual intervention
        await this.transition('errored', 'blocked_escalation', {
          error: `Blocked state exceeded ${timeInState}ms - escalated`,
        });
        break;

      default:
        // No timeout for other states
        break;
    }
  }

  /**
   * Handle state entry - set up timeouts, reset counters, etc.
   */
  private async handleStateEntry(
    state: AgentState,
    previousState: AgentState,
    context: TransitionContext
  ): Promise<void> {
    // Reset error retry count when entering idle from non-errored state
    // (error recovery should preserve retry count for tracking)
    if (state === 'idle' && previousState !== 'errored') {
      this.errorRetryCount = 0;
    }

    // Set up state-specific timeouts
    switch (state) {
      case 'working':
        this.setTimeout(this.config.workingTimeoutMs);
        break;

      case 'delegating':
        this.setTimeout(this.config.delegatingTimeoutMs);
        break;

      case 'blocked':
        this.setTimeout(this.config.blockedTimeoutMs);
        break;

      default:
        // No timeout for other states
        break;
    }
  }

  /**
   * Set timeout for current state.
   */
  private setTimeout(ms: number): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      this.handleTimeout().catch(err => {
        console.error('[StateMachine] Timeout handler error:', err);
      });
    }, ms);
  }

  /**
   * Clear any existing timeout.
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }

  /**
   * Clean up resources (call when agent is no longer needed).
   */
  dispose(): void {
    this.clearTimeout();
  }
}

/**
 * Utility to check if state is a "busy" state (working, delegating, reviewing).
 */
export function isBusyState(state: AgentState): boolean {
  return state === 'working' || state === 'delegating' || state === 'reviewing';
}

/**
 * Utility to check if state is a "terminal" state.
 */
export function isTerminalState(state: AgentState): boolean {
  return state === 'terminated';
}

/**
 * Utility to check if state allows new task assignment.
 */
export function canAcceptTask(state: AgentState): boolean {
  return state === 'idle';
}

/**
 * Utility to check if agent needs attention (blocked or errored).
 */
export function needsAttention(state: AgentState): boolean {
  return state === 'blocked' || state === 'errored';
}

/**
 * Get human-readable state description.
 */
export function getStateDescription(state: AgentState): string {
  const descriptions: Record<AgentState, string> = {
    initializing: 'Being created by HR',
    onboarding: 'Receiving context and training',
    idle: 'Ready for work',
    working: 'Actively executing a task',
    delegating: 'Waiting on subordinate to complete',
    blocked: 'Waiting on external dependency',
    reviewing: 'In peer review / QA phase',
    errored: 'Encountered a recoverable error',
    terminated: 'Permanently stopped',
  };
  return descriptions[state];
}

/**
 * Get suggested next states for recovery or progression.
 */
export function getSuggestedNextStates(state: AgentState): AgentState[] {
  const suggestions: Record<AgentState, AgentState[]> = {
    initializing: ['onboarding'],
    onboarding: ['idle'],
    idle: ['working', 'delegating'],
    working: ['idle', 'reviewing'],
    delegating: ['idle'],
    blocked: ['idle', 'working'],
    reviewing: ['idle'],
    errored: ['idle'],
    terminated: [],
  };
  return suggestions[state];
}
