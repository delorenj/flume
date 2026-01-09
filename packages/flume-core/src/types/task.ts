/**
 * Task Types - The work units flowing through Flume
 * @category Task
 */

/**
 * The atomic unit of work in Flume.
 * Tasks flow down the corporate hierarchy from Director → Manager → Contributor.
 */
export interface TaskPayload {
  /** Unique task identifier */
  id: string;

  /** Links related tasks across the delegation chain */
  correlationId: string;

  /** Parent task if this was delegated (enables tree reconstruction) */
  parentTaskId?: string;

  /** Human-readable objective */
  objective: string;

  /** Domain-specific context (prompts, files, constraints) */
  context: Record<string, unknown>;

  /** Priority level (higher = more important) */
  priority?: number;

  /** ISO timestamp when task was created */
  createdAt: string;

  /** Maximum time allowed for execution (ms) */
  timeout?: number;

  /** Tags for filtering and routing */
  tags?: string[];

  /** Link to external system (e.g., Plane issue ID) */
  externalId?: string;

  /** Plane workspace slug for sync */
  planeWorkspace?: string;

  /** Plane project ID for sync */
  planeProjectId?: string;
}

/**
 * Task states following corporate workflow semantics.
 */
export type TaskState =
  | 'draft'       // Initial creation, not yet submitted
  | 'open'        // Available for processing
  | 'ready'       // Can be accepted by an agent
  | 'assigned'    // Has an assignee
  | 'in_progress' // Active work underway
  | 'blocked'     // Waiting on external dependency
  | 'in_review'   // QA/review phase
  | 'done'        // Successfully completed
  | 'failed'      // Execution failed
  | 'cancelled';  // Manually cancelled

/**
 * Recruitment request - HR department uses this to find the right agent.
 */
export interface RecruitmentRequest {
  /** Skills required for the task */
  requiredSkills: string[];

  /** Manager who requested the hire */
  reportingToManagerId: string;

  /** Team the agent will join */
  teamId: string;

  /** Preferred agent type (letta, agno, claude, etc.) */
  preferredFramework?: string;

  /** Whether this is an ephemeral swarm contractor */
  isContractor?: boolean;
}
