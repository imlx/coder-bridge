/**
 * Level 2 Demo - Streaming Multi-turn 验证
 *
 * 运行：npm run demo:2
 *
 * 这个 demo 展示 MOSS 通过 stream-json 协议与 Claude Code 进行多轮流式通信：
 * - 用 child_process.spawn 启动 claude CLI（stream-json 输入输出模式）
 * - 在同一个 session 内进行三轮渐进式编码任务：
 *   Round 1：分析 src/rateLimiter.js 的设计缺陷
 *   Round 2：基于分析结果修改 rateLimiter.js，添加 burst 控制
 *   Round 3：为修改后的代码写单元测试
 * - 实时展示 Claude Code 的 thinking / text / tool_use 消息流
 * - 每轮结束显示 duration / cost / turns
 *
 * stream-json 协议（NDJSON over stdin/stdout）：
 * - 输入：向 stdin 逐行写 {"type":"user","message":{"role":"user","content":"..."}}
 * - 输出：system(init) / assistant(thinking|text|tool_use) / user(tool_result) / result(success)
 * - 收到 result 后可继续写下一条 user message，同一 session 上下文保持
 *
 * 这是 Level 2 的正确验证方式：你看的是"MOSS 在一个 session 内与 Claude Code
 * 多轮对话、可见每轮工具调用"这个过程本身，验证流式多轮通信链路是通的。
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const ROUND_TIMEOUT = 300000; // 每轮最多 300 秒

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

/**
 * 从 tool_use 的 input 中提取关键参数用于展示
 * @param {string} name - 工具名
 * @param {object} input - 工具输入
 * @returns {string}
 */
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return input.file_path || '';
    case 'Bash':
      return input.command || '';
    case 'Glob':
      return input.pattern || '';
    case 'Grep':
      return input.pattern || '';
    case 'NotebookEdit':
      return input.notebook_path || '';
    default: {
      // 取第一个字符串值作为摘要
      const vals = Object.values(input).filter((v) => typeof v === 'string');
      return vals[0] || '';
    }
  }
}

/**
 * 展示 assistant 消息的 content blocks（thinking / text / tool_use）
 * @param {Array} content
 */
function displayAssistantContent(content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'thinking') {
      const text = (block.thinking || '').trim();
      if (!text) continue;
      text.split('\n').forEach((line) => {
        console.log(`  ${C.gray}💭 ${line}${C.reset}`);
      });
    } else if (block.type === 'text') {
      const text = (block.text || '').trim();
      if (!text) continue;
      text.split('\n').forEach((line) => {
        console.log(`  ${C.white}💬 ${line}${C.reset}`);
      });
    } else if (block.type === 'tool_use') {
      const summary = summarizeToolInput(block.name, block.input);
      const shown = summary.length > 60 ? summary.slice(0, 57) + '...' : summary;
      const tail = shown ? ` ${C.gray}${shown}${C.reset}` : '';
      console.log(`  ${C.yellow}🔧 ${block.name}${tail}${C.reset}`);
    }
  }
}

/**
 * 展示 user 消息中的 tool_result（工具执行回传，只显示首行摘要）
 * @param {Array} content
 */
function displayUserContent(content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const raw =
      typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? '');
    const text = raw.trim();
    if (!text) continue;
    const firstLine = text.split('\n')[0];
    const shown = firstLine.length > 70 ? firstLine.slice(0, 67) + '...' : firstLine;
    console.log(`  ${C.gray}  ↳ ${shown}${C.reset}`);
  }
}

// ── Claude Code stream-json session ────────────────────────
/**
 * 管理一个 claude CLI stream-json session。
 * 启动进程 -> readline 逐行读 stdout -> 解析 NDJSON -> 实时展示。
 * sendRound() 向 stdin 写一条 user message 并等待本轮 result 消息。
 */
class ClaudeStreamSession {
  constructor(cwd) {
    this.cwd = cwd;
    this.process = null;
    this.rl = null;
    this.exited = false;
    this.exitCode = null;
    this._stderrBuf = '';
    this._roundResolve = null;
    this._roundReject = null;
  }

  /** 启动 claude 进程，建立 stdout readline */
  start() {
    const args = [
      '-p',
      '--model', 'sonnet',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    const CLAUDE_BIN = process.env.CLAUDE_BIN || '';
    this.process = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: CLAUDE_BIN + ':' + (process.env.PATH || '') },
    });

    this.rl = createInterface({ input: this.process.stdout });
    this.rl.on('line', (line) => this._handleLine(line));

    this.process.stderr.on('data', (data) => {
      this._stderrBuf += data.toString();
    });

    // stdin 写入失败时不至于崩掉 demo
    this.process.stdin.on('error', (err) => {
      if (this._roundReject) this._roundReject(err);
    });

    this.process.on('error', (err) => {
      this.exited = true;
      if (this._roundReject) this._roundReject(err);
    });

    this.process.on('close', (code) => {
      this.exited = true;
      this.exitCode = code;
      // 进程退出时若还在等 result，带上 stderr 尾部信息 reject
      if (this._roundReject) {
        const tail = this._stderrBuf.slice(-500);
        this._roundReject(
          new Error(
            `claude 进程退出 (code=${code})${tail ? `\nstderr: ${tail}` : ''}`
          )
        );
      }
    });
  }

  /** 解析一行 NDJSON 并分发展示 */
  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // 非 JSON 行忽略（verbose 模式偶尔有调试输出）
      return;
    }

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          const sid = (msg.session_id || '').slice(0, 8);
          log('🔌', `${C.gray}session 初始化${C.reset} ${C.gray}(model=${msg.model || '?'} session=${sid})${C.reset}`);
        }
        break;

      case 'assistant':
        displayAssistantContent(msg.message?.content);
        break;

      case 'user':
        // stream-json 中 tool_result 以 user 消息形式回传
        displayUserContent(msg.message?.content);
        break;

      case 'result':
        if (this._roundResolve) {
          const resolve = this._roundResolve;
          this._roundResolve = null;
          this._roundReject = null;
          resolve(msg);
        }
        break;

      default:
        break;
    }
  }

  /**
   * 发送一条 user message 并等待本轮 result
   * @param {string} content - 用户指令
   * @param {number} timeoutMs - 超时
   * @returns {Promise<object>} result 消息
   */
  sendRound(content, timeoutMs = ROUND_TIMEOUT) {
    if (this.exited) {
      return Promise.reject(
        new Error(`claude 进程已退出 (code=${this.exitCode})，无法发送`)
      );
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._roundResolve = null;
        this._roundReject = null;
        reject(new Error(`本轮超时 (${timeoutMs / 1000}s)`));
      }, timeoutMs);

      this._roundResolve = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this._roundReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      this.process.stdin.write(payload + '\n');
    });
  }

  /** 关闭 session：EOF + SIGTERM 兜底 */
  close() {
    if (this.process && !this.exited) {
      try {
        this.process.stdin.end();
      } catch {
        /* noop */
      }
      this.process.kill('SIGTERM');
    }
  }
}

// ── 三轮任务定义 ───────────────────────────────────────────
const ROUNDS = [
  {
    title: 'Round 1 · 分析代码',
    desc: '分析 src/rateLimiter.js 设计缺陷',
    prompt: [
      '请仔细阅读并分析 src/rateLimiter.js 这个文件，找出它的设计缺陷和改进空间。',
      '重点关注：',
      '1) 并发安全（多调用同时 tryConsume 会不会超卖）',
      '2) burst 控制（突发流量能否短时借用额外额度）',
      '3) 持久化（重启后状态丢失）',
      '4) 多桶支持（不同资源不同限额）',
      '5) metrics 可观测性',
      '注意：这一轮只做分析，不要修改任何文件。给出具体的问题列表和改进建议。',
    ].join('\n'),
  },
  {
    title: 'Round 2 · 修复 bug',
    desc: '为 rateLimiter.js 添加 burst 控制支持',
    prompt: [
      '基于你刚才在 Round 1 的分析，现在请实际修改 src/rateLimiter.js，添加 burst 控制支持。',
      '具体要求：',
      '1) 构造函数新增 burst 相关配置项（如 burstCapacity / burstRefillRate），可选，有合理默认值',
      '2) 新增一个独立的 burst token pool，主 token 不足时 tryConsume 可借用 burst',
      '3) 暴露 getAvailableBurst() 或类似方法查询 burst 余量',
      '4) 保持向后兼容：不传 burst 配置时行为与原来一致',
      '5) 不要破坏现有 export（RateLimiter / TimeoutError）',
      '只修改 src/rateLimiter.js 这一个文件，不要动其他文件。',
    ].join('\n'),
  },
  {
    title: 'Round 3 · 写测试',
    desc: '为 burst 控制写单元测试',
    timeout: 600000, // 写测试任务较重，给 600s
    prompt: [
      '为修改后的 src/rateLimiter.js 写单元测试，保存到 tests/ratelimiter-burst.test.js。',
      '要求：',
      '1) 使用 node:test 和 node:assert（与 tests/unit.test.js 风格一致）',
      '2) 重点测试新增的 burst 控制功能：',
      '   - burst 借用：主 token 耗尽后能从 burst 借',
      '   - burst 耗尽后降级拒绝',
      '   - burst token 随时间恢复',
      '   - 向后兼容：不传 burst 配置时原有行为不变',
      '3) 也补一个并发安全的测试（验证修复后不再超卖）',
      '只创建 tests/ratelimiter-burst.test.js，不要修改其他文件。',
    ].join('\n'),
  },
];

// ── 主流程 ─────────────────────────────────────────────────
/**
 * Level 2 Streaming Multi-turn 验证主流程
 * 启动 claude stream-json session，进行三轮渐进式编码对话，展示总结
 */
export async function runDemo() {
  console.log('\n');
  banner('coder-bridge · Level 2 Streaming Multi-turn 验证');
  console.log(`  ${C.gray}验证目标：MOSS 通过 stream-json 协议与 Claude Code 多轮流式通信${C.reset}`);
  console.log(`  ${C.gray}通信协议：stream-json (NDJSON over stdin/stdout)${C.reset}`);
  console.log(`  ${C.gray}时间：${new Date().toISOString()}${C.reset}`);
  console.log(`  ${C.gray}项目：${projectRoot}${C.reset}`);

  const roundResults = [];

  // 启动 claude stream-json session
  console.log(`\n  ${C.gray}── 启动 Claude Code stream-json session ──${C.reset}`);
  const session = new ClaudeStreamSession(projectRoot);

  try {
    session.start();
    log('🚀', `${C.blue}spawn claude${C.reset} ${C.gray}-p --input-format stream-json --output-format stream-json --verbose${C.reset}`);

    // 给进程一点启动时间，确认没立即退出
    await sleep(500);
    if (session.exited) {
      throw new Error(`claude 进程启动后立即退出 (code=${session.exitCode})`);
    }

    // 三轮渐进式编码对话
    for (let i = 0; i < ROUNDS.length; i++) {
      const round = ROUNDS[i];

      console.log(`\n  ${C.gray}${'━'.repeat(56)}${C.reset}`);
      console.log(`  ${C.bold}${C.cyan}${round.title}${C.reset} ${C.gray}${round.desc}${C.reset}`);
      console.log(`  ${C.gray}${'━'.repeat(56)}${C.reset}`);

      // 显示 MOSS 发送的指令
      log('📨', `${C.magenta}${C.bold}MOSS -> Claude Code${C.reset}`);
      round.prompt.split('\n').forEach((line, idx) => {
        const prefix = idx === 0 ? '▸ ' : '  ';
        console.log(`  ${C.magenta}${prefix}${line}${C.reset}`);
      });
      console.log(`  ${C.gray}${'·'.repeat(56)}${C.reset}`);

      let result;
      try {
        result = await session.sendRound(round.prompt, round.timeout || ROUND_TIMEOUT);
      } catch (err) {
        log('❌', `${C.red}${round.title} 失败：${err.message}${C.reset}`);
        roundResults.push({
          round,
          ok: false,
          error: err.message,
          duration_ms: 0,
          cost_usd: 0,
          num_turns: 0,
        });
        // 某轮失败则终止后续（session 状态已不确定）
        break;
      }

      const ok = result.subtype === 'success';
      const cost = result.total_cost_usd ?? result.cost_usd ?? 0;
      roundResults.push({
        round,
        ok,
        duration_ms: result.duration_ms || 0,
        cost_usd: cost,
        num_turns: result.num_turns || 0,
      });

      console.log(`  ${C.gray}${'·'.repeat(56)}${C.reset}`);
      if (ok) {
        log('✅', `${C.green}${round.title} 完成${C.reset}`);
      } else {
        log('⚠️', `${C.yellow}${round.title} 非 success：${result.subtype}${C.reset}`);
      }
      console.log(
        `  ${C.gray}duration=${((result.duration_ms || 0) / 1000).toFixed(1)}s  ` +
        `cost=$${cost.toFixed(4)}  turns=${result.num_turns || 0}${C.reset}`
      );

      // 轮间小憩
      if (i < ROUNDS.length - 1) await sleep(400);
    }
  } finally {
    session.close();
  }

  // ── 产出验证 ─────────────────────────────────────────────
  console.log(`\n  ${C.gray}── 产出验证 ──${C.reset}\n`);
  const rateLimiterPath = join(projectRoot, 'src', 'rateLimiter.js');
  const testPath = join(projectRoot, 'tests', 'ratelimiter-burst.test.js');

  let burstAdded = false;
  let testCreated = false;

  if (existsSync(rateLimiterPath)) {
    const rlContent = readFileSync(rateLimiterPath, 'utf-8');
    burstAdded = /burst/i.test(rlContent);
    log(
      burstAdded ? '✅' : '❌',
      `rateLimiter.js ${burstAdded ? `${C.green}已添加 burst 相关代码${C.reset}` : `${C.red}未见 burst 修改${C.reset}`}`
    );
  } else {
    log('❌', `${C.red}src/rateLimiter.js 不存在${C.reset}`);
  }

  if (existsSync(testPath)) {
    const testContent = readFileSync(testPath, 'utf-8');
    testCreated = testContent.includes('node:test') && testContent.length > 50;
    log(
      testCreated ? '✅' : '❌',
      `ratelimiter-burst.test.js ${testCreated ? `${C.green}已创建${C.reset}` : `${C.red}内容异常${C.reset}`}`
    );
  } else {
    log('❌', `${C.red}tests/ratelimiter-burst.test.js 未创建${C.reset}`);
  }

  // ── 总结 ─────────────────────────────────────────────────
  console.log('\n');
  banner('Level 2 Streaming Multi-turn 验证总结');

  const allRoundsOk = roundResults.every((r) => r.ok);
  const allOk = allRoundsOk && burstAdded && testCreated;
  if (allOk) {
    console.log(`  ${C.green}${C.bold}✓ 流式多轮通信链路验证通过${C.reset}\n`);
  } else {
    console.log(`  ${C.yellow}${C.bold}⚠ 部分验证未通过${C.reset}\n`);
  }

  let totalCost = 0;
  let totalDuration = 0;
  for (const r of roundResults) {
    totalCost += r.cost_usd;
    totalDuration += r.duration_ms;
    const status = r.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`  ${status} ${C.bold}${r.round.title}${C.reset}`);
    console.log(`    ${C.gray}${r.round.desc}${C.reset}`);
    console.log(
      `    ${C.gray}duration=${(r.duration_ms / 1000).toFixed(1)}s  cost=$${r.cost_usd.toFixed(4)}  turns=${r.num_turns}${C.reset}`
    );
    if (r.error) {
      console.log(`    ${C.red}error: ${r.error}${C.reset}`);
    }
  }

  console.log(
    `\n  ${C.bold}合计：${C.reset}${C.gray}duration=${(totalDuration / 1000).toFixed(1)}s  ` +
    `cost=$${totalCost.toFixed(4)}  rounds=${roundResults.length}/${ROUNDS.length}${C.reset}`
  );

  console.log(`\n  ${C.bold}验证内容：${C.reset}${C.gray}MOSS 在单个 stream-json session 内与 Claude Code 进行了三轮${C.reset}`);
  console.log(`  ${C.gray}渐进式编码对话（分析 → 修改 → 测试），全程可见 thinking / text / tool_use 消息流。${C.reset}`);
  console.log(`  ${C.gray}这证明 Level 2 流式多轮通信链路是通的。${C.reset}`);
  console.log(`\n  ${C.gray}src/rateLimiter.js 和 tests/ratelimiter-burst.test.js 的改动保留供检查。${C.reset}\n`);

  process.exit(allOk ? 0 : 1);
}

// 直接运行时执行
runDemo().catch((err) => {
  console.error(`\n  ${C.red}Demo 运行出错：${err.message}${C.reset}\n`);
  process.exit(1);
});
