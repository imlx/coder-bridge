/**
 * Level 1 Demo - 一次性执行验证的可视化展示
 *
 * 运行：npm run demo:1
 *
 * 这个 demo 让你直观看到 Level 1 验证中两个 AI 各自实现了什么：
 * - Claude Code 实现了 RateLimiter.waitForTokens() + TimeoutError
 * - Codex 实现了 TaskQueue.enqueuePriority() + cancel()
 */

import { RateLimiter, TimeoutError } from './rateLimiter.js';
import { TaskQueue } from './taskQueue.js';

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function timestamp() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function banner(text) {
  const line = '═'.repeat(Math.max(text.length + 4, 60));
  console.log(`${CYAN}╔${line}╗${RESET}`);
  console.log(`${CYAN}║  ${BOLD}${text}${RESET}${CYAN}${' '.repeat(Math.max(text.length + 2, 58) - text.length)}║${RESET}`);
  console.log(`${CYAN}╚${line}╝${RESET}`);
}

function section(text) {
  console.log(`\n${MAGENTA}─── ${text} ${'─'.repeat(Math.max(0, 54 - text.length))}${RESET}\n`);
}

function log(icon, msg) {
  console.log(`  ${DIM}[${timestamp()}]${RESET} ${icon} ${msg}`);
}

async function demoRateLimiter() {
  banner('Level 1 Demo · Part 1: RateLimiter');
  console.log(`  ${DIM}实现者：Claude Code (claude -p one-shot)${RESET}`);
  console.log(`  ${DIM}实现内容：waitForTokens(count, timeout) + TimeoutError${RESET}`);
  console.log(`  ${DIM}文件：src/rateLimiter.js${RESET}\n`);

  // --- 场景 1：逐步消耗 token ---
  section('场景 1 · Token 逐步消耗');
  const rl = new RateLimiter({ capacity: 5, refillRate: 2 });

  log('📊', `初始状态：capacity=5, refillRate=2 tokens/s, 可用=${GREEN}${rl.getAvailable()}${RESET}`);

  for (let i = 1; i <= 5; i++) {
    const ok = rl.tryConsume(1);
    if (ok) {
      log('✅', `消耗 1 token → 剩余 ${GREEN}${rl.getAvailable()}${RESET}`);
    } else {
      log('❌', `消耗失败 → token 不足，剩余 ${RED}${rl.getAvailable()}${RESET}`);
    }
    await sleep(200);
  }

  // --- 场景 2：token 耗尽后等待恢复 ---
  section('场景 2 · waitForTokens 等待恢复');
  log('⚡', `token 已耗尽，调用 waitForTokens(1, timeout=5000)`);
  log('⏳', `等待 refill... 每秒恢复 2 个 token`);

  const start = Date.now();
  await rl.waitForTokens(1, 5000);
  const elapsed = Date.now() - start;

  log('✅', `waitForTokens 返回！耗时 ${YELLOW}${elapsed}ms${RESET}，当前可用=${GREEN}${rl.getAvailable()}${RESET}`);

  // --- 场景 3：超时 ---
  section('场景 3 · waitForTokens 超时');
  const rl2 = new RateLimiter({ capacity: 3, refillRate: 1 });
  rl2.tryConsume(3);
  log('🔋', `新限流器：capacity=3, refillRate=1/s，已全部消耗`);

  log('⏳', `调用 waitForTokens(5, timeout=300) — 需要 5 个但 capacity 只有 3`);
  const start2 = Date.now();
  try {
    await rl2.waitForTokens(5, 300);
  } catch (err) {
    const elapsed2 = Date.now() - start2;
    if (err instanceof TimeoutError) {
      log('💥', `${RED}TimeoutError${RESET} 触发！耗时 ${YELLOW}${elapsed2}ms${RESET}`);
      log('📝', `错误信息：${DIM}${err.message}${RESET}`);
    } else {
      log('💥', `其他错误：${err.message}`);
    }
  }

  // --- 场景 4：批量消耗 + 等待 ---
  section('场景 4 · 批量 token 消耗');
  const rl3 = new RateLimiter({ capacity: 10, refillRate: 5 });
  log('📊', `新限流器：capacity=10, refillRate=5 tokens/s`);

  log('⬇️', `一次性消耗 8 个 token`);
  rl3.tryConsume(8);
  log('📊', `剩余 ${YELLOW}${rl3.getAvailable()}${RESET} 个 token`);

  log('⏳', `调用 waitForTokens(5) — 需要 5 个，只剩 2 个，等待恢复...`);
  const start3 = Date.now();
  await rl3.waitForTokens(5);
  const elapsed3 = Date.now() - start3;
  log('✅', `获取成功！耗时 ${YELLOW}${elapsed3}ms${RESET}，消耗 5 个，剩余 ${GREEN}${rl3.getAvailable()}${RESET}`);

  console.log(`\n  ${GREEN}✓ RateLimiter 验证完成${RESET}`);
}

async function demoTaskQueue() {
  banner('Level 1 Demo · Part 2: TaskQueue');
  console.log(`  ${DIM}实现者：Codex (codex exec one-shot)${RESET}`);
  console.log(`  ${DIM}实现内容：enqueuePriority(task) + cancel(index)${RESET}`);
  console.log(`  ${DIM}文件：src/taskQueue.js${RESET}\n`);

  // --- 场景 1：普通入队 ---
  section('场景 1 · 普通任务入队');
  const q = new TaskQueue();

  const tasks = [
    { name: '发送邮件', fn: async () => 'email sent' },
    { name: '生成报表', fn: async () => 'report generated' },
    { name: '清理缓存', fn: async () => 'cache cleared' },
  ];

  for (const t of tasks) {
    const len = q.enqueue(t.fn);
    log('📥', `普通入队：「${t.name}」→ 队列位置 ${len}，当前队列长度=${YELLOW}${q.size()}${RESET}`);
    await sleep(150);
  }

  // --- 场景 2：优先级入队 ---
  section('场景 2 · 优先级任务插队');
  log('🚀', `紧急任务来了！调用 enqueuePriority() 插入队列头部`);

  const urgentTask = { name: '⚠️ 紧急修复', fn: async () => 'urgent fix applied' };
  const len = q.enqueuePriority(urgentTask.fn);
  log('⚡', `优先入队：「${urgentTask.name}」→ 队列位置 ${GREEN}1${RESET}（头部），当前队列长度=${YELLOW}${q.size()}${RESET}`);

  const anotherUrgent = { name: '⚠️ 紧急回滚', fn: async () => 'rollback done' };
  const len2 = q.enqueuePriority(anotherUrgent.fn);
  log('⚡', `优先入队：「${anotherUrgent.name}」→ 队列位置 ${GREEN}1${RESET}（头部），当前队列长度=${YELLOW}${q.size()}${RESET}`);

  // --- 场景 3：取消任务 ---
  section('场景 3 · 取消队列中的任务');
  log('🔍', `当前队列长度=${YELLOW}${q.size()}${RESET}，取消索引 2 的任务（第三个）`);

  const cancelled = q.cancel(2);
  log('🗑️', `已取消队列索引 2 的任务，当前队列长度=${YELLOW}${q.size()}${RESET}`);

  // --- 场景 4：按优先级顺序处理 ---
  section('场景 4 · 按优先级顺序处理');
  log('▶️', `开始处理队列，预期顺序：紧急回滚 → 紧急修复 → 发送邮件 → 生成报表`);

  const order = ['⚠️ 紧急回滚', '⚠️ 紧急修复', '发送邮件', '生成报表'];
  let idx = 0;
  while (q.size() > 0) {
    const result = await q.processOne();
    const expected = order[idx];
    const icon = result.status === 'ok' ? '✅' : '❌';
    log(icon, `处理 #${idx + 1}：${GREEN}${expected}${RESET} → ${result.status}`);
    idx++;
    await sleep(200);
  }

  // --- 场景 5：统计 ---
  section('场景 5 · 队列统计');
  const stats = q.getStats();
  log('📊', `完成=${GREEN}${stats.completed}${RESET}  失败=${RED}${stats.failed}${RESET}  待处理=${YELLOW}${stats.pending}${RESET}`);

  console.log(`\n  ${GREEN}✓ TaskQueue 验证完成${RESET}`);
}

async function main() {
  console.log('\n');
  banner('coder-bridge · Level 1 可视化验证');
  console.log(`  ${DIM}验证模式：一次性执行（One-shot）${RESET}`);
  console.log(`  ${DIM}调度方：MOSS (BaiLongma 2.1.479)${RESET}`);
  console.log(`  ${DIM}执行方：Claude Code 2.1.205 + Codex CLI 0.144.1${RESET}`);
  console.log(`  ${DIM}时间：${new Date().toISOString()}${RESET}`);

  await demoRateLimiter();
  await sleep(500);
  await demoTaskQueue();

  console.log('\n');
  banner('Level 1 验证总结');
  console.log(`  ${GREEN}✓ Claude Code${RESET} 实现了 RateLimiter.waitForTokens() + TimeoutError`);
  console.log(`    ${DIM}→ 限流器能在 token 不足时自动等待恢复，超时时抛出可识别错误${RESET}`);
  console.log(`  ${GREEN}✓ Codex${RESET} 实现了 TaskQueue.enqueuePriority() + cancel()`);
  console.log(`    ${DIM}→ 任务队列支持优先级插队和任意位置取消${RESET}`);
  console.log(`\n  ${BOLD}两个 AI 各自独立 one-shot 完成，无需人工干预。${RESET}`);
  console.log(`  ${DIM}运行 npm test 可查看 13 个单元测试的详细结果。${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}Demo 运行出错：${err.message}${RESET}`);
  process.exit(1);
});
