import { test } from 'node:test';
import assert from 'node:assert';
import { RateLimiter, TimeoutError } from '../src/rateLimiter.js';
import { TaskQueue } from '../src/taskQueue.js';
import { Scheduler } from '../src/scheduler.js';

test('RateLimiter - 初始 token 等于 capacity', () => {
  const rl = new RateLimiter({ capacity: 10, refillRate: 1 });
  assert.strictEqual(rl.getAvailable(), 10);
});

test('RateLimiter - 消耗后 token 减少', () => {
  const rl = new RateLimiter({ capacity: 10, refillRate: 1 });
  rl.tryConsume(3);
  assert.strictEqual(rl.getAvailable(), 7);
});

test('RateLimiter - token 不足时拒绝', () => {
  const rl = new RateLimiter({ capacity: 2, refillRate: 1 });
  assert.ok(rl.tryConsume(2));
  assert.ok(!rl.tryConsume(1));
});

test('RateLimiter - token 随时间恢复', async () => {
  const rl = new RateLimiter({ capacity: 1, refillRate: 10 });
  rl.tryConsume(1);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(rl.tryConsume(1));
});

test('TaskQueue - 入队和出队', async () => {
  const q = new TaskQueue();
  q.enqueue(async () => 42);
  const result = await q.processOne();
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.result, 42);
});

test('TaskQueue - 错误处理', async () => {
  const q = new TaskQueue();
  q.enqueue(async () => { throw new Error('boom'); });
  const result = await q.processOne();
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.error, 'boom');
});

test('Scheduler - 速率限制下处理所有任务', async () => {
  const s = new Scheduler({ capacity: 2, refillRate: 5 });
  s.addTask(async () => 'a');
  s.addTask(async () => 'b');
  s.addTask(async () => 'c');
  const results = await s.run();
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].result, 'a');
});

// 故意留的失败测试 - 给 coding agent 修：
test('RateLimiter - 并发安全', async () => {
  const rl = new RateLimiter({ capacity: 100, refillRate: 1 });
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(Promise.resolve(rl.tryConsume(1)));
  }
  const results = await Promise.all(promises);
  const consumed = results.filter(Boolean).length;
  // 当前实现不是并发安全的，这里会失败
  assert.strictEqual(consumed, 100);
});

test('RateLimiter - waitForTokens 快速路径', async () => {
  const rl = new RateLimiter({ capacity: 10, refillRate: 1 });
  const start = Date.now();
  await rl.waitForTokens(5);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10, 'should resolve immediately');
  assert.strictEqual(rl.getAvailable(), 5);
});

test('RateLimiter - waitForTokens 等待恢复', async () => {
  const rl = new RateLimiter({ capacity: 5, refillRate: 100 });
  rl.tryConsume(5); // 耗尽
  const start = Date.now();
  await rl.waitForTokens(3);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 20, 'should wait for refill');
  assert.ok(elapsed < 100, 'should not wait too long');
});

test('RateLimiter - waitForTokens 超时', async () => {
  const rl = new RateLimiter({ capacity: 5, refillRate: 1 });
  rl.tryConsume(5); // 耗尽
  const start = Date.now();
  await assert.rejects(
    rl.waitForTokens(3, 50),
    (err) => err.name === 'TimeoutError'
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 40, 'should wait until timeout');
});

test('RateLimiter - waitForTokens count 超过 capacity 抛错', async () => {
  const rl = new RateLimiter({ capacity: 5, refillRate: 1 });
  await assert.rejects(
    rl.waitForTokens(10),
    /exceeds capacity/
  );
});

test('RateLimiter - TimeoutError 可识别', () => {
  const err = new TimeoutError('test');
  assert.strictEqual(err.name, 'TimeoutError');
  assert.ok(err instanceof Error);
});
