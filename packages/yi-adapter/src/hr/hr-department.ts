/**
 * HR Department - Agent factory and recruitment
 *
 * HR is responsible for:
 * 1. Finding the right agent class/model (Recruitment)
 * 2. Sending new hires to Onboarding
 * 3. Delivering ready agents to their managers
 *
 * HR does NOT configure agents - that's Onboarding's job.
 */

import type { Employee, RecruitmentRequest } from '@flume/core';
import type { OnboardingSpecialist } from './onboarding-specialist.js';
import type { TeamContext } from '../memory/team-context.js';

/**
 * Agent factory interface - creates raw agents.
 * Different factories create different agent types (Letta, Agno, etc.)
 */
export interface AgentFactory {
  /** Factory name for logging */
  name: string;

  /**
   * Create a raw agent with specified skills.
   * The agent is NOT yet configured - just instantiated.
   */
  createAgent(skills: string[], role?: string): Promise<Employee>;

  /**
   * Check if this factory can create agents with these skills.
   */
  canCreate(skills: string[]): boolean;
}

/**
 * HR Department - manages agent recruitment pipeline.
 */
export class HRDepartment {
  private factories: Map<string, AgentFactory> = new Map();
  private teamContexts: Map<string, TeamContext> = new Map();

  constructor(
    private onboarding: OnboardingSpecialist,
    private defaultFactory?: AgentFactory
  ) {}

  /**
   * Register an agent factory.
   */
  registerFactory(name: string, factory: AgentFactory): void {
    this.factories.set(name, factory);
    console.log(`[HR] Registered agent factory: ${name}`);
  }

  /**
   * Register team context for onboarding.
   */
  registerTeamContext(teamId: string, context: TeamContext): void {
    this.teamContexts.set(teamId, context);
    console.log(`[HR] Registered team context: ${teamId}`);
  }

  /**
   * Fulfill a recruitment request.
   * Returns a fully onboarded agent ready to work.
   */
  async fulfillRequest(request: RecruitmentRequest): Promise<Employee> {
    console.log(
      `[HR] Processing recruitment request for team ${request.teamId}`
    );
    console.log(`[HR] Required skills: ${request.requiredSkills.join(', ')}`);

    // 1. Find the right factory
    const factory = this.findFactory(request);
    if (!factory) {
      throw new Error(
        `No agent factory can create an agent with skills: ${request.requiredSkills.join(', ')}`
      );
    }

    // 2. Create raw agent (Recruitment)
    console.log(`[HR] Using factory: ${factory.name}`);
    const rawRecruit = await factory.createAgent(
      request.requiredSkills,
      this.generateRoleTitle(request.requiredSkills)
    );

    // 3. Get team context
    const teamContext = this.teamContexts.get(request.teamId);
    if (!teamContext) {
      throw new Error(`No team context registered for team: ${request.teamId}`);
    }

    // 4. Send to Onboarding
    const readyAgent = await this.onboarding.orient(rawRecruit, teamContext);

    console.log(
      `[HR] Agent ${readyAgent.name} is ready for manager ${request.reportingToManagerId}`
    );
    return readyAgent;
  }

  /**
   * Quick hire - create and onboard an agent in one step.
   * Used when you already have context and just need an agent.
   */
  async quickHire(
    skills: string[],
    teamContext: TeamContext,
    factoryName?: string
  ): Promise<Employee> {
    const factory = factoryName
      ? this.factories.get(factoryName)
      : this.findFactoryForSkills(skills);

    if (!factory) {
      throw new Error(`No factory found for skills: ${skills.join(', ')}`);
    }

    const rawAgent = await factory.createAgent(skills);
    return this.onboarding.orient(rawAgent, teamContext);
  }

  /**
   * Find a factory that can create agents with the required skills.
   */
  private findFactory(request: RecruitmentRequest): AgentFactory | null {
    // Prefer specified framework
    if (request.preferredFramework) {
      const preferred = this.factories.get(request.preferredFramework);
      if (preferred?.canCreate(request.requiredSkills)) {
        return preferred;
      }
    }

    // Fall back to any factory that can handle the skills
    return this.findFactoryForSkills(request.requiredSkills);
  }

  /**
   * Find any factory that can create agents with the given skills.
   */
  private findFactoryForSkills(skills: string[]): AgentFactory | null {
    for (const factory of this.factories.values()) {
      if (factory.canCreate(skills)) {
        return factory;
      }
    }
    return this.defaultFactory ?? null;
  }

  /**
   * Generate a role title based on skills.
   */
  private generateRoleTitle(skills: string[]): string {
    const primarySkill = skills[0] ?? 'General';
    return `${primarySkill} Specialist`;
  }
}
