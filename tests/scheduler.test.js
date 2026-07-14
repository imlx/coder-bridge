import { test } from 'node:test';
import assert from 'node:assert';
import { Scheduler } from '../src/scheduler.js';

// 事件驱动调度验证：token 不足时不再固定 100ms 轮询，
// 而是在 token 恢复时被 RateLimiter 的 'available' 事件及时唤醒。
// node:test 无内置 fake timers，沿用 unit.test.js 的短 refillRate 控制时间。

test('Scheduler - token 不足时等待，恢复后继续（非 100ms 轮询）', async () => {
  const s = new Scheduler({ capacity: 1, refillRate: 100 }); // 10ms/token
  s.addTask(async () => 'first');  // 消耗唯一 token
  s.addTask(async () => 'second'); // 必须等待 ~10ms 恢复

  const start = Date.now();
  const results = await s.run();
  const elapsed = Date.now() - start;

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[1].result, 'second');
  // 事件驱动约 10ms 唤醒；旧版 100ms 轮询会 >= 100ms
  assert.ok(elapsed >= 5, `应实际等待 token 恢复，elapsed=${elapsed}`);
  assert.ok(elapsed < 80, `应被事件及时唤醒而非 100ms 轮询，elapsed=${elapsed}`);
  assert.strictEqual(s.limiter._notifyTimer, null, '不应遗留定时器');
});

test('Scheduler - 跨等待的顺序处理，run 返回 results 数组', async () => {
  const s = new Scheduler({ capacity: 1, refillRate: 1000 }); // 1ms/token
  const order = [];
  s.addTask(async () => { order.push('a'); return 'a'; });
  s.addTask(async () => { order.push('b'); return 'b'; });
  s.addTask(async () => { order.push('c'); return 'c'; });
  s.addTask(async () => { order.push('d'); return 'd'; });

  const results = await s.run();

  assert.strictEqual(results.length, 4);
  assert.deepStrictEqual(results.map((r) => r.result), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd'], '应严格按入队顺序执行');
  assert.ok(results.every((r) => r.status === 'ok'));
});

test('Scheduler - stop() 及时中断等待 token 的循环', async () => {
  const s = new Scheduler({ capacity: 1, refillRate: 0.01 }); // 100s/token，确保长等待
  s.addTask(async () => 'done');   // 立即完成
  s.addTask(async () => 'never');  // 会卡在 token 等待

  const runP = s.run();
  await new Promise((r) => setTimeout(r, 50)); // 等首个任务完成、第二个进入等待

  const stopStart = Date.now();
  s.stop();
  await runP;
  const stopLatency = Date.now() - stopStart;

  assert.ok(stopLatency < 30, `stop 应及时中断而非等满 100ms，latency=${stopLatency}`);
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.getStats().completed, 1);
  assert.strictEqual(s.getStats().pending, 1, '未处理任务应留在队列');
  assert.strictEqual(s.limiter._notifyTimer, null, '应清理未触发的唤醒定时器');
});

test('Scheduler - addTask 后 run() 处理全部任务', async () => {
  const s = new Scheduler({ capacity: 2, refillRate: 50 });
  for (let i = 0; i < 5; i++) {
    s.addTask(async () => i);
  }
  const results = await s.run();

  assert.strictEqual(results.length, 5);
  assert.deepStrictEqual(results.map((r) => r.result), [0, 1, 2, 3, 4]);
  assert.strictEqual(s.getStats().completed, 5);
  assert.strictEqual(s.getStats().pending, 0);
  assert.strictEqual(s.limiter._notifyTimer, null);
});

test('Scheduler - 空队列 run() 立即返回空数组', async () => {
  const s = new Scheduler({ capacity: 1, refillRate: 1 });
  const results = await s.run();

  assert.strictEqual(results.length, 0);
  assert.strictEqual(s.running, false);
});

test('Scheduler - task 抛错被捕获，不中断后续调度', async () => {
  const s = new Scheduler({ capacity: 3, refillRate: 10 });
  s.addTask(async () => { throw new Error('boom'); });
  s.addTask(async () => 'ok');

  const results = await s.run();

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].status, 'error');
  assert.strictEqual(results[0].error, 'boom');
  assert.strictEqual(results[1].status, 'ok');
  assert.strictEqual(results[1].result, 'ok');
});
