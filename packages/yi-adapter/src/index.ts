/**
 * @yi/adapter - Opinionated Adapter Layer
 *
 * Yi wraps diverse agent frameworks (Letta, Agno, Claude, smolagents)
 * and forces them to wear the Flume corporate uniform.
 *
 * Yi enforces 33GOD conventions:
 * - Shared memory strategies per team
 * - Standardized onboarding process
 * - HR department for recruitment
 * - Bloodbank event emission
 */

// Memory and context
export * from './memory/strategy.js';
export * from './memory/team-context.js';

// HR and onboarding
export * from './hr/hr-department.js';
export * from './hr/onboarding-specialist.js';

// Base agent classes
export * from './agents/base-contributor.js';
export * from './agents/base-manager.js';
export * from './agents/base-director.js';

// Selection strategies
export * from './selection/first-match.js';
export * from './selection/llm-driven.js';

// Event publishing
export * from './events/bloodbank-publisher.js';

// Plane sync
export * from './sync/plane-sync.js';

// Boot sequence
export * from './boot/boot-sequence.js';
