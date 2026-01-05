/**
 * Session Contributor - Agent that executes tasks via Jelmore sessions
 *
 * Extends BaseContributor to execute work in Zellij terminal sessions
 * managed by Jelmore. This enables long-running agentic coding workflows.
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import { BaseContributor } from '@yi/adapter';
import { SessionManager, type SessionManagerConfig } from './session-manager.js';

export interface SessionContributorConfig {
  id?: string;
  name?: string;
  role?: string;
  teamId?: string;
  skills?: string[];
  salary?: number;
  agentType?: 'claude-code' | 'opencode' | 'gptme' | 'codex' | 'custom';
  sessionManager?: SessionManagerConfig;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

/**
 * A Contributor that executes tasks via Jelmore sessions.
 */
export class SessionContributor extends BaseContributor {
  private sessionManager: SessionManager;
  private agentType: 'claude-code' | 'opencode' | 'gptme' | 'codex' | 'custom';
  private pollIntervalMs: number;
  private maxWaitMs: number;

  constructor(config: SessionContributorConfig = {}) {
    super({
      id: config.id ?? uuid(),
      name: config.name ?? 'Session Worker',
      role: config.role ?? 'Session Contributor',
      teamId: config.teamId ?? 'default',
      skills: config.skills ?? ['coding', 'terminal'],
      salary: config.salary ?? 85000,
    });

    this.sessionManager = new SessionManager(config.sessionManager);
    this.agentType = config.agentType ?? 'claude-code';
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.maxWaitMs = config.maxWaitMs ?? 600000; // 10 minutes
  }

  /**
   * Get the session manager.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Execute the task by spawning a Jelmore session.
   */
  protected async doWork(task: TaskPayload): Promise<unknown> {
    console.log(`[${this.name}] Spawning session for task: ${task.objective}`);

    // Check if Jelmore is available
    const available = await this.sessionManager.isAvailable();
    if (!available) {
      throw new Error('Jelmore service is not available');
    }

    // Spawn session
    const session = await this.sessionManager.spawnForTask(task, {
      agentType: this.agentType,
      role: this.role,
      metadata: {
        employeeId: this.id,
        employeeName: this.name,
      },
    });

    console.log(`[${this.name}] Session spawned: ${session.id}`);

    // Send task prompt to session
    const prompt = this.buildPrompt(task);
    await this.sessionManager.sendToTask(task.id, prompt);

    console.log(`[${this.name}] Task prompt sent to session`);

    // Monitor for completion
    // In a real implementation, this would monitor output for completion signals
    // For now, we return the session info as the result
    return {
      status: 'session_spawned',
      sessionId: session.id,
      zellijSession: session.zellijSession,
      zellijTab: session.zellijTab,
      zellijPane: session.zellijPane,
      message: `Session spawned for task. Use "zellij attach ${session.zellijSession}" to view progress.`,
    };
  }

  /**
   * Build prompt to send to the coding agent.
   */
  private buildPrompt(task: TaskPayload): string {
    let prompt = `# Task: ${task.objective}\n\n`;

    if (task.context) {
      prompt += `## Context\n\`\`\`json\n${JSON.stringify(task.context, null, 2)}\n\`\`\`\n\n`;
    }

    if (task.tags?.length) {
      prompt += `## Tags\n${task.tags.join(', ')}\n\n`;
    }

    prompt += `## Instructions\nPlease complete this task. When done, output "TASK_COMPLETE" on a new line.\n`;

    return prompt;
  }

  /**
   * Focus on the current task's session.
   */
  async focusCurrentTask(): Promise<boolean> {
    const taskId = this.getCurrentTaskId();
    if (!taskId) {
      console.warn(`[${this.name}] No current task to focus`);
      return false;
    }

    return this.sessionManager.focusTask(taskId);
  }

  /**
   * Get output from the current task's session.
   */
  async getCurrentOutput(lines = 50): Promise<string[] | null> {
    const taskId = this.getCurrentTaskId();
    if (!taskId) {
      return null;
    }

    return this.sessionManager.getTaskOutput(taskId, lines);
  }

  /**
   * Terminate the current task's session.
   */
  async terminateCurrentSession(): Promise<void> {
    const taskId = this.getCurrentTaskId();
    if (taskId) {
      await this.sessionManager.terminateTask(taskId);
    }
  }

  /**
   * Get the current task ID from the base class.
   */
  private getCurrentTaskId(): string | undefined {
    // Access via status report which includes currentTaskId
    // This is a workaround since _currentTaskId is protected
    return (this as unknown as { _currentTaskId?: string })._currentTaskId;
  }
}
