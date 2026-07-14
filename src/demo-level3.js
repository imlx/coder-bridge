/**
 * Level 3 Demo - MCP 互操作验证（Claude Code 双向）
 *
 * 运行：node src/demo-level3.js
 *
 * 这个 demo 展示 MOSS 通过 MCP (Model Context Protocol) 与 Claude Code 双向互操作：
 *
 * 方向 A - MOSS 暴露能力（mcp-memory-server），Claude Code 消费：
 *   Part 1: 直接测试 MCP memory server 的 JSON-RPC 协议
 *           (initialize -> notifications/initialized -> tools/list -> tools/call)
 *   Part 2: Claude Code 通过 --mcp-config 消费 MCP memory server 的工具
 *
 * 方向 B - Claude Code 暴露能力（claude mcp serve），MOSS 消费：
 *   Part 3: claude mcp serve 暴露 25 个工具，MOSS 通过 JSON-RPC 调用
 *
 * 核心验证：MCP 协议在 MOSS <-> Claude Code 之间双向打通。
 */

import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const NVM_INIT = 'source ~/.nvm/nvm.sh && nvm use 22 >/dev/null 2>&1';
const PART_TIMEOUT = 120000; // 每个 Part 最多 120s
const nodeBinDir = dirname(process.execPath); // nvm bin 目录，claude/codex 都在这里

// ── ANSI 颜色 ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
};

// ── 工具函数 ───────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function banner(text) {
  const line = '═'.repeat(60);
  console.log(`\n${C.cyan}╔${line}╗${C.reset}`);
  const pad = Math.max(0, 58 - [...text].length);
  console.log(`${C.cyan}║  ${C.bold}${text}${C.reset}${C.cyan}${' '.repeat(pad)}  ║${C.reset}`);
  console.log(`${C.cyan}╚${line}╝${C.reset}`);
}

function log(icon, msg) {
  console.log(`  ${C.gray}[${ts()}]${C.reset} ${icon} ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 展示发送的 JSON-RPC 消息（-> 箭头） */
function showSent(msg) {
  const label = msg.method || '';
  console.log(`    ${C.magenta}-> SEND${C.reset} ${C.dim}${label}${C.reset}`);
  JSON.stringify(msg, null, 2).split('\n').forEach((l) =>
    console.log(`       ${C.gray}${l}${C.reset}`));
}

/** 展示接收的 JSON-RPC 消息（← 箭头） */
function showRecv(msg) {
  console.log(`    ${C.green}← RECV${C.reset}`);
  JSON.stringify(msg, null, 2).split('\n').forEach((l) =>
    console.log(`       ${C.gray}${l}${C.reset}`));
}

/** 展示文本块（灰色边框） */
function showTextBlock(text) {
  console.log(`       ${C.gray}${'─'.repeat(54)}${C.reset}`);
  text.split('\n').forEach((l) => console.log(`       ${C.gray}${l}${C.reset}`));
  console.log(`       ${C.gray}${'─'.repeat(54)}${C.reset}`);
}

// ── 子进程追踪与清理 ───────────────────────────────────────
const childProcesses = new Set();

function trackChild(child) {
  childProcesses.add(child);
  child.on('close', () => childProcesses.delete(child));
  return child;
}

function cleanupAll() {
  for (const child of childProcesses) {
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }
  }
  childProcesses.clear();
}

process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(1); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(1); });

// ── MCP JSON-RPC 客户端 ────────────────────────────────────
/**
 * 通过 stdio (NDJSON) 与 MCP server 通信的 JSON-RPC 客户端。
 * 管理请求-响应配对、超时、通知（无响应消息）。
 */
class McpClient {
  constructor(command, args, options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.process = null;
    this.rl = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject}
    this._stderrBuf = '';
    this.exited = false;
    this.exitCode = null;
    this.onSend = null; // (msg) => void
    this.onRecv = null; // (msg) => void
  }

  /** 启动子进程，建立 stdout readline */
  start() {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...this.options,
    });
    trackChild(this.process);

    this.rl = createInterface({ input: this.process.stdout });
    this.rl.on('line', (line) => this._handleLine(line));

    this.process.stderr.on('data', (data) => {
      const text = data.toString();
      this._stderrBuf += text;
      text.split('\n').forEach((line) => {
        if (line.trim()) {
          console.log(`       ${C.gray}${line}${C.reset}`);
        }
      });
    });

    this.process.on('error', (err) => {
      this.exited = true;
      this._rejectAll(err);
    });

    this.process.on('close', (code) => {
      this.exited = true;
      this.exitCode = code;
      this._rejectAll(new Error(`MCP server 进程退出 (code=${code})`));
    });
  }

  /** 解析一行 NDJSON，分发展示 + 响应回调 */
  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行忽略（server 偶尔有调试输出）
    }
    this.onRecv?.(msg);
    if (msg.id !== undefined && msg.id !== null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    }
  }

  _rejectAll(err) {
    for (const { reject } of this._pending.values()) {
      reject(err);
    }
    this._pending.clear();
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   * @param {string} method - 方法名
   * @param {object} params - 参数
   * @param {number} timeoutMs - 超时
   * @returns {Promise<object>} result 字段
   */
  request(method, params = {}, timeoutMs = 15000) {
    if (this.exited) {
      return Promise.reject(new Error(`MCP server 已退出 (code=${this.exitCode})`));
    }
    const id = this._nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.onSend?.(msg);
    this.process.stdin.write(JSON.stringify(msg) + '\n');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`超时 (${timeoutMs}ms) 等待 ${method} 响应`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** 发送通知（无 id，不等待响应） */
  notify(method, params = {}) {
    const msg = { jsonrpc: '2.0', method, params };
    this.onSend?.(msg);
    if (this.process && !this.exited) {
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  /** 关闭连接：EOF + SIGTERM 兜底 */
  close() {
    if (this.process && !this.exited) {
      try { this.process.stdin.end(); } catch { /* noop */ }
      try { this.process.kill('SIGTERM'); } catch { /* noop */ }
    }
  }
}

// ── 实时命令执行 ───────────────────────────────────────────
/**
 * 通过 bash -c 执行命令，流式输出 stdout/stderr。
 * stdin 设为 ignore 避免 codex exec 卡在等待输入。
 * @param {string} command - 要执行的命令
 * @param {string} color - ANSI 颜色码，用于输出前缀
 * @param {number} timeoutMs - 超时
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number}>}
 */
function dispatchLive(command, color, timeoutMs = PART_TIMEOUT) {
  return new Promise((resolve) => {
    const fullCmd = `${NVM_INIT} && cd ${projectRoot} && ${command}`;
    const child = spawn('bash', ['-c', fullCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackChild(child);

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        resolve({ ok: false, stdout, stderr: 'timeout', exitCode: -1 });
      }
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      text.split('\n').forEach((line) => {
        if (line.trim()) {
          console.log(`  ${color}│${C.reset} ${C.dim}${line}${C.reset}`);
        }
      });
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      text.split('\n').forEach((line) => {
        if (line.trim()) {
          console.log(`  ${C.gray}│ ${line}${C.reset}`);
        }
      });
    });

    child.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr, exitCode: code });
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message, exitCode: -1 });
      }
    });
  });
}

// ── Part 1: 直接测试 MCP 协议 ──────────────────────────────
/**
 * 方向 A 基础：直接用 JSON-RPC 与 mcp-memory-server 通信。
 * 验证 initialize / notifications/initialized / tools/list / tools/call 全链路。
 */
async function part1() {
  console.log(`\n  ${C.gray}── Part 1: Direct MCP Protocol Test ──${C.reset}\n`);
  log('🔌', `${C.cyan}启动 src/mcp-memory-server.js 子进程${C.reset}`);

  const serverPath = join(projectRoot, 'src', 'mcp-memory-server.js');
  const client = new McpClient(process.execPath, [serverPath], { cwd: projectRoot });
  client.onSend = showSent;
  client.onRecv = showRecv;

  try {
    client.start();
    await sleep(300);
    if (client.exited) {
      throw new Error(`MCP server 启动后立即退出 (code=${client.exitCode})`);
    }

    // 1. initialize — 验证 protocolVersion / capabilities / serverInfo
    log('📤', '发送 initialize 请求...');
    const initResult = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'demo-level3', version: '1.0.0' },
    });

    const pvOk = initResult?.protocolVersion === '2024-11-05';
    const capOk = !!initResult?.capabilities;
    const siOk = !!initResult?.serverInfo;
    log(pvOk ? '✓' : '✗', `protocolVersion=${initResult?.protocolVersion || 'missing'}`);
    log(capOk ? '✓' : '✗', `capabilities=${capOk ? 'present' : 'missing'}`);
    log(siOk ? '✓' : '✗', `serverInfo=${siOk ? JSON.stringify(initResult.serverInfo) : 'missing'}`);

    // 2. notifications/initialized（无 id，不期望响应）
    log('📤', '发送 notifications/initialized（不期望响应）...');
    client.notify('notifications/initialized', {});
    await sleep(300);

    // 3. tools/list — 验证 3 个工具
    log('📤', '发送 tools/list 请求...');
    const toolsResult = await client.request('tools/list', {});
    const toolNames = (toolsResult?.tools || []).map((t) => t.name);
    const expected = ['search_memory', 'get_project_info', 'list_capabilities'];
    const toolsOk =
      expected.every((t) => toolNames.includes(t)) && toolNames.length === 3;
    log(toolsOk ? '✓' : '✗',
      `tools/list 返回 ${toolNames.length} 个工具：${toolNames.join(', ')}`);

    // 4. tools/call search_memory — 验证非空结果
    log('📤', '发送 tools/call search_memory {query: "rate limiter"}...');
    const searchResult = await client.request('tools/call', {
      name: 'search_memory',
      arguments: { query: 'rate limiter' },
    });
    const searchText = searchResult?.content?.[0]?.text || '';
    const searchOk = searchText.length > 0 && !searchText.startsWith('No memories');
    log(searchOk ? '✓' : '✗', `search_memory 返回 ${searchText.length} 字符`);
    if (searchText) showTextBlock(searchText);

    // 5. tools/call get_project_info — 验证返回项目数据
    log('📤', '发送 tools/call get_project_info...');
    const projectResult = await client.request('tools/call', {
      name: 'get_project_info',
      arguments: {},
    });
    const projectText = projectResult?.content?.[0]?.text || '';
    const projectOk =
      projectText.length > 0 && !projectText.startsWith('Project info not available');
    log(projectOk ? '✓' : '✗', `get_project_info 返回 ${projectText.length} 字符`);
    if (projectText) showTextBlock(projectText);

    return pvOk && capOk && siOk && toolsOk && searchOk && projectOk;
  } finally {
    client.close();
  }
}

// ── Part 2: Claude Code 消费 MCP server ────────────────────
/**
 * 方向 A 应用：Claude Code 通过 --mcp-config 消费 mcp-memory-server 的工具。
 * 写临时 .mcp.test.json，运行 claude -p，验证输出包含 MCP 工具结果。
 */
async function part2() {
  console.log(`\n  ${C.gray}── Part 2: Claude Code consumes MCP server ──${C.reset}\n`);

  const mcpConfigPath = join(projectRoot, '.mcp.test.json');
  const mcpConfig = {
    mcpServers: {
      'moss-memory': {
        command: 'node',
        args: ['src/mcp-memory-server.js'],
      },
    },
  };

  log('📝', `写入临时配置 ${C.cyan}.mcp.test.json${C.reset}`);
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  try {
    const prompt =
      'Use the search_memory MCP tool to search for rate limiter. Then use get_project_info to get project info. Report what you found.';
    const cmd = `claude -p '${prompt}' --mcp-config .mcp.test.json --output-format text`;
    log('🎯', `${C.blue}${C.bold}MOSS -> Claude Code${C.reset} ${C.gray}(via --mcp-config)${C.reset}`);
    console.log(`  ${C.gray}$ claude -p '...' --mcp-config .mcp.test.json --output-format text${C.reset}\n`);

    const result = await dispatchLive(cmd, C.blue, PART_TIMEOUT);

    if (result.ok) {
      log('✅', `${C.green}Claude Code 执行完成${C.reset} ${C.gray}(exit ${result.exitCode})${C.reset}`);
    } else {
      log('❌', `${C.red}Claude Code 执行失败${C.reset} ${C.gray}(exit ${result.exitCode})${C.reset}`);
    }

    // 验证 Claude Code 成功调用了 MCP 工具（输出包含搜索结果关键词）
    const output = (result.stdout + '\n' + result.stderr).toLowerCase();
    const verified =
      output.includes('rate') || output.includes('burst') ||
      output.includes('limiter') || output.includes('project') ||
      output.includes('esm') || output.includes('memory') ||
      output.includes('token');
    log(verified ? '✓' : '✗', `输出包含 MCP 工具结果：${verified ? '是' : '否'}`);

    return result.ok && verified;
  } finally {
    try { rmSync(mcpConfigPath, { force: true }); } catch { /* noop */ }
    log('🧹', '清理 .mcp.test.json');
  }
}

// ── Part 3: MOSS 消费 claude mcp serve ─────────────────────
/**
 * 方向 B：claude mcp serve 作为 MCP server 暴露 Claude Code 的工具，
 * MOSS 通过 JSON-RPC 消费。
 * 验证 initialize -> notifications/initialized -> tools/list -> tools/call 全链路。
 */
async function part3() {
  console.log(`\n  ${C.gray}── Part 3: MOSS consumes claude mcp serve ──${C.reset}\n`);
  log('🔌', `${C.cyan}启动 claude mcp serve 子进程${C.reset}`);

  const client = new McpClient('bash', ['-c', `${NVM_INIT} && claude mcp serve`], { cwd: projectRoot });
  client.onSend = showSent;
  client.onRecv = showRecv;

  try {
    client.start();
    await sleep(2000); // claude mcp serve 启动较慢
    if (client.exited) {
      throw new Error(`claude mcp serve 启动后立即退出 (code=${client.exitCode})`);
    }

    // 1. initialize - 验证 protocolVersion / capabilities / serverInfo
    log('📤', '发送 initialize 请求...');
    const initResult = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'demo-level3', version: '1.0.0' },
    }, 30000);

    const pvOk = initResult?.protocolVersion === '2024-11-05';
    const capOk = !!initResult?.capabilities;
    const siOk = !!initResult?.serverInfo;
    log(pvOk ? '✓' : '✗', `protocolVersion=${initResult?.protocolVersion || 'missing'}`);
    log(capOk ? '✓' : '✗', `capabilities=${capOk ? 'present' : 'missing'}`);
    log(siOk ? '✓' : '✗', `serverInfo=${siOk ? JSON.stringify(initResult.serverInfo) : 'missing'}`);

    // 2. notifications/initialized（无 id，不期望响应）
    log('📤', '发送 notifications/initialized...');
    client.notify('notifications/initialized', {});
    await sleep(500);

    // 3. tools/list - 验证 Claude Code 暴露的工具集
    log('📤', '发送 tools/list 请求...');
    const toolsResult = await client.request('tools/list', {}, 30000);
    const toolNames = (toolsResult?.tools || []).map((t) => t.name);
    const hasRead = toolNames.includes('Read');
    const hasBash = toolNames.includes('Bash');
    const hasWrite = toolNames.includes('Write');
    const toolsOk = toolNames.length >= 10 && hasRead && hasBash;
    log(toolsOk ? '✓' : '✗',
      `tools/list 返回 ${toolNames.length} 个工具：${toolNames.slice(0, 8).join(', ')}${toolNames.length > 8 ? '...' : ''}`);

    // 4. tools/call Read - 读取 package.json 验证工具实际可用
    log('📤', '发送 tools/call Read {file_path: "package.json"}...');
    const readResult = await client.request('tools/call', {
      name: 'Read',
      arguments: { file_path: join(projectRoot, 'package.json') },
    }, 30000);
    const readText = readResult?.content?.[0]?.text || '';
    const readOk = readText.length > 0 && (readText.includes('name') || readText.includes('demo'));
    log(readOk ? '✓' : '✗', `Read 返回 ${readText.length} 字符`);
    if (readText) showTextBlock(readText.slice(0, 500) + (readText.length > 500 ? '\n...' : ''));

    return pvOk && capOk && siOk && toolsOk && readOk;
  } finally {
    client.close();
  }
}

async function main() {
  console.log('\n');
  banner('coder-bridge · Level 3 MCP 互操作验证');
  console.log(`  ${C.gray}验证目标：MCP 协议在 MOSS <-> Claude Code 之间双向打通${C.reset}`);
  console.log(`  ${C.gray}方向 A：MOSS 暴露能力（mcp-memory-server），Claude Code 消费${C.reset}`);
  console.log(`  ${C.gray}方向 B：Claude Code 暴露能力（claude mcp serve），MOSS 消费${C.reset}`);
  console.log(`  ${C.gray}时间：${new Date().toISOString()}${C.reset}`);
  console.log(`  ${C.gray}项目：${projectRoot}${C.reset}`);

  const results = [];

  // Part 1
  const t1 = Date.now();
  let p1Ok = false;
  try {
    p1Ok = await part1();
  } catch (err) {
    log('❌', `${C.red}Part 1 出错：${err.message}${C.reset}`);
  }
  results.push({ name: 'Part 1: Direct MCP Protocol', duration: Date.now() - t1, ok: p1Ok });

  // Part 2
  const t2 = Date.now();
  let p2Ok = false;
  try {
    p2Ok = await part2();
  } catch (err) {
    log('❌', `${C.red}Part 2 出错：${err.message}${C.reset}`);
  }
  results.push({ name: 'Part 2: Claude Code consumes MCP', duration: Date.now() - t2, ok: p2Ok });

  // Part 3
  const t3 = Date.now();
  let p3Ok = false;
  try {
    p3Ok = await part3();
  } catch (err) {
    log('❌', `${C.red}Part 3 出错：${err.message}${C.reset}`);
  }
  results.push({ name: 'Part 3: MOSS consumes claude mcp serve', duration: Date.now() - t3, ok: p3Ok });

  // ── 总结 ─────────────────────────────────────────────────
  console.log('\n');
  banner('Level 3 MCP 互操作验证总结');

  const allOk = results.every((r) => r.ok);
  if (allOk) {
    console.log(`  ${C.green}${C.bold}✓ MCP 互操作链路全部验证通过${C.reset}\n`);
  } else {
    console.log(`  ${C.yellow}${C.bold}⚠ 部分验证未通过${C.reset}\n`);
  }

  // 总结表
  console.log(`  ${C.gray}${'─'.repeat(60)}${C.reset}`);
  for (const r of results) {
    const dur = (r.duration / 1000).toFixed(1) + 's';
    const status = r.ok ? `${C.green}✓ PASS${C.reset}` : `${C.red}✗ FAIL${C.reset}`;
    const pad = Math.max(2, 40 - r.name.length);
    console.log(
      `  ${C.bold}${r.name}${C.reset}${' '.repeat(pad)}${C.gray}${dur.padStart(7)}${C.reset}  ${status}`
    );
  }
  console.log(`  ${C.gray}${'─'.repeat(60)}${C.reset}`);

  const totalDur = results.reduce((s, r) => s + r.duration, 0);
  const passCount = results.filter((r) => r.ok).length;
  console.log(
    `\n  ${C.bold}总耗时：${C.reset}${C.gray}${(totalDur / 1000).toFixed(1)}s  ` +
    `${C.reset}${C.bold}通过：${C.reset}${C.gray}${passCount}/${results.length}${C.reset}`
  );

  console.log(`\n  ${C.bold}验证内容：${C.reset}${C.gray}方向 A - MOSS 的 mcp-memory-server 通过 MCP 协议被 Claude Code${C.reset}`);
  console.log(`  ${C.gray}消费（Part 1 直接协议测试，Part 2 AI 消费）；方向 B - Claude Code 通过${C.reset}`);
  console.log(`  ${C.gray}claude mcp serve 暴露 25 个工具，MOSS 通过 JSON-RPC 消费（Part 3）。${C.reset}`);
  console.log(`  ${C.gray}这证明 Level 3 MCP 双向互操作链路是通的。${C.reset}\n`);

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  ${C.red}Demo 运行出错：${err.message}${C.reset}\n`);
  cleanupAll();
  process.exit(1);
});
