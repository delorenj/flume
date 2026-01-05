/**
 * Echo Factory - Creates echo agents for testing
 */

import type { Employee } from '@flume/core';
import type { AgentFactory } from '@yi/adapter';
import { EchoContributor, EchoSlowContributor } from '../agents/echo-contributor.js';
import { EchoManager } from '../agents/echo-manager.js';
import { EchoDirector } from '../agents/echo-director.js';
import { EchoFailingContributor } from '../agents/echo-failing.js';

let agentCounter = 0;

/**
 * Factory for creating echo agents.
 */
export class EchoFactory implements AgentFactory {
  readonly name = 'echo-factory';

  constructor(private defaultTeamId: string = 'echo-team') {}

  async createAgent(skills: string[], role?: string): Promise<Employee> {
    agentCounter++;
    const name = `Echo Agent #${agentCounter}`;

    // Determine agent type based on skills
    if (skills.includes('director') || skills.includes('leadership')) {
      return new EchoDirector({
        name: role ?? `Echo Director #${agentCounter}`,
        teamId: this.defaultTeamId,
        skills,
      });
    }

    if (skills.includes('manager') || skills.includes('management')) {
      return new EchoManager({
        name: role ?? `Echo Manager #${agentCounter}`,
        teamId: this.defaultTeamId,
        skills,
      });
    }

    if (skills.includes('slow')) {
      return new EchoSlowContributor(2000, {
        name: role ?? `Slow Echo IC #${agentCounter}`,
        teamId: this.defaultTeamId,
        skills,
      });
    }

    if (skills.includes('failing') || skills.includes('chaos')) {
      return new EchoFailingContributor(0.2, {
        name: role ?? `Failing Echo IC #${agentCounter}`,
        teamId: this.defaultTeamId,
        skills,
      });
    }

    // Default: regular contributor
    return new EchoContributor({
      name: role ?? name,
      teamId: this.defaultTeamId,
      skills,
    });
  }

  canCreate(skills: string[]): boolean {
    // Echo factory can create anything
    return true;
  }
}

/**
 * Create a complete echo team for testing.
 */
export function createEchoTeam(teamId = 'echo-team'): {
  director: EchoDirector;
  manager: EchoManager;
  contributors: EchoContributor[];
} {
  const director = new EchoDirector({
    name: 'Echo VP',
    teamId,
    skills: ['strategy', 'leadership'],
  });

  const manager = new EchoManager({
    name: 'Echo Lead',
    teamId,
    skills: ['management', 'coding'],
  });

  const contributors = [
    new EchoContributor({
      name: 'Echo Dev 1',
      teamId,
      skills: ['typescript', 'backend'],
    }),
    new EchoContributor({
      name: 'Echo Dev 2',
      teamId,
      skills: ['python', 'data'],
    }),
    new EchoContributor({
      name: 'Echo Dev 3',
      teamId,
      skills: ['frontend', 'react'],
    }),
  ];

  // Wire up the hierarchy
  for (const contributor of contributors) {
    manager.recruit(contributor);
  }
  director.recruit(manager);

  return { director, manager, contributors };
}
