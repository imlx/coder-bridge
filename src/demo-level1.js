/**
 * Level 1 Demo - Live Dispatch 验证
 *
 * 运行：npm run demo:1
 *
 * 这个 demo 展示 MOSS 一次性调度 Claude Code 和 Codex 执行真实编码任务：
 * - 接收编码任务
 * - 分派给 Claude Code (claude -p "...") 创建真实文件
 * - 分派给 Codex (codex exec "...") 创建真实文件
 * - 展示两者的实时 CLI 输出和产出的代码
 * - 验证 one-shot dispatch 链路
 *
 * 这是 Level 1 的正确验证方式：你看的是"MOSS 调度两个 AI 干活"这个过程本身，
 * 不是"两个 AI 写的代码能不能跑"。
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const scratchDir = join(projectRoot, 'scratch');
const NVM_INIT = 'source ~/.nvm/nvm.sh && nvm use 22 >/dev/null 2>&1';
const DISPATCH_TIMEOUT = 90000; // 90s per dispatch

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
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 实时执行命令，流式输出 stdout/stderr
 * stdin 设为 ignore 避免 codex exec 卡在等待输入
 * @param {string} command - 要执行的完整命令
 * @param {string} color - ANSI 颜色码，用于输出前缀
 * @returns {Promise<{ok: boolean, stdout: string, exitCode: number}>}
 */
function dispatchLive(command, color) {
  return new Promise((resolve) => {
    const fullCmd = `${NVM_INIT} && cd ${projectRoot} && ${command}`;
    const child = spawn('bash', ['-c', fullCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        resolve({ ok: false, stdout, stderr: 'timeout', exitCode: -1 });
      }
    }, DISPATCH_TIMEOUT);

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

/**
 * 读取并展示文件内容
 */
function showFile(filePath, label, color) {
  if (!existsSync(filePath)) {
    log('❌', `${C.red}文件未创建：${filePath}${C.reset}`);
    return null;
  }

  const content = readFileSync(filePath, 'utf-8');
  console.log(`\n  ${color}${C.bold}📄 ${label} 产出文件：${C.reset}`);
  console.log(`  ${C.gray}${'─'.repeat(56)}${C.reset}`);

  content.split('\n').forEach((line, i) => {
    const lineNum = String(i + 1).padStart(3, ' ');
    console.log(`  ${C.gray}${lineNum} │${C.reset} ${line}`);
  });

  console.log(`  ${C.gray}${'─'.repeat(56)}${C.reset}`);
  return content;
}

// ── 编码任务定义 ───────────────────────────────────────────
const CLAUDE_TASK = {
  agent: 'Claude Code',
  version: '2.1.206',
  color: C.blue,
  command: `claude -p "在 scratch/ 目录下创建文件 claude-output.js，导出一个 formatTimestamp(date) 函数。接收一个 Date 对象，返回 'YYYY-MM-DD HH:mm:ss' 格式的字符串。只创建这一个文件，不要修改其他文件。" --output-format text`,
  outputFile: join(scratchDir, 'claude-output.js'),
  taskDesc: '创建 formatTimestamp(date) 工具函数',
};

const CODEX_TASK = {
  agent: 'Codex CLI',
  version: '0.144.1',
  color: C.green,
  command: `codex exec "在 scratch/ 目录下创建文件 codex-output.js，导出一个 generateId() 函数。返回 8 位随机小写字母数字 ID 字符串。只创建这一个文件，不要修改其他文件。" -s workspace-write`,
  outputFile: join(scratchDir, 'codex-output.js'),
  taskDesc: '创建 generateId() 工具函数',
};

// ── 主流程 ─────────────────────────────────────────────────
async function main() {
  // 1. 初始化
  console.log('\n');
  banner('coder-bridge · Level 1 Live Dispatch 验证');
  console.log(`  ${C.gray}验证目标：MOSS 一次性调度 Claude Code 和 Codex 执行真实编码任务${C.reset}`);
  console.log(`  ${C.gray}调度方：MOSS (BaiLongma 2.1.479)${C.reset}`);
  console.log(`  ${C.gray}时间：${new Date().toISOString()}${C.reset}`);
  console.log(`  ${C.gray}项目：${projectRoot}${C.reset}`);

  // 2. 准备 scratch 目录
  console.log(`\n  ${C.gray}── 准备工作 ──${C.reset}`);
  if (existsSync(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
    log('🧹', '清理旧的 scratch/ 目录');
  }
  mkdirSync(scratchDir, { recursive: true });
  log('📂', `创建 scratch/ 目录：${scratchDir}`);

  // 验证 claude 和 codex 可用
  const checkCmd = `${NVM_INIT} && which claude && claude --version && which codex && codex --version`;
  const check = await dispatchLive(checkCmd, C.gray);
  if (!check.ok) {
    log('❌', `${C.red}环境检查失败，claude 或 codex 不可用${C.reset}`);
    log('💡', `${C.dim}请确认 nvm node 22 已安装 claude 和 codex${C.reset}`);
    process.exit(1);
  }

  // 3. 分派给 Claude Code
  console.log(`\n  ${C.gray}── Dispatch 1/2 ──${C.reset}\n`);
  log('🎯', `${C.blue}${C.bold}MOSS -> Claude Code${C.reset} ${C.gray}(${CLAUDE_TASK.version})${C.reset}`);
  log('📋', `任务：${CLAUDE_TASK.taskDesc}`);
  console.log(`  ${C.gray}$ ${CLAUDE_TASK.command}${C.reset}\n`);

  const claudeResult = await dispatchLive(CLAUDE_TASK.command, C.blue);

  if (claudeResult.ok) {
    log('✅', `${C.green}Claude Code 执行完成${C.reset} ${C.gray}(exit ${claudeResult.exitCode})${C.reset}`);
  } else {
    log('❌', `${C.red}Claude Code 执行失败${C.reset} ${C.gray}(exit ${claudeResult.exitCode})${C.reset}`);
  }

  await sleep(300);
  showFile(CLAUDE_TASK.outputFile, 'Claude Code', C.blue);

  // 4. 分派给 Codex
  console.log(`\n  ${C.gray}── Dispatch 2/2 ──${C.reset}\n`);
  log('🎯', `${C.green}${C.bold}MOSS -> Codex CLI${C.reset} ${C.gray}(${CODEX_TASK.version})${C.reset}`);
  log('📋', `任务：${CODEX_TASK.taskDesc}`);
  console.log(`  ${C.gray}$ ${CODEX_TASK.command}${C.reset}\n`);

  const codexResult = await dispatchLive(CODEX_TASK.command, C.green);

  if (codexResult.ok) {
    log('✅', `${C.green}Codex 执行完成${C.reset} ${C.gray}(exit ${codexResult.exitCode})${C.reset}`);
  } else {
    log('❌', `${C.red}Codex 执行失败${C.reset} ${C.gray}(exit ${codexResult.exitCode})${C.reset}`);
  }

  await sleep(300);
  showFile(CODEX_TASK.outputFile, 'Codex CLI', C.green);

  // 5. 验证产出
  console.log(`\n  ${C.gray}── 产出验证 ──${C.reset}\n`);

  let claudeOk = false;
  let codexOk = false;

  if (existsSync(CLAUDE_TASK.outputFile)) {
    const content = readFileSync(CLAUDE_TASK.outputFile, 'utf-8');
    claudeOk = content.includes('formatTimestamp') && content.includes('export');
    log(claudeOk ? '✅' : '⚠️', `Claude Code 产出${claudeOk ? `${C.green}验证通过${C.reset}` : `${C.yellow}格式异常${C.reset}`}：${C.gray}包含 formatTimestamp 导出${C.reset}`);
  } else {
    log('❌', `${C.red}Claude Code 未产出文件${C.reset}`);
  }

  if (existsSync(CODEX_TASK.outputFile)) {
    const content = readFileSync(CODEX_TASK.outputFile, 'utf-8');
    codexOk = content.includes('generateId') && content.includes('export');
    log(codexOk ? '✅' : '⚠️', `Codex 产出${codexOk ? `${C.green}验证通过${C.reset}` : `${C.yellow}格式异常${C.reset}`}：${C.gray}包含 generateId 导出${C.reset}`);
  } else {
    log('❌', `${C.red}Codex 未产出文件${C.reset}`);
  }

  // 6. 总结
  console.log('\n');
  banner('Level 1 Live Dispatch 验证总结');

  const bothOk = claudeOk && codexOk;
  if (bothOk) {
    console.log(`  ${C.green}${C.bold}✓ 调度链路验证通过${C.reset}\n`);
  } else {
    console.log(`  ${C.yellow}${C.bold}⚠ 部分验证通过${C.reset}\n`);
  }

  console.log(`  ${C.blue}Claude Code${C.reset} ${C.gray}${CLAUDE_TASK.version}${C.reset}`);
  console.log(`    任务：${CLAUDE_TASK.taskDesc}`);
  console.log(`    产出：${existsSync(CLAUDE_TASK.outputFile) ? `${C.green}scratch/claude-output.js${C.reset}` : `${C.red}无${C.reset}`}`);
  console.log(`    状态：${claudeOk ? `${C.green}✓ 通过${C.reset}` : `${C.red}✗ 未通过${C.reset}`}`);

  console.log(`\n  ${C.green}Codex CLI${C.reset} ${C.gray}${CODEX_TASK.version}${C.reset}`);
  console.log(`    任务：${CODEX_TASK.taskDesc}`);
  console.log(`    产出：${existsSync(CODEX_TASK.outputFile) ? `${C.green}scratch/codex-output.js${C.reset}` : `${C.red}无${C.reset}`}`);
  console.log(`    状态：${codexOk ? `${C.green}✓ 通过${C.reset}` : `${C.red}✗ 未通过${C.reset}`}`);

  console.log(`\n  ${C.bold}验证内容：${C.reset}${C.gray}MOSS 通过 exec_command 调用 CLI，Claude Code 和 Codex 各自${C.reset}`);
  console.log(`  ${C.gray}独立完成了一次性编码任务，产出了真实可读的代码文件。${C.reset}`);
  console.log(`  ${C.gray}这证明 Level 1 one-shot dispatch 调度链路是通的。${C.reset}`);
  console.log(`\n  ${C.gray}scratch/ 目录下的文件保留供检查，下次运行会自动清理。${C.reset}\n`);

  process.exit(bothOk ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  ${C.red}Demo 运行出错：${err.message}${C.reset}\n`);
  process.exit(1);
});
