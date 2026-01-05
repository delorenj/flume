/**
 * State Types - Agent lifecycle states
 */

/**
 * Agent states following corporate lifecycle.
 * Every state change should emit a Bloodbank event.
 */
export type AgentState =
  | 'initializing' // Being created by HR
  | 'onboarding'   // Receiving context injection
  | 'idle'         // Ready for work (at desk, waiting)
  | 'working'      // Actively executing a task
  | 'delegating'   // Waiting on subordinate to complete
  | 'blocked'      // Waiting on external dependency
  | 'reviewing'    // Peer review / QA phase
  | 'errored'      // Recoverable error state
  | 'terminated';  // Permanently stopped (fired/quit)

/**
 * State transition record for audit trail.
 */
export interface StateTransition {
  /** Agent that transitioned */
  employeeId: string;

  /** Previous state */
  fromState: AgentState;

  /** New state */
  toState: AgentState;

  /** What triggered the transition */
  trigger: string;

  /** ISO timestamp of transition */
  timestamp: string;

  /** Optional task associated with this transition */
  taskId?: string;

  /** Optional error details if transitioning to 'errored' */
  error?: string;
}

/**
 * Valid state transitions (state machine definition).
 * Used to validate transitions and prevent invalid states.
 */
export const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  initializing: ['onboarding', 'errored', 'terminated'],
  onboarding: ['idle', 'errored', 'terminated'],
  idle: ['working', 'delegating', 'blocked', 'errored', 'terminated'],
  working: ['idle', 'blocked', 'reviewing', 'errored', 'terminated'],
  delegating: ['idle', 'blocked', 'errored', 'terminated'],
  blocked: ['idle', 'working', 'delegating', 'errored', 'terminated'],
  reviewing: ['idle', 'errored', 'terminated'],
  errored: ['idle', 'terminated'],
  terminated: [], // Terminal state - no transitions out
};

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
