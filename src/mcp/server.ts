import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import type {
  WorkmaticDb,
  McpServerOptions,
  WorkmaticMcpServer,
  JobStatusChangeEvent,
} from '../types.js';
import { MCP_TOOL_DEFINITIONS, executeTool } from './tools.js';

export type { McpServerOptions, WorkmaticMcpServer } from '../types.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Creates a lightweight stdio JSON-RPC 2.0 MCP server for Workmatic.
 * Conforms to the MCP Specification (protocol version 2024-11-05).
 */
export function createMcpServer(options: McpServerOptions): WorkmaticMcpServer {
  const db = options.db;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const emitter = new EventEmitter();
  let rl: readline.Interface | null = null;
  let isRunning = false;

  function notifyJobStatusChanged(event: JobStatusChangeEvent): void {
    if (options.onJobStatusChanged) {
      options.onJobStatusChanged(event);
    }
    emitter.emit('jobStatusChanged', event);

    if (event.status === 'ready') {
      if (options.orchestrator) {
        if (event.queue === '*') {
          for (const worker of options.orchestrator.workers()) {
            worker.wakeUp();
          }
        } else {
          try {
            options.orchestrator.worker(event.queue).wakeUp();
          } catch {
            // Queue might not have a registered worker
          }
        }
      }

      if (options.workers) {
        for (const worker of options.workers) {
          if (event.queue === '*' || worker.queue === event.queue) {
            worker.wakeUp();
          }
        }
      }
    }

    if (isRunning) {
      (output as NodeJS.WritableStream).write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/workmatic/job_status_changed',
          params: event,
        }) + '\n'
      );
    }
  }

  async function handleMessage(raw: string): Promise<string | null> {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      });
    }

    // Validate JSON-RPC 2.0 format
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: (msg as { id?: unknown })?.id ?? null,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      });
    }

    const isNotification = msg.id === undefined;

    switch (msg.method) {
      case 'initialize': {
        const result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'workmatic-mcp',
            version: '0.1.0',
          },
        };
        return isNotification ? null : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      }

      case 'notifications/initialized': {
        return null;
      }

      case 'ping': {
        return isNotification ? null : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} });
      }

      case 'tools/list': {
        const result = {
          tools: MCP_TOOL_DEFINITIONS,
        };
        return isNotification ? null : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      }

      case 'tools/call': {
        if (!msg.params || typeof msg.params.name !== 'string') {
          return isNotification
            ? null
            : JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: tool "name" is required',
                },
              });
        }

        const toolName = msg.params.name;
        const toolArgs = (msg.params.arguments as Record<string, unknown>) ?? {};

        try {
          const toolResult = await executeTool(db, toolName, toolArgs, {
            onJobStatusChanged: notifyJobStatusChanged,
          });
          const response = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(toolResult, null, 2),
              },
            ],
          };
          return isNotification ? null : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: response });
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const response = {
            content: [
              {
                type: 'text',
                text: errorMessage,
              },
            ],
            isError: true,
          };
          return isNotification ? null : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: response });
        }
      }

      default: {
        return isNotification
          ? null
          : JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: {
                code: -32601,
                message: `Method not found: ${msg.method}`,
              },
            });
      }
    }
  }

  const server: WorkmaticMcpServer = {
    start() {
      if (isRunning) return;
      isRunning = true;

      rl = readline.createInterface({
        input: input as NodeJS.ReadableStream,
        terminal: false,
      });

      rl.on('line', (line) => {
        void handleMessage(line).then((response) => {
          if (response && isRunning) {
            (output as NodeJS.WritableStream).write(response + '\n');
          }
        });
      });
    },

    stop() {
      if (!isRunning) return;
      isRunning = false;
      rl!.close();
      rl = null;
    },

    handleMessage,

    on(event: 'jobStatusChanged', listener: (event: JobStatusChangeEvent) => void) {
      emitter.on(event, listener);
      return server;
    },

    off(event: 'jobStatusChanged', listener: (event: JobStatusChangeEvent) => void) {
      emitter.off(event, listener);
      return server;
    },
  };

  return server;
}
