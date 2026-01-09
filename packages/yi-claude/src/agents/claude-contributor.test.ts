/**
 * Unit tests for ClaudeContributor
 *
 * These tests inject a mock client directly to test streaming,
 * tool use, and non-streaming functionality without actual API calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeContributor, StreamEventHandler, ToolDefinition } from './claude-contributor.js';
import type { TaskPayload } from '@flume/core';

describe('ClaudeContributor', () => {
  let contributor: ClaudeContributor;
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockStream: ReturnType<typeof vi.fn>;
  let mockClient: {
    messages: {
      create: ReturnType<typeof vi.fn>;
      stream: ReturnType<typeof vi.fn>;
    };
  };

  const mockTask: TaskPayload = {
    taskId: 'task-123',
    correlationId: 'corr-456',
    objective: 'Test objective',
    context: { key: 'value' },
    tags: ['test', 'unit'],
    priority: 'medium',
    origin: 'test',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock client
    mockCreate = vi.fn();
    mockStream = vi.fn();
    mockClient = {
      messages: {
        create: mockCreate,
        stream: mockStream,
      },
    };

    contributor = new ClaudeContributor({
      name: 'Test Claude Worker',
      role: 'Test Contributor',
      model: 'claude-sonnet-4-20250514',
    });

    // Inject mock client directly
    (contributor as unknown as { client: typeof mockClient }).client = mockClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create with default values', () => {
      const defaultContributor = new ClaudeContributor();
      expect(defaultContributor.name).toBe('Claude Worker');
      expect(defaultContributor.role).toBe('Claude Contributor');
      expect(defaultContributor.getModel()).toBe('claude-sonnet-4-20250514');
      expect(defaultContributor.isStreamingEnabled()).toBe(false);
    });

    it('should accept custom configuration', () => {
      const customContributor = new ClaudeContributor({
        name: 'Custom Worker',
        role: 'Custom Role',
        model: 'claude-opus-4-20250514',
        enableStreaming: true,
      });
      expect(customContributor.name).toBe('Custom Worker');
      expect(customContributor.role).toBe('Custom Role');
      expect(customContributor.getModel()).toBe('claude-opus-4-20250514');
      expect(customContributor.isStreamingEnabled()).toBe(true);
    });
  });

  describe('streaming control', () => {
    it('should toggle streaming mode', () => {
      expect(contributor.isStreamingEnabled()).toBe(false);
      contributor.setStreaming(true);
      expect(contributor.isStreamingEnabled()).toBe(true);
      contributor.setStreaming(false);
      expect(contributor.isStreamingEnabled()).toBe(false);
    });

    it('should accept stream event handler', () => {
      const handler: StreamEventHandler = {
        onTextDelta: vi.fn(),
        onMessageComplete: vi.fn(),
      };
      contributor.setStreamEventHandler(handler);
      // Handler is stored internally
      expect((contributor as unknown as { streamEventHandler: StreamEventHandler }).streamEventHandler).toBe(handler);
    });
  });

  describe('model configuration', () => {
    it('should get and set model', () => {
      expect(contributor.getModel()).toBe('claude-sonnet-4-20250514');
      contributor.setModel('claude-opus-4-20250514');
      expect(contributor.getModel()).toBe('claude-opus-4-20250514');
    });
  });

  describe('conversation history', () => {
    it('should clear conversation history', () => {
      // Add some history by setting directly for testing
      (contributor as unknown as { conversationHistory: unknown[] }).conversationHistory = [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: 'response' },
      ];

      contributor.clearHistory();

      expect((contributor as unknown as { conversationHistory: unknown[] }).conversationHistory).toHaveLength(0);
    });
  });

  describe('executeWithStreaming', () => {
    it('should execute task with streaming and call event handlers', async () => {
      // Create mock stream with event handling
      const mockEventHandlers: Record<string, (data: unknown) => void> = {};
      const mockFinalMessage = {
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      };

      const mockStreamObj = {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          mockEventHandlers[event] = handler;
          return mockStreamObj;
        }),
        finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
      };

      mockStream.mockReturnValue(mockStreamObj);

      // Set up event handler to track calls
      const onTextDelta = vi.fn();
      const onContentBlockStart = vi.fn();
      const onContentBlockStop = vi.fn();
      const onMessageComplete = vi.fn();

      const handler: StreamEventHandler = {
        onTextDelta,
        onContentBlockStart,
        onContentBlockStop,
        onMessageComplete,
      };

      // Start streaming execution
      const resultPromise = contributor.executeWithStreaming(mockTask, handler);

      // Simulate streaming events
      mockEventHandlers['contentBlockStart']?.({});
      mockEventHandlers['text']?.('Hello');
      mockEventHandlers['text']?.(', World!');
      mockEventHandlers['contentBlockStop']?.();

      const result = await resultPromise;

      // Verify event handlers were called
      expect(onTextDelta).toHaveBeenCalledWith('Hello');
      expect(onTextDelta).toHaveBeenCalledWith(', World!');
      expect(onContentBlockStart).toHaveBeenCalledWith(0, 'text');
      expect(onContentBlockStop).toHaveBeenCalledWith(0);
      expect(onMessageComplete).toHaveBeenCalledWith('Hello, World!', {
        inputTokens: 100,
        outputTokens: 50,
      });

      // Verify result
      expect(result.fullText).toBe('Hello, World!');
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.stopReason).toBe('end_turn');
    });

    it('should use instance stream handler if none provided', async () => {
      const mockEventHandlers: Record<string, (data: unknown) => void> = {};
      const mockFinalMessage = {
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      };

      const mockStreamObj = {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          mockEventHandlers[event] = handler;
          return mockStreamObj;
        }),
        finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
      };

      mockStream.mockReturnValue(mockStreamObj);

      const onTextDelta = vi.fn();
      contributor.setStreamEventHandler({ onTextDelta });

      const resultPromise = contributor.executeWithStreaming(mockTask);
      mockEventHandlers['text']?.('Test');

      await resultPromise;

      expect(onTextDelta).toHaveBeenCalledWith('Test');
    });

    it('should handle streaming errors', async () => {
      const mockEventHandlers: Record<string, (data: unknown) => void> = {};
      const streamError = new Error('Stream error');

      const mockStreamObj = {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          mockEventHandlers[event] = handler;
          return mockStreamObj;
        }),
        finalMessage: vi.fn().mockRejectedValue(streamError),
      };

      mockStream.mockReturnValue(mockStreamObj);

      const onError = vi.fn();
      const handler: StreamEventHandler = { onError };

      await expect(contributor.executeWithStreaming(mockTask, handler)).rejects.toThrow('Stream error');
      expect(onError).toHaveBeenCalledWith(streamError);
    });

    it('should update conversation history after streaming', async () => {
      const mockEventHandlers: Record<string, (data: unknown) => void> = {};
      const mockFinalMessage = {
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      };

      const mockStreamObj = {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          mockEventHandlers[event] = handler;
          return mockStreamObj;
        }),
        finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
      };

      mockStream.mockReturnValue(mockStreamObj);

      const resultPromise = contributor.executeWithStreaming(mockTask);
      mockEventHandlers['text']?.('Response');

      await resultPromise;

      const history = (contributor as unknown as { conversationHistory: Array<{ role: string; content: string }> }).conversationHistory;
      expect(history).toHaveLength(2);
      expect(history[0].role).toBe('user');
      expect(history[1].role).toBe('assistant');
      expect(history[1].content).toBe('Response');
    });

    it('should trim conversation history when it gets too long', async () => {
      // Pre-populate history with many entries
      const longHistory = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      })) as Array<{ role: 'user' | 'assistant'; content: string }>;
      (contributor as unknown as { conversationHistory: typeof longHistory }).conversationHistory = longHistory;

      const mockEventHandlers: Record<string, (data: unknown) => void> = {};
      const mockFinalMessage = {
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      };

      const mockStreamObj = {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          mockEventHandlers[event] = handler;
          return mockStreamObj;
        }),
        finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
      };

      mockStream.mockReturnValue(mockStreamObj);

      const resultPromise = contributor.executeWithStreaming(mockTask);
      mockEventHandlers['text']?.('New response');

      await resultPromise;

      const history = (contributor as unknown as { conversationHistory: unknown[] }).conversationHistory;
      // After adding 2 messages to 20, we have 22, which triggers trim to last 10
      expect(history.length).toBeLessThanOrEqual(10);
    });

    it('should pass correct parameters to stream API', async () => {
      const mockEventHandlers: Record<string, (data: unknown) => void> = {};
      const mockFinalMessage = {
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      };

      const mockStreamObj = {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          mockEventHandlers[event] = handler;
          return mockStreamObj;
        }),
        finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
      };

      mockStream.mockReturnValue(mockStreamObj);

      await contributor.executeWithStreaming(mockTask);

      expect(mockStream).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature: 0.7,
        system: expect.stringContaining('Test Claude Worker'),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Test objective'),
          }),
        ]),
      });
    });
  });

  describe('tool registration', () => {
    const calculatorTool: ToolDefinition = {
      name: 'calculator',
      description: 'Performs basic arithmetic operations',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['operation', 'a', 'b'],
      },
    };

    it('should register a tool', () => {
      const executor = vi.fn().mockResolvedValue('42');
      contributor.registerTool(calculatorTool, executor);

      expect(contributor.getRegisteredTools()).toContain('calculator');
      expect(contributor.hasTool('calculator')).toBe(true);
    });

    it('should replace duplicate tool registration', () => {
      const executor1 = vi.fn().mockResolvedValue('1');
      const executor2 = vi.fn().mockResolvedValue('2');

      contributor.registerTool(calculatorTool, executor1);
      contributor.registerTool(calculatorTool, executor2);

      expect(contributor.getRegisteredTools()).toHaveLength(1);
      expect(contributor.getRegisteredTools()).toContain('calculator');
    });

    it('should unregister a tool', () => {
      const executor = vi.fn().mockResolvedValue('42');
      contributor.registerTool(calculatorTool, executor);

      expect(contributor.unregisterTool('calculator')).toBe(true);
      expect(contributor.hasTool('calculator')).toBe(false);
      expect(contributor.getRegisteredTools()).not.toContain('calculator');
    });

    it('should return false when unregistering non-existent tool', () => {
      expect(contributor.unregisterTool('nonexistent')).toBe(false);
    });

    it('should clear all tools', () => {
      const executor = vi.fn().mockResolvedValue('42');
      contributor.registerTool(calculatorTool, executor);
      contributor.registerTool({
        name: 'other',
        description: 'Another tool',
        inputSchema: { type: 'object', properties: {} },
      }, executor);

      contributor.clearTools();

      expect(contributor.getRegisteredTools()).toHaveLength(0);
    });
  });

  describe('executeWithTools', () => {
    const calculatorTool: ToolDefinition = {
      name: 'calculator',
      description: 'Performs basic arithmetic operations',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['operation', 'a', 'b'],
      },
    };

    it('should throw if no tools registered', async () => {
      await expect(contributor.executeWithTools(mockTask)).rejects.toThrow('No tools registered');
    });

    it('should execute without tool calls', async () => {
      const executor = vi.fn().mockResolvedValue('42');
      contributor.registerTool(calculatorTool, executor);

      // Mock response without tool use
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'The answer is 42' }],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      });

      const result = await contributor.executeWithTools(mockTask);

      expect(result.output).toBe('The answer is 42');
      expect(result.toolCalls).toHaveLength(0);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should execute tool calls and return results', async () => {
      const executor = vi.fn().mockResolvedValue({ result: 7 });
      contributor.registerTool(calculatorTool, executor);

      // First response: Claude wants to use a tool
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Let me calculate that for you.' },
          {
            type: 'tool_use',
            id: 'tool-123',
            name: 'calculator',
            input: { operation: 'add', a: 3, b: 4 },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
      });

      // Second response: Claude provides final answer after tool result
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'The result of 3 + 4 is 7.' }],
        usage: { input_tokens: 150, output_tokens: 30 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      });

      const result = await contributor.executeWithTools(mockTask);

      expect(executor).toHaveBeenCalledWith({ operation: 'add', a: 3, b: 4 });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('calculator');
      expect(result.toolCalls[0].result).toEqual({ result: 7 });
      expect(result.output).toBe('The result of 3 + 4 is 7.');
      expect(result.usage.inputTokens).toBe(250);
      expect(result.usage.outputTokens).toBe(80);
    });

    it('should handle multiple tool calls in sequence', async () => {
      const executor = vi.fn()
        .mockResolvedValueOnce({ result: 7 })
        .mockResolvedValueOnce({ result: 14 });

      contributor.registerTool(calculatorTool, executor);

      // First response: Claude uses tool
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'calculator',
            input: { operation: 'add', a: 3, b: 4 },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
      });

      // Second response: Claude uses tool again
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'calculator',
            input: { operation: 'multiply', a: 7, b: 2 },
          },
        ],
        usage: { input_tokens: 150, output_tokens: 40 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
      });

      // Third response: Final answer
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'The final answer is 14.' }],
        usage: { input_tokens: 200, output_tokens: 20 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      });

      const result = await contributor.executeWithTools(mockTask);

      expect(executor).toHaveBeenCalledTimes(2);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.output).toBe('The final answer is 14.');
    });

    it('should handle tool execution errors gracefully', async () => {
      const executor = vi.fn().mockRejectedValue(new Error('Tool failed'));
      contributor.registerTool(calculatorTool, executor);

      // First response: Claude uses tool
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool-123',
            name: 'calculator',
            input: { operation: 'add', a: 3, b: 4 },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
      });

      // Second response: Claude handles error gracefully
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Sorry, there was an error with the calculation.' }],
        usage: { input_tokens: 150, output_tokens: 30 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      });

      const result = await contributor.executeWithTools(mockTask);

      // Tool call should not be in successful results (error handling)
      expect(result.output).toBe('Sorry, there was an error with the calculation.');
    });

    it('should handle unknown tool calls', async () => {
      const executor = vi.fn().mockResolvedValue('42');
      contributor.registerTool(calculatorTool, executor);

      // First response: Claude tries to use unknown tool
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool-123',
            name: 'unknown_tool',
            input: { foo: 'bar' },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
      });

      // Second response: Claude handles error
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'I apologize, that tool is not available.' }],
        usage: { input_tokens: 150, output_tokens: 30 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      });

      const result = await contributor.executeWithTools(mockTask);

      expect(executor).not.toHaveBeenCalled();
      expect(result.output).toBe('I apologize, that tool is not available.');
    });

    it('should pass tool definitions to API', async () => {
      const executor = vi.fn().mockResolvedValue('42');
      contributor.registerTool(calculatorTool, executor);

      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
      });

      await contributor.executeWithTools(mockTask);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'calculator',
              description: 'Performs basic arithmetic operations',
              input_schema: expect.objectContaining({
                type: 'object',
                properties: expect.objectContaining({
                  operation: expect.any(Object),
                }),
              }),
            }),
          ]),
        })
      );
    });
  });
});
