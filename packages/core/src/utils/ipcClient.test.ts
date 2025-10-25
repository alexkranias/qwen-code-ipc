/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getIPCClient, cleanupIPCClient, initializeIPCClient, requestGrepIPC } from './ipcClient.js';

// Mock fs and path for testing
vi.mock('node:fs');
vi.mock('node:path');

describe('IPCClient', () => {
  const mockWorkspacePath = '/mock/workspace';

  beforeEach(() => {
    // Reset the singleton instance before each test
    cleanupIPCClient();

    // Mock path.join to return expected socket paths
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));
  });

  afterEach(() => {
    cleanupIPCClient();
    vi.clearAllMocks();
  });

  describe('getIPCClient', () => {
    it('should create a new IPC client instance for a workspace path', () => {
      const client = getIPCClient(mockWorkspacePath);
      expect(client).toBeDefined();
    });

    it('should return the same instance for the same workspace path', () => {
      const client1 = getIPCClient(mockWorkspacePath);
      const client2 = getIPCClient(mockWorkspacePath);
      expect(client1).toBe(client2);
    });

    it('should create a new instance for different workspace paths', () => {
      const client1 = getIPCClient('/workspace1');
      const client2 = getIPCClient('/workspace2');
      expect(client1).not.toBe(client2);
    });
  });

  describe('initializeIPCClient', () => {
    it('should fail gracefully when socket does not exist', async () => {
      // Mock fs.access to simulate socket not existing
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      await expect(initializeIPCClient(mockWorkspacePath)).rejects.toThrow(
        'Failed to initialize IPC client: Failed to connect to socket'
      );
    });
  });

  describe('requestGrepIPC', () => {
    it('should fail gracefully and allow fallback when service is unavailable', async () => {
      await expect(
        requestGrepIPC(mockWorkspacePath, 'test', ['.'], {})
      ).rejects.toThrow('Failed to initialize IPC client');
    });
  });

  describe('cleanupIPCClient', () => {
    it('should clean up the client instance', () => {
      const client = getIPCClient(mockWorkspacePath);
      expect(client).toBeDefined();

      cleanupIPCClient();

      // Next call should create a new instance
      const client2 = getIPCClient(mockWorkspacePath);
      expect(client2).not.toBe(client);
    });
  });

  describe('IPC Protocol Tests', () => {
    it('should correctly serialize and parse IPC messages', () => {
      // Test alloc_pid request serialization
      const allocPidRequest = {
        type: 'alloc_pid' as const,
        pid: 12345,
        repo_dir_path: '/test/workspace'
      };

      const serialized = JSON.stringify(allocPidRequest) + '\n';
      const parsed = JSON.parse(serialized.trim());

      expect(parsed).toEqual(allocPidRequest);

      // Test alloc_pid response
      const allocPidResponse = {
        response_status: 1
      };

      const responseSerialized = JSON.stringify(allocPidResponse) + '\n';
      const responseParsed = JSON.parse(responseSerialized.trim());

      expect(responseParsed).toEqual(allocPidResponse);

      // Test request_grep request serialization
      const grepRequest = {
        type: 'request_grep' as const,
        pid: 12345,
        pattern: 'hello',
        paths: ['src', 'test'],
        options: {
          line_number: true,
          with_filename: true,
          ignore_case: true
        }
      };

      const grepSerialized = JSON.stringify(grepRequest) + '\n';
      const grepParsed = JSON.parse(grepSerialized.trim());

      expect(grepParsed).toEqual(grepRequest);

      // Test request_grep response
      const grepResponse = {
        response_status: 1,
        text: 'file1.txt:1:hello world\nfile2.txt:2:hello universe\n'
      };

      const grepResponseSerialized = JSON.stringify(grepResponse) + '\n';
      const grepResponseParsed = JSON.parse(grepResponseSerialized.trim());

      expect(grepResponseParsed).toEqual(grepResponse);
    });

    it('should handle message buffering correctly', () => {
      // Simulate receiving multiple messages in one buffer
      const messages = [
        { type: 'alloc_pid', pid: 12345, repo_dir_path: '/test' },
        { type: 'request_grep', pid: 12345, pattern: 'test', paths: ['.'], options: {} }
      ];

      const buffer = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';

      // Simulate how the client processes the buffer
      const lines = buffer.split('\n');
      const completeMessages: any[] = [];

      for (const line of lines) {
        if (line.trim()) {
          completeMessages.push(JSON.parse(line));
        }
      }

      expect(completeMessages).toEqual(messages);
    });

    it('should generate correct socket paths', () => {
      const workspacePath = '/home/user/project';
      const requestSocketPath = path.join(workspacePath, 'mem_search_service_requests.sock');
      const responseSocketPath = path.join(workspacePath, 'qwen_code_response_12345.sock');

      expect(requestSocketPath).toBe('/home/user/project/mem_search_service_requests.sock');
      expect(responseSocketPath).toBe('/home/user/project/qwen_code_response_12345.sock');
    });
  });
});
