/**
 * Result Types - Output from task execution
 * @category Result
 */

/**
 * The structured response from any agent execution.
 */
export interface WorkResult {
  /** Overall status of the work */
  status: 'success' | 'failure' | 'delegated' | 'blocked' | 'timeout';

  /** The actual output (type depends on task) */
  output: unknown;

  /** Performance and cost metrics */
  metrics: ExecutionMetrics;

  /** Error details if status is 'failure' */
  error?: WorkError;

  /** ID of agent who delegated (if status is 'delegated') */
  delegatedTo?: string;

  /** Artifacts produced during execution */
  artifacts?: Artifact[];

  /** ISO timestamp when work completed */
  completedAt: string;
}

/**
 * Execution metrics for observability.
 */
export interface ExecutionMetrics {
  /** Execution duration in milliseconds */
  durationMs: number;

  /** Token usage (if LLM was involved) */
  tokensUsed?: number;

  /** Estimated cost in USD */
  costUsd?: number;

  /** Number of retry attempts */
  retries?: number;

  /** Delegation depth (0 = direct execution) */
  delegationDepth?: number;
}

/**
 * Error details when work fails.
 */
export interface WorkError {
  /** Error code for programmatic handling */
  code: string;

  /** Human-readable error message */
  message: string;

  /** Whether this error is retryable */
  retryable: boolean;

  /** Stack trace (dev mode only) */
  stack?: string;

  /** Original cause if wrapped */
  cause?: string;
}

/**
 * Artifacts produced during task execution.
 * Maps to the 33GOD artifact types: Decision, Brief, Checkpoint, Recommendation.
 */
export interface Artifact {
  /** Unique artifact ID */
  id: string;

  /** Type of artifact */
  type: 'decision' | 'brief' | 'checkpoint' | 'recommendation' | 'code' | 'document';

  /** Human-readable title */
  title: string;

  /** Content or pointer to content */
  content: string | { uri: string };

  /** When the artifact was created */
  createdAt: string;

  /** Agent who created it */
  createdBy: string;
}
