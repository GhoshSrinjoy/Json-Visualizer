/**
 * StructLens MCP server: exposes repository, data-file and code structure to
 * AI agents (Claude Code, Codex, Copilot, Cursor, Gemini CLI, …). Every tool
 * is read-only and returns compact text designed for an agent's context.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import type { Workspace } from '../node/workspace';
import { VERSION } from '../shared/version';
import { TOOLS, toolErrorMessage, type ToolContext } from './tools';

export interface McpServerOptions extends ToolContext {
  /** Max characters per tool result (default 60k). */
  maxChars?: number;
  /** Adopt the client's workspace roots when it advertises them (default true unless roots were given explicitly). */
  useClientRoots?: boolean;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const SERVER_INSTRUCTIONS =
  'StructLens shows the structure of this workspace. Start with repo_overview, then drill down: repo_tree for folders, ' +
  'file_structure for any file (data files get a schema, code files an outline), code_flow / code_dataflow for one ' +
  'function, call_graph and dependency_graph for relationships, data_query / data_search / data_tree for big ' +
  'JSON/YAML/XML/CSV/Excel files. Paths are relative to the workspace root. Use open_visualizer to show the user an interactive diagram.';

export function createMcpServer(ws: Workspace, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'structlens', title: 'StructLens', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const maxChars = options.maxChars ?? 60_000;

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...READ_ONLY },
      },
      async (args: Record<string, unknown>) => {
        try {
          let text = await tool.run(ws, args ?? {}, options);
          if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters — narrow the request)`;
          return { content: [{ type: 'text' as const, text }] };
        } catch (e) {
          return { isError: true, content: [{ type: 'text' as const, text: toolErrorMessage(e) }] };
        }
      },
    );
  }

  if (options.useClientRoots !== false) {
    const adoptRoots = async () => {
      if (!server.server.getClientCapabilities()?.roots) return;
      try {
        const { roots } = await server.server.listRoots();
        const dirs = roots.map((r) => (r.uri.startsWith('file:') ? fileURLToPath(r.uri) : r.uri)).filter(Boolean);
        if (dirs.length) ws.setRoots(dirs);
      } catch {
        // Client advertised roots but failed to list them: keep the defaults.
      }
    };
    server.server.oninitialized = () => void adoptRoots();
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => void adoptRoots());
  }
  return server;
}
