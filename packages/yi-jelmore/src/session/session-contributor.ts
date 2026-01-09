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
  /** Whether to wait for task completion (default: false for async mode) */
  waitForCompletion?: boolean;
  /** Completion signal to look for in output */
  completionSignal?: string;
}

/**
 * Result of parsing session output for completion.
 */
export interface CompletionResult {
  completed: boolean;
  output: string[];
  result?: string;
  error?: string;
}

/**
 * A Contributor that executes tasks via Jelmore sessions.
 */
export class SessionContributor extends BaseContributor {
  private sessionManager: SessionManager;
  private agentType: 'claude-code' | 'opencode' | 'gptme' | 'codex' | 'custom';
  private pollIntervalMs: number;
  private maxWaitMs: number;
  private waitForCompletion: boolean;
  private completionSignal: string;

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
    this.waitForCompletion = config.waitForCompletion ?? false;
    this.completionSignal = config.completionSignal ?? 'TASK_COMPLETE';
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

    // If not waiting for completion, return async mode result
    if (!this.waitForCompletion) {
      return {
        status: 'session_spawned',
        sessionId: session.id,
        zellijSession: session.zellijSession,
        zellijTab: session.zellijTab,
        zellijPane: session.zellijPane,
        message: `Session spawned for task. Use "zellij attach ${session.zellijSession}" to view progress.`,
      };
    }

    // Wait for completion
    console.log(`[${this.name}] Waiting for task completion (timeout: ${this.maxWaitMs}ms)`);
    const completionResult = await this.waitForTaskCompletion(task.id);

    if (!completionResult.completed) {
      if (completionResult.error) {
        throw new Error(completionResult.error);
      }
      throw new Error('Task did not complete within timeout');
    }

    return {
      status: 'completed',
      sessionId: session.id,
      result: completionResult.result,
      output: completionResult.output,
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

  // ============================================================================
  // Bidirectional Communication
  // ============================================================================

  /**
   * Wait for task completion by polling session output.
   */
  async waitForTaskCompletion(taskId: string): Promise<CompletionResult> {
    const startTime = Date.now();
    const collectedOutput: string[] = [];
    let lastLineCount = 0;

    while (Date.now() - startTime < this.maxWaitMs) {
      // Check if session is still alive
      const session = await this.sessionManager.getSessionForTask(taskId);
      if (!session) {
        return {
          completed: false,
          output: collectedOutput,
          error: 'Session not found or disconnected',
        };
      }

      if (session.status === 'failed') {
        return {
          completed: false,
          output: collectedOutput,
          error: 'Session failed',
        };
      }

      if (session.status === 'stale') {
        return {
          completed: false,
          output: collectedOutput,
          error: 'Session became stale',
        };
      }

      // Get new output
      const output = await this.sessionManager.getTaskOutput(taskId, 200);
      if (output && output.length > lastLineCount) {
        const newLines = output.slice(lastLineCount);
        collectedOutput.push(...newLines);
        lastLineCount = output.length;

        // Check for completion signal
        const result = this.parseOutputForCompletion(collectedOutput);
        if (result.completed) {
          console.log(`[${this.name}] Task completed: ${taskId}`);
          return result;
        }

        // Check for error signals
        const errorResult = this.parseOutputForError(collectedOutput);
        if (errorResult) {
          return {
            completed: false,
            output: collectedOutput,
            error: errorResult,
          };
        }
      }

      // Wait before next poll
      await this.sleep(this.pollIntervalMs);
    }

    // Timeout
    return {
      completed: false,
      output: collectedOutput,
      error: `Task did not complete within ${this.maxWaitMs}ms`,
    };
  }

  /**
   * Parse output for completion signal and extract result.
   */
  parseOutputForCompletion(output: string[]): CompletionResult {
    // Look for completion signal
    const signalIndex = output.findIndex(
      (line) => line.includes(this.completionSignal)
    );

    if (signalIndex === -1) {
      return { completed: false, output };
    }

    // Try to extract result from lines after the signal
    const resultLines = output.slice(signalIndex + 1);
    let result: string | undefined;

    // Look for JSON result block
    const jsonStart = resultLines.findIndex(
      (line) => line.includes('```json') || line.includes('RESULT:')
    );
    if (jsonStart !== -1) {
      const jsonEnd = resultLines.findIndex(
        (line, i) => i > jsonStart && (line.includes('```') || line.trim() === '')
      );
      const jsonLines = resultLines.slice(
        jsonStart + 1,
        jsonEnd !== -1 ? jsonEnd : undefined
      );
      result = jsonLines.join('\n').trim();
    } else {
      // Use remaining lines as result
      result = resultLines.join('\n').trim() || undefined;
    }

    return {
      completed: true,
      output,
      result,
    };
  }

  /**
   * Parse output for error signals.
   */
  parseOutputForError(output: string[]): string | null {
    const errorSignals = [
      'TASK_FAILED',
      'TASK_ERROR',
      'Error:',
      'fatal error',
      'panic:',
    ];

    for (const line of output) {
      for (const signal of errorSignals) {
        if (line.includes(signal)) {
          // Extract error message
          const errorIndex = output.indexOf(line);
          const errorLines = output.slice(errorIndex, errorIndex + 5);
          return errorLines.join('\n');
        }
      }
    }

    return null;
  }

  /**
   * Send a command to the current task's session.
   */
  async sendCommand(command: string): Promise<void> {
    const taskId = this.getCurrentTaskId();
    if (!taskId) {
      throw new Error('No current task');
    }
    await this.sessionManager.sendToTask(taskId, command);
  }

  /**
   * Send a command and wait for a response pattern.
   */
  async sendCommandAndWait(
    command: string,
    responsePattern: string | RegExp,
    timeoutMs = 30000
  ): Promise<string[]> {
    const taskId = this.getCurrentTaskId();
    if (!taskId) {
      throw new Error('No current task');
    }

    // Get current output length
    const beforeOutput = await this.sessionManager.getTaskOutput(taskId, 500);
    const beforeLength = beforeOutput?.length ?? 0;

    // Send command
    await this.sessionManager.sendToTask(taskId, command);

    // Wait for response
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const output = await this.sessionManager.getTaskOutput(taskId, 500);
      if (output && output.length > beforeLength) {
        const newLines = output.slice(beforeLength);

        // Check for response pattern
        for (const line of newLines) {
          const matches =
            typeof responsePattern === 'string'
              ? line.includes(responsePattern)
              : responsePattern.test(line);
          if (matches) {
            return newLines;
          }
        }
      }
      await this.sleep(500);
    }

    throw new Error(`Response pattern not found within ${timeoutMs}ms`);
  }

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
