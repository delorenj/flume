/**
 * Tests for ConversationContext
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConversationContext,
  createContextForModel,
  CLAUDE_CONTEXT_WINDOWS,
} from './conversation-context.js';

describe('ConversationContext', () => {
  describe('initialization', () => {
    it('should initialize with default config', () => {
      const context = new ConversationContext();
      const stats = context.getStats();

      expect(stats.messageCount).toBe(0);
      expect(stats.totalTokens).toBe(0);
      expect(context.maxContextTokens).toBe(128000);
    });

    it('should accept custom config', () => {
      const context = new ConversationContext({
        maxTokens: 50000,
        truncationThreshold: 0.8,
        truncationStrategy: 'keep_recent',
        keepRecentCount: 5,
      });

      expect(context.maxContextTokens).toBe(50000);
      expect(context.strategy).toBe('keep_recent');
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens from text length', () => {
      const context = new ConversationContext();

      // Default: 4 chars per token
      expect(context.estimateTokens('hello')).toBe(2); // 5 chars = 2 tokens
      expect(context.estimateTokens('hello world')).toBe(3); // 11 chars = 3 tokens
      expect(context.estimateTokens('')).toBe(0);
    });

    it('should use custom chars per token', () => {
      const context = new ConversationContext({ charsPerToken: 3 });

      expect(context.estimateTokens('hello')).toBe(2); // 5 chars / 3 = 2 tokens
      expect(context.estimateTokens('hello world')).toBe(4); // 11 chars / 3 = 4 tokens
    });
  });

  describe('message management', () => {
    let context: ConversationContext;

    beforeEach(() => {
      context = new ConversationContext({ verbose: false });
    });

    it('should add user messages', () => {
      const msg = context.addUserMessage('Hello, Claude!');

      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello, Claude!');
      expect(msg.tokenCount).toBeGreaterThan(0);
      expect(msg.timestamp).toBeInstanceOf(Date);
    });

    it('should add assistant messages', () => {
      const msg = context.addAssistantMessage('Hello! How can I help?');

      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Hello! How can I help?');
    });

    it('should track message count and tokens', () => {
      context.addUserMessage('User message 1');
      context.addAssistantMessage('Assistant response 1');
      context.addUserMessage('User message 2');

      const stats = context.getStats();

      expect(stats.messageCount).toBe(3);
      expect(stats.userTokens).toBeGreaterThan(0);
      expect(stats.assistantTokens).toBeGreaterThan(0);
      expect(stats.totalTokens).toBe(stats.userTokens + stats.assistantTokens);
    });

    it('should store message metadata', () => {
      const msg = context.addUserMessage('Hello', { taskId: 'task-123' });

      expect(msg.metadata).toEqual({ taskId: 'task-123' });
    });

    it('should get messages for API call', () => {
      context.addUserMessage('Hello');
      context.addAssistantMessage('Hi there!');

      const messages = context.getMessages();

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('should clear messages', () => {
      context.addUserMessage('Hello');
      context.addAssistantMessage('Hi');
      context.clear();

      const stats = context.getStats();
      expect(stats.messageCount).toBe(0);
    });
  });

  describe('system message', () => {
    it('should set and get system message', () => {
      const context = new ConversationContext();

      context.setSystemMessage('You are a helpful assistant.');

      expect(context.getSystemMessage()).toBe('You are a helpful assistant.');
    });

    it('should include system message in stats', () => {
      const context = new ConversationContext();
      context.setSystemMessage('System prompt');

      const stats = context.getStats();

      expect(stats.systemTokens).toBeGreaterThan(0);
      expect(stats.messageCount).toBe(1);
    });

    it('should preserve system message after clear', () => {
      const context = new ConversationContext();
      context.setSystemMessage('System prompt');
      context.addUserMessage('Hello');
      context.clear();

      expect(context.getSystemMessage()).toBe('System prompt');
    });

    it('should remove system message on reset', () => {
      const context = new ConversationContext();
      context.setSystemMessage('System prompt');
      context.reset();

      expect(context.getSystemMessage()).toBeUndefined();
    });
  });

  describe('truncation - sliding window', () => {
    let context: ConversationContext;

    beforeEach(() => {
      context = new ConversationContext({
        maxTokens: 100,
        truncationThreshold: 0.9,
        truncationStrategy: 'sliding_window',
        charsPerToken: 1, // 1:1 for easier testing
        verbose: false,
      });
    });

    it('should truncate when exceeding threshold', () => {
      // Each message is about 10 tokens with 1:1 ratio
      for (let i = 0; i < 15; i++) {
        context.addUserMessage(`Message ${i}`.padEnd(10, '.'));
      }

      const stats = context.getStats();

      // Should have truncated oldest messages
      expect(stats.messageCount).toBeLessThan(15);
      expect(stats.totalTokens).toBeLessThanOrEqual(90); // 90% threshold
    });

    it('should emit truncated event', () => {
      const truncatedHandler = vi.fn();
      context.on('truncated', truncatedHandler);

      // Fill context
      for (let i = 0; i < 15; i++) {
        context.addUserMessage(`Message ${i}`.padEnd(10, '.'));
      }

      expect(truncatedHandler).toHaveBeenCalled();
      const event = truncatedHandler.mock.calls[0][0];
      expect(event.messagesRemoved).toBeGreaterThan(0);
      expect(event.strategy).toBe('sliding_window');
    });
  });

  describe('truncation - keep recent', () => {
    it('should keep only N most recent messages', () => {
      const context = new ConversationContext({
        maxTokens: 50,
        truncationThreshold: 0.5,
        truncationStrategy: 'keep_recent',
        keepRecentCount: 3,
        charsPerToken: 1,
        verbose: false,
      });

      for (let i = 0; i < 10; i++) {
        context.addUserMessage(`Message ${i}`.padEnd(10, '.'));
      }

      const messages = context.getFullMessages();

      expect(messages.length).toBeLessThanOrEqual(3);
      // Last message should be the most recent
      expect(messages[messages.length - 1].content).toContain('Message 9');
    });
  });

  describe('truncation - keep first last', () => {
    it('should keep first and last messages', () => {
      const context = new ConversationContext({
        maxTokens: 100,
        truncationThreshold: 0.6,
        truncationStrategy: 'keep_first_last',
        keepRecentCount: 4, // Keep 2 first + 2 last
        charsPerToken: 1,
        verbose: false,
      });

      for (let i = 0; i < 10; i++) {
        context.addUserMessage(`Message ${i}`.padEnd(10, '.'));
      }

      context.truncate(); // Force truncation

      const messages = context.getFullMessages();
      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];

      expect(firstMsg.content).toContain('Message 0');
      expect(lastMsg.content).toContain('Message 9');
    });
  });

  describe('events', () => {
    let context: ConversationContext;

    beforeEach(() => {
      context = new ConversationContext({
        maxTokens: 100,
        truncationThreshold: 0.8,
        charsPerToken: 1,
        verbose: false,
      });
    });

    it('should emit messageAdded event', () => {
      const handler = vi.fn();
      context.on('messageAdded', handler);

      context.addUserMessage('Hello');

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].content).toBe('Hello');
    });

    it('should emit warning event when approaching limit', () => {
      const warningHandler = vi.fn();
      context.on('warning', warningHandler);

      // Add messages to exceed 80% threshold
      for (let i = 0; i < 10; i++) {
        context.addUserMessage(`Message ${i}`.padEnd(10, '.'));
      }

      expect(warningHandler).toHaveBeenCalled();
    });

    it('should emit cleared event', () => {
      const handler = vi.fn();
      context.on('cleared', handler);

      context.addUserMessage('Hello');
      context.clear();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('statistics and utilities', () => {
    let context: ConversationContext;

    beforeEach(() => {
      context = new ConversationContext({
        maxTokens: 1000,
        charsPerToken: 4,
        verbose: false,
      });
    });

    it('should calculate usage percentage', () => {
      // Add messages totaling ~100 tokens (400 chars)
      context.addUserMessage('a'.repeat(400));

      const stats = context.getStats();

      expect(stats.usagePercent).toBeCloseTo(10, 0); // 100/1000 = 10%
    });

    it('should check if approaching limit', () => {
      expect(context.isApproachingLimit()).toBe(false);

      // Add messages to exceed 80%
      context.addUserMessage('a'.repeat(3400)); // ~850 tokens

      expect(context.isApproachingLimit()).toBe(true);
    });

    it('should check if additional tokens can fit', () => {
      context.addUserMessage('a'.repeat(3600)); // 900 tokens

      expect(context.canFit(50)).toBe(true);
      expect(context.canFit(200)).toBe(false);
    });

    it('should track truncation statistics', () => {
      const smallContext = new ConversationContext({
        maxTokens: 50,
        truncationThreshold: 0.8,
        charsPerToken: 1,
        verbose: false,
      });

      for (let i = 0; i < 10; i++) {
        smallContext.addUserMessage(`Message ${i}`.padEnd(10, '.'));
      }

      expect(smallContext.totalTruncations).toBeGreaterThan(0);
      expect(smallContext.totalTokensTruncated).toBeGreaterThan(0);
    });

    it('should update max tokens', () => {
      context.setMaxTokens(500);

      expect(context.maxContextTokens).toBe(500);
    });

    it('should update strategy', () => {
      context.setStrategy('keep_recent');

      expect(context.strategy).toBe('keep_recent');
    });
  });

  describe('createContextForModel', () => {
    it('should create context with model-specific max tokens', () => {
      const context = createContextForModel('claude-3-opus');

      expect(context.maxContextTokens).toBe(CLAUDE_CONTEXT_WINDOWS['claude-3-opus']);
    });

    it('should accept additional config', () => {
      const context = createContextForModel('claude-3-haiku', {
        truncationStrategy: 'smart',
        verbose: true,
      });

      expect(context.maxContextTokens).toBe(CLAUDE_CONTEXT_WINDOWS['claude-3-haiku']);
      expect(context.strategy).toBe('smart');
    });
  });

  describe('CLAUDE_CONTEXT_WINDOWS', () => {
    it('should have entries for known models', () => {
      expect(CLAUDE_CONTEXT_WINDOWS['claude-3-opus']).toBe(200000);
      expect(CLAUDE_CONTEXT_WINDOWS['claude-3-sonnet']).toBe(200000);
      expect(CLAUDE_CONTEXT_WINDOWS['claude-3-haiku']).toBe(200000);
      expect(CLAUDE_CONTEXT_WINDOWS['claude-2.1']).toBe(200000);
    });
  });
});
