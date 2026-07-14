/**
 * MCP Memory Server - Level 3 Direction A
 *
 * Exposes MOSS's memory retrieval capability as an MCP (Model Context Protocol)
 * server over stdio. Claude Code and Codex can consume this via --mcp-config.
 *
 * Protocol: JSON-RPC 2.0 over NDJSON (newline-delimited JSON) on stdin/stdout.
 *
 * Tools exposed:
 *   - search_memory: Search project memories by keyword
 *   - get_project_info: Get project metadata and structure
 *   - list_capabilities: List what MOSS can do for coding tasks
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = join(__dirname, '..', 'mcp-memory-store.json');

// --- Memory store ---
function loadMemories() {
  if (!existsSync(MEMORY_FILE)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(MEMORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function searchMemories(query) {
  const memories = loadMemories();
  const q = query.toLowerCase();
  const scored = memories
    .map((m) => {
      const text = `${m.title} ${m.content} ${(m.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const word of q.split(/\s+/)) {
        if (text.includes(word)) score += 1;
      }
      return { mem: m, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (scored.length === 0) {
    return `No memories found for "${query}".`;
  }
  return scored
    .map((r, i) => {
      const m = r.mem;
      return `[${i + 1}] ${m.title} (score: ${r.score})\n    ${m.content}`;
    })
    .join('\n\n');
}

function getProjectInfo() {
  const memories = loadMemories();
  const projectMem = memories.find((m) => m.tags?.includes('project'));
  if (projectMem) {
    return JSON.stringify(projectMem.content, null, 2);
  }
  return 'Project info not available.';
}

function listCapabilities() {
  const caps = [
    'Memory retrieval: Search past decisions, bug fixes, and design choices',
    'Project context: Get project structure, dependencies, and conventions',
    'Code history: Find what was changed, why, and by which AI',
    'Test patterns: Retrieve testing conventions and past test results',
  ];
  return caps.map((c, i) => `${i + 1}. ${c}`).join('\n');
}

// --- MCP tool definitions ---
const TOOLS = [
  {
    name: 'search_memory',
    description:
      'Search MOSS memory store for past decisions, bug fixes, design choices, and project history. Use this to understand why code was written a certain way or find relevant context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords (e.g., "rate limiter", "burst token", "ESM")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_project_info',
    description:
      'Get project metadata: structure, dependencies, conventions, and active verification level.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_capabilities',
    description: 'List what MOSS memory server can help with for coding tasks.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// --- JSON-RPC handler ---
function handleMessage(msg) {
  const { jsonrpc, id, method, params } = msg;

  // Notifications (no id) - no response needed
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      return null; // ack silently
    }
    return null;
  }

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'mcp-memory-server',
            version: '1.0.0',
          },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS,
        },
      };

    case 'tools/call': {
      const { name, arguments: args } = params;
      let text;
      try {
        switch (name) {
          case 'search_memory':
            text = searchMemories(args.query || '');
            break;
          case 'get_project_info':
            text = getProjectInfo();
            break;
          case 'list_capabilities':
            text = listCapabilities();
            break;
          default:
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: `Unknown tool: ${name}`,
              },
            };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text }],
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: `Tool execution error: ${err.message}`,
          },
        };
      }
    }

    case 'ping':
      return {
        jsonrpc: '2.0',
        id,
        result: {},
      };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

// --- stdio transport ---
let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const response = handleMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      // Malformed JSON - send error if we have an id
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err.message}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

// Log to stderr so it doesn't interfere with stdout JSON-RPC
process.stderr.write('[mcp-memory-server] started, waiting for JSON-RPC on stdin...\n');
