#!/usr/bin/env tsx
/**
 * Walking Skeleton - End-to-end test of the Flume/Yi architecture
 *
 * This script demonstrates the full lifecycle:
 * 1. Boot: Initialize HR, Onboarding, Director, Manager, Contributors
 * 2. Recruit: HR creates agents, Onboarding injects context
 * 3. Create: User creates a task
 * 4. Assign: Director delegates to Manager
 * 5. Execute: Manager delegates to Contributor
 * 6. Complete: Result bubbles up
 * 7. Observe: All state transitions logged
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import { HRDepartment, YiOnboarding, type TeamContext } from '@yi/adapter';
import {
  EchoContributor,
  EchoManager,
  EchoDirector,
  EchoMemory,
  EchoFactory,
  createEchoTeam,
} from './index.js';

console.log('═══════════════════════════════════════════════════════════');
console.log('  🏢 FLUME/YI WALKING SKELETON - The First Business Day');
console.log('═══════════════════════════════════════════════════════════');
console.log();

async function runWalkingSkeleton(): Promise<void> {
  // ═══════════════════════════════════════════════════════════
  // PHASE 1: BOOT - Initialize the corporate infrastructure
  // ═══════════════════════════════════════════════════════════
  console.log('📋 PHASE 1: BOOT - Initializing corporate infrastructure');
  console.log('─────────────────────────────────────────────────────────');

  // Create memory strategy
  const memory = new EchoMemory();

  // Initialize onboarding
  const onboarding = new YiOnboarding(memory);

  // Initialize HR department with echo factory
  const hr = new HRDepartment(onboarding, new EchoFactory());
  hr.registerFactory('echo', new EchoFactory());

  // Register team context for onboarding
  const teamContext: TeamContext = {
    teamId: 'echo-team',
    missionStatement: 'Build and maintain the 33GOD agentic pipeline',
    sharedKnowledgeBaseId: 'default',
    accessLevel: 'full-time',
    techContext: {
      memories: [],
      lessonsLearned: ['Always test your code', 'Log everything'],
      skills: ['typescript', 'testing', 'echo'],
      mcpServers: [],
      tools: {},
    },
  };
  hr.registerTeamContext('echo-team', teamContext);

  console.log('✓ Memory strategy initialized');
  console.log('✓ Onboarding specialist ready');
  console.log('✓ HR department operational');
  console.log();

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: RECRUIT - Create and onboard the team
  // ═══════════════════════════════════════════════════════════
  console.log('👥 PHASE 2: RECRUIT - Building the team');
  console.log('─────────────────────────────────────────────────────────');

  // Use the pre-built echo team helper
  const { director, manager, contributors } = createEchoTeam('echo-team');

  // Onboard everyone
  await onboarding.orient(director, teamContext);
  await onboarding.orient(manager, teamContext);
  for (const contributor of contributors) {
    await onboarding.orient(contributor, teamContext);
  }

  console.log();
  console.log(`✓ Team structure created:`);
  console.log(`  Director: ${director.name} (${director.role})`);
  console.log(`  └─ Manager: ${manager.name} (${manager.role})`);
  for (const c of contributors) {
    console.log(`     └─ IC: ${c.name} (${c.skills.join(', ')})`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: CREATE - Human creates a task
  // ═══════════════════════════════════════════════════════════
  console.log('📝 PHASE 3: CREATE - Human creates a task');
  console.log('─────────────────────────────────────────────────────────');

  const task: TaskPayload = {
    id: uuid(),
    correlationId: uuid(),
    objective: 'Implement the user authentication module',
    context: {
      requirements: [
        'Support OAuth2 login',
        'Store tokens securely',
        'Add logout functionality',
      ],
      priority: 'high',
    },
    priority: 1,
    createdAt: new Date().toISOString(),
    tags: ['backend', 'auth', 'typescript'],
  };

  console.log(`✓ Task created: ${task.objective}`);
  console.log(`  ID: ${task.id}`);
  console.log(`  Tags: ${task.tags?.join(', ')}`);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: DELEGATE - Director delegates to Manager to IC
  // ═══════════════════════════════════════════════════════════
  console.log('🎯 PHASE 4: DELEGATE - Task flows through the hierarchy');
  console.log('─────────────────────────────────────────────────────────');

  console.log(`[CEO] Assigning task to ${director.name}...`);
  console.log();

  const result = await director.delegate(task);

  console.log();
  console.log('─────────────────────────────────────────────────────────');

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: RESULTS - Observe the outcome
  // ═══════════════════════════════════════════════════════════
  console.log('📊 PHASE 5: RESULTS - Observing outcomes');
  console.log('─────────────────────────────────────────────────────────');

  console.log(`Result Status: ${result.status}`);
  console.log(`Output: ${JSON.stringify(result.output)}`);
  console.log(`Duration: ${result.metrics.durationMs}ms`);
  console.log(`Delegation Depth: ${result.metrics.delegationDepth ?? 0}`);
  if (result.delegatedTo) {
    console.log(`Delegated To: ${result.delegatedTo}`);
  }
  if (result.error) {
    console.log(`Error: ${result.error.message}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════
  // PHASE 6: STATUS CHECK - Team status report
  // ═══════════════════════════════════════════════════════════
  console.log('📋 PHASE 6: STATUS CHECK - Team status report');
  console.log('─────────────────────────────────────────────────────────');

  const directorStatus = await director.reportStatus();
  const managerStatus = await manager.reportStatus();

  console.log(`Director (${director.name}): ${directorStatus.message}`);
  console.log(`  State: ${directorStatus.state}`);

  console.log(`Manager (${manager.name}): ${managerStatus.message}`);
  console.log(`  State: ${managerStatus.state}`);

  for (const c of contributors) {
    const status = await c.reportStatus();
    console.log(`IC (${c.name}): ${status.message}`);
    console.log(`  State: ${status.state}`);
  }

  console.log();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ WALKING SKELETON COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log('The Flume/Yi architecture is working! Next steps:');
  console.log('  1. Add Bloodbank event emission');
  console.log('  2. Implement Plane sync');
  console.log('  3. Set up Postgres schema');
  console.log('  4. Replace Echo agents with Letta/Agno adapters');
}

// Run the skeleton
runWalkingSkeleton().catch((error) => {
  console.error('Walking skeleton failed:', error);
  process.exit(1);
});
