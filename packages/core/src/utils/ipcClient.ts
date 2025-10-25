/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { getErrorMessage } from './errors.js';

const REQUEST_SOCKET_PATH = 'mem_search_service_requests.sock';
const RESPONSE_SOCKET_PREFIX = 'qwen_code_response_';

interface AllocPidRequest {
  type: 'alloc_pid';
  pid: number;
  repo_dir_path: string;
}

interface AllocPidResponse {
  response_status: number; // 1 = success, 0 = failure
}

interface RipgrepOptions {
  line_number?: boolean;
  no_heading?: boolean;
  with_filename?: boolean;
  ignore_case?: boolean;
  regexp?: string;
  glob?: string;
  globs?: string[];
  threads?: number;
}

interface RequestGrepRequest {
  type: 'request_grep';
  pid: number;
  pattern: string;
  paths: string[];
  options?: RipgrepOptions;
}

interface RequestGrepResponse {
  response_status: number; // 1 = success, 0 = error
  text: string;
}

type RequestMessage = AllocPidRequest | RequestGrepRequest;
type ResponseMessage = AllocPidResponse | RequestGrepResponse;

class IPCClient {
  private requestSocket: net.Socket | null = null;
  private responseSocket: net.Socket | null = null;
  private responseSocketPath: string | null = null;
  private isInitialized = false;

  constructor(private readonly workspacePath: string) {
    // Register cleanup handlers globally (only once)
    if (!cleanupHandlerRegistered) {
      const cleanupHandler = () => {
        ipcClientInstance?.cleanup();
      };
      process.on('exit', cleanupHandler);
      process.on('SIGINT', cleanupHandler);
      process.on('SIGTERM', cleanupHandler);
      cleanupHandlerRegistered = true;
    }
  }

  /**
   * Initialize the IPC client by connecting to the request socket and allocating a PID
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Connect to the central request socket
      this.requestSocket = await this.connectToSocket(path.join(this.workspacePath, REQUEST_SOCKET_PATH));

      // Allocate PID and set up response socket
      await this.allocatePid();

      this.isInitialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize IPC client: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Send a grep request and return the response
   */
  async requestGrep(
    pattern: string,
    paths: string[],
    options?: RipgrepOptions
  ): Promise<string> {
    if (!this.isInitialized || !this.requestSocket) {
      throw new Error('IPC client not initialized');
    }

    const request: RequestGrepRequest = {
      type: 'request_grep',
      pid: process.pid,
      pattern,
      paths,
      options,
    };

    const response = await this.sendRequest<RequestGrepResponse>(request);

    if (response.response_status === 0) {
      throw new Error('Grep request failed');
    }

    return response.text;
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    if (this.requestSocket) {
      try {
        this.requestSocket.destroy();
      } catch (error) {
        console.warn(`Error cleaning up request socket: ${getErrorMessage(error)}`);
      }
      this.requestSocket = null;
    }

    if (this.responseSocket) {
      try {
        this.responseSocket.destroy();
      } catch (error) {
        console.warn(`Error cleaning up response socket: ${getErrorMessage(error)}`);
      }
      this.responseSocket = null;
    }

    // Note: We don't delete the response socket file as the service handles cleanup
    this.responseSocketPath = null;
    this.isInitialized = false;
  }

  private async connectToSocket(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        // Clear the timeout on successful connection
        clearTimeout(timeoutId);
        resolve(socket);
      });

      const timeoutId = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to socket ${socketPath}`));
      }, 5000);

      socket.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to connect to socket ${socketPath}: ${error.message}`));
      });
    });
  }

  private async allocatePid(): Promise<void> {
    if (!this.requestSocket) {
      throw new Error('Request socket not connected');
    }

    const request: AllocPidRequest = {
      type: 'alloc_pid',
      pid: process.pid,
      repo_dir_path: this.workspacePath,
    };

    const response = await this.sendRequest<AllocPidResponse>(request);

    if (response.response_status === 0) {
      throw new Error('Failed to allocate PID');
    }

    // Now connect to our dedicated response socket
    this.responseSocketPath = path.join(this.workspacePath, `${RESPONSE_SOCKET_PREFIX}${process.pid}.sock`);
    this.responseSocket = await this.connectToSocket(this.responseSocketPath);
  }

  private async sendRequest<T extends ResponseMessage>(request: RequestMessage): Promise<T> {
    if (!this.requestSocket) {
      throw new Error('Request socket not connected');
    }

    return new Promise<T>((resolve, reject) => {
      const requestJson = JSON.stringify(request) + '\n';

      // Set up response handler
      const onData = (data: Buffer) => {
        try {
          const responseJson = data.toString('utf8').trim();
          const response = JSON.parse(responseJson) as T;
          cleanup();
          resolve(response);
        } catch (error) {
          cleanup();
          reject(new Error(`Failed to parse response: ${getErrorMessage(error)}`));
        }
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        if (this.requestSocket) {
          this.requestSocket.removeListener('data', onData);
          this.requestSocket.removeListener('error', onError);
        }
        if (this.responseSocket) {
          this.responseSocket.removeListener('data', onData);
          this.responseSocket.removeListener('error', onError);
        }
      };

      // Send request
      this.requestSocket!.write(requestJson, (error) => {
        if (error) {
          cleanup();
          reject(new Error(`Failed to send request: ${error.message}`));
          return;
        }

        // For alloc_pid, receive response on request socket
        // For other requests, receive on response socket
        const responseSocket = request.type === 'alloc_pid' ? this.requestSocket : this.responseSocket;

        if (responseSocket) {
          responseSocket.once('data', onData);
          responseSocket.once('error', onError);
          if (request.type !== 'alloc_pid') {
            responseSocket.once('close', () => {
              cleanup();
              reject(new Error('Response socket closed unexpectedly'));
            });
          }
        } else {
          cleanup();
          reject(new Error('Response socket not available'));
        }
      });
    });
  }
}

// Singleton instance
let ipcClientInstance: IPCClient | null = null;
let cleanupHandlerRegistered = false;

/**
 * Get or create the IPC client instance
 */
export function getIPCClient(workspacePath: string): IPCClient {
  if (!ipcClientInstance || ipcClientInstance['workspacePath'] !== workspacePath) {
    ipcClientInstance = new IPCClient(workspacePath);
  }
  return ipcClientInstance;
}

/**
 * Initialize the IPC client
 */
export async function initializeIPCClient(workspacePath: string): Promise<void> {
  const client = getIPCClient(workspacePath);
  await client.initialize();
}

/**
 * Send a grep request via IPC with fallback to direct ripgrep
 */
export async function requestGrepIPC(
  workspacePath: string,
  pattern: string,
  paths: string[],
  options?: RipgrepOptions
): Promise<string> {
  const client = getIPCClient(workspacePath);
  await client.initialize();
  return await client.requestGrep(pattern, paths, options);
}

/**
 * Clean up the IPC client
 */
export function cleanupIPCClient(): void {
  if (ipcClientInstance) {
    ipcClientInstance.cleanup();
    ipcClientInstance = null;
  }
}
