/**
 * Team Context - The "employee handbook" for onboarding
 *
 * Three-tier onboarding as designed:
 * 1. Project Context (from Director): threads, KPIs, timelines
 * 2. Tech Context (from L&D): memories, skills, MCP servers
 * 3. Company Context (from CEO/Board): coding standards, infrastructure
 */

/**
 * Context levels for onboarding.
 */
export type ContextLevel = 'project' | 'tech' | 'company';

/**
 * Full team context for onboarding new agents.
 */
export interface TeamContext {
  /** Team ID */
  teamId: string;

  /** Team's mission statement */
  missionStatement: string;

  /** Shared knowledge base ID (for memory strategy) */
  sharedKnowledgeBaseId: string;

  /** Access level granted to new agents */
  accessLevel: 'intern' | 'contractor' | 'full-time' | 'executive';

  /** Project-level context (from Director) */
  projectContext?: ProjectContext;

  /** Tech-level context (from L&D) */
  techContext?: TechContext;

  /** Company-level context (from CEO/Board) */
  companyContext?: CompanyContext;
}

/**
 * Project context - shared by Director with teams.
 * Contains strategic direction and goals.
 */
export interface ProjectContext {
  /** Key conversation threads to review */
  threads: string[];

  /** Technical north stars */
  northStars: string[];

  /** Key Performance Indicators */
  kpis: KPI[];

  /** Project timeline and milestones */
  timeline: Milestone[];

  /** Current sprint goals */
  sprintGoals: string[];
}

/**
 * Tech context - shared by L&D during onboarding.
 * Contains technical knowledge and tools.
 */
export interface TechContext {
  /** Relevant memories from past work */
  memories: string[];

  /** Lessons learned */
  lessonsLearned: string[];

  /** Skills to be granted */
  skills: string[];

  /** MCP servers to connect */
  mcpServers: MCPServerConfig[];

  /** Tool configurations */
  tools: Record<string, unknown>;
}

/**
 * Company context - shared from CEO/Board level.
 * Contains standards and infrastructure details.
 */
export interface CompanyContext {
  /** Coding standards document */
  codingStandards: string;

  /** Infrastructure details */
  infrastructure: InfrastructureConfig;

  /** Security policies */
  securityPolicies: string[];

  /** Communication protocols */
  communicationProtocols: string[];
}

/**
 * KPI definition.
 */
export interface KPI {
  name: string;
  target: string;
  current?: string;
  deadline?: string;
}

/**
 * Project milestone.
 */
export interface Milestone {
  name: string;
  dueDate: string;
  status: 'pending' | 'in_progress' | 'completed';
  dependencies?: string[];
}

/**
 * MCP server configuration.
 */
export interface MCPServerConfig {
  name: string;
  url: string;
  capabilities: string[];
}

/**
 * Infrastructure configuration for 33GOD.
 */
export interface InfrastructureConfig {
  /** RabbitMQ/Bloodbank */
  rabbitmq: {
    url: string;
    exchange: string;
  };

  /** PostgreSQL database */
  postgres: {
    host: string;
    port: number;
    database: string;
  };

  /** Redis cache */
  redis: {
    host: string;
    port: number;
  };

  /** Qdrant vector store */
  qdrant: {
    host: string;
    port: number;
  };

  /** Plane project management */
  plane: {
    url: string;
    workspace: string;
  };
}
