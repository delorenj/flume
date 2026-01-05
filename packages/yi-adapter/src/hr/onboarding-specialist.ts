/**
 * Onboarding Specialist - Context injection service
 *
 * SRP: HR finds the right agent, Onboarding configures it.
 *
 * The OnboardingSpecialist doesn't care HOW the agent works
 * (Letta vs Agno) - it only cares that the agent has the right memories.
 */

import type { Employee } from '@flume/core';
import type { TeamContext } from '../memory/team-context.js';
import type { YiMemoryStrategy, MemoryContext } from '../memory/strategy.js';

/**
 * Onboarding specialist interface.
 * Hydrates raw, skilled agents with team-specific context.
 */
export interface OnboardingSpecialist {
  /**
   * Orient a new agent with team context.
   *
   * @param rawAgent - Newly instantiated, context-free agent
   * @param context - Team environment they're joining
   * @returns The same agent, now hydrated with context
   */
  orient<T extends Employee>(rawAgent: T, context: TeamContext): Promise<T>;
}

/**
 * Yi agent interface - agents that can receive Yi memories.
 */
export interface YiAgent extends Employee {
  /**
   * Inject memory context into the agent.
   */
  injectMemory(memory: OnboardingPacket): Promise<void>;

  /**
   * Verify the agent is ready to work.
   * (Like passing the new hire certification test)
   */
  verifyReadiness(): Promise<boolean>;
}

/**
 * Onboarding packet - everything a new hire needs.
 */
export interface OnboardingPacket {
  /** Access level granted */
  accessLevel: string;

  /** Team mission */
  mission: string;

  /** Core knowledge from memory */
  knowledge: MemoryContext;

  /** Team protocols to follow */
  protocols: string[];

  /** Skills being granted */
  skills: string[];

  /** Infrastructure credentials */
  infrastructure?: Record<string, unknown>;
}

/**
 * Type guard to check if an agent supports Yi onboarding.
 */
export function isYiAgent(agent: unknown): agent is YiAgent {
  return (
    typeof agent === 'object' &&
    agent !== null &&
    'injectMemory' in agent &&
    typeof (agent as YiAgent).injectMemory === 'function'
  );
}

/**
 * Default Yi onboarding implementation.
 */
export class YiOnboarding implements OnboardingSpecialist {
  constructor(
    private memoryStrategy: YiMemoryStrategy,
    private source: string = 'yi.onboarding'
  ) {}

  async orient<T extends Employee>(rawAgent: T, context: TeamContext): Promise<T> {
    console.log(
      `[Onboarding] Welcoming ${rawAgent.name} to Team ${context.teamId}...`
    );

    // 1. Fetch team protocols from memory
    const protocols = await this.memoryStrategy.fetchContext(
      context.sharedKnowledgeBaseId
    );

    // 2. If the agent supports memory injection, sync it
    if (isYiAgent(rawAgent)) {
      // Build the onboarding packet
      const packet: OnboardingPacket = {
        accessLevel: context.accessLevel,
        mission: context.missionStatement,
        knowledge: protocols,
        protocols: context.techContext?.lessonsLearned ?? [],
        skills: context.techContext?.skills ?? [],
        infrastructure: (context.companyContext?.infrastructure as unknown) as Record<string, unknown> | undefined,
      };

      // "Here's your badge and laptop"
      await rawAgent.injectMemory(packet);

      // 3. Verify the agent understands
      const ready = await rawAgent.verifyReadiness();
      if (!ready) {
        throw new Error(
          `Agent ${rawAgent.name} failed onboarding certification`
        );
      }
    } else {
      console.log(
        `[Onboarding] Agent ${rawAgent.name} is not a Yi agent - skipping memory injection`
      );
    }

    console.log(`[Onboarding] ${rawAgent.name} is ready for work!`);
    return rawAgent;
  }
}
