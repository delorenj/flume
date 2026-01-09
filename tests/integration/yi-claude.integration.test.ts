/**
 * Integration Tests for yi-claude
 *
 * These tests verify the Claude API-backed agents:
 * - Basic task execution
 * - Streaming support
 * - Tool use integration
 *
 * Note: These tests require ANTHROPIC_API_KEY environment variable.
 * They are skipped in CI unless secrets are configured.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  ClaudeContributor,
  ClaudeManager,
  ClaudeDirector,
  ClaudeFactory,
} from '@yi/claude';
import type { TaskPayload } from '@flume/core';

// Skip tests if no API key
const API_KEY = process.env.ANTHROPIC_API_KEY;
const describeWithApiKey = API_KEY ? describe : describe.skip;

describeWithApiKey('Yi Claude Integration', () => {
  describe('ClaudeContributor Basic Execution', () => {
    let contributor: ClaudeContributor;

    beforeEach(() => {
      contributor = new ClaudeContributor({
        id: 'claude-contrib-1',
        name: 'Claude Worker',
        role: 'General Assistant',
        skills: ['coding', 'analysis', 'writing'],
        model: 'claude-sonnet-4-20250514',
        maxTokens: 1024,
        temperature: 0.5,
      });
    });

    it('should execute a simple task', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'What is 2 + 2? Reply with just the number.',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.executeTask(task);

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      // The output should contain "4"
      expect(result.output).toMatch(/4/);
    }, 30000);

    it('should preserve correlation ID', async () => {
      const correlationId = uuid();
      const task: TaskPayload = {
        id: uuid(),
        correlationId,
        objective: 'Say hello',
        priority: 'low',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.executeTask(task);

      expect(result.correlationId).toBe(correlationId);
    }, 30000);

    it('should return usage statistics', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Count to 3',
        priority: 'low',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.executeTask(task);

      expect(result.success).toBe(true);
      // The output object should contain usage info
      const output = result.output as {
        usage?: { inputTokens: number; outputTokens: number };
      };
      if (output.usage) {
        expect(output.usage.inputTokens).toBeGreaterThan(0);
        expect(output.usage.outputTokens).toBeGreaterThan(0);
      }
    }, 30000);
  });

  describe('ClaudeContributor Streaming', () => {
    let contributor: ClaudeContributor;

    beforeEach(() => {
      contributor = new ClaudeContributor({
        id: 'claude-streaming',
        name: 'Streaming Claude',
        enableStreaming: true,
        model: 'claude-sonnet-4-20250514',
        maxTokens: 512,
      });
    });

    it('should stream response with events', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Count from 1 to 5',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const deltas: string[] = [];

      const result = await contributor.executeWithStreaming(task, {
        onTextDelta: (delta) => deltas.push(delta),
        onMessageComplete: (fullText, usage) => {
          expect(fullText.length).toBeGreaterThan(0);
          expect(usage.inputTokens).toBeGreaterThan(0);
        },
      });

      expect(result.fullText.length).toBeGreaterThan(0);
      expect(deltas.length).toBeGreaterThan(0);
      // The concatenated deltas should equal the full text
      expect(deltas.join('')).toBe(result.fullText);
    }, 30000);
  });

  describe('ClaudeContributor Tool Use', () => {
    let contributor: ClaudeContributor;

    beforeEach(() => {
      contributor = new ClaudeContributor({
        id: 'claude-tools',
        name: 'Tool-using Claude',
        model: 'claude-sonnet-4-20250514',
        maxTokens: 1024,
      });

      // Register a simple calculator tool
      contributor.registerTool<{ a: number; b: number }>(
        {
          name: 'add_numbers',
          description: 'Add two numbers together',
          inputSchema: {
            type: 'object',
            properties: {
              a: { type: 'number', description: 'First number' },
              b: { type: 'number', description: 'Second number' },
            },
            required: ['a', 'b'],
          },
        },
        async (input) => {
          return { result: input.a + input.b };
        }
      );
    });

    it('should use tool when appropriate', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Use the add_numbers tool to add 15 and 27. Report the result.',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.executeWithTools(task);

      expect(result.output).toBeDefined();
      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.toolCalls[0].name).toBe('add_numbers');
      expect(result.toolCalls[0].result).toEqual({ result: 42 });
      // Final output should mention the result
      expect(result.output).toContain('42');
    }, 60000);

    it('should handle tool errors gracefully', async () => {
      // Register a failing tool
      contributor.registerTool(
        {
          name: 'failing_tool',
          description: 'A tool that always fails',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        async () => {
          throw new Error('Tool execution failed');
        }
      );

      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Try to use the failing_tool',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      // Should not throw - error is returned to Claude
      const result = await contributor.executeWithTools(task);
      expect(result).toBeDefined();
    }, 60000);
  });

  describe('Claude Manager Delegation', () => {
    let manager: ClaudeManager;
    let contributor1: ClaudeContributor;
    let contributor2: ClaudeContributor;

    beforeAll(() => {
      contributor1 = new ClaudeContributor({
        id: 'team-member-1',
        name: 'Team Member 1',
        skills: ['coding'],
        model: 'claude-sonnet-4-20250514',
      });

      contributor2 = new ClaudeContributor({
        id: 'team-member-2',
        name: 'Team Member 2',
        skills: ['writing'],
        model: 'claude-sonnet-4-20250514',
      });

      manager = new ClaudeManager({
        id: 'claude-manager',
        name: 'Claude Team Lead',
        model: 'claude-sonnet-4-20250514',
      });

      manager.addSubordinate(contributor1);
      manager.addSubordinate(contributor2);
    });

    it('should delegate to team members', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'What is the capital of France?',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await manager.executeTask(task);

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    }, 60000);
  });

  describe('Claude Factory', () => {
    it('should create agents using factory', async () => {
      const factory = new ClaudeFactory({
        defaultModel: 'claude-sonnet-4-20250514',
        maxTokens: 512,
      });

      const contributor = factory.createContributor(
        ['general'],
        'Test Worker',
        {
          id: 'factory-contrib',
          name: 'Factory Claude',
        }
      );

      expect(contributor.getModel()).toBe('claude-sonnet-4-20250514');

      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Say hello',
        priority: 'low',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.executeTask(task);
      expect(result.success).toBe(true);
    }, 30000);
  });
});
