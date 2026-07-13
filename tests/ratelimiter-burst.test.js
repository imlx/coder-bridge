import { test } from 'node:test';
import assert from 'node:assert';
import { RateLimiter } from '../src/rateLimiter.js';

// ─── 向后兼容 ───

test('向后兼容 - 不传 burst 配置时 getAvailableBurst 返回 0', () => {
  const rl = new RateLimiter({ capacity: 5, refillRate: 1 });
  assert.strictEqual(rl.getAvailableBurst(), 0);
});

test('向后兼容 - 不传 burst 配置时 tryConsume 行为不变', () => {
  const rl = new RateLimiter({ capacity: 5, refillRate: 1 });
  assert.ok(rl.tryConsume(5));
  assert.ok(!rl.tryConsume(1));
  assert.strictEqual(rl.getAvailable(), 0);
});

test('向后兼容 - waitForTokens capacity 上限不含 burst', async () => {
  const rl = new RateLimiter({ capacity: 5, refillRate: 1 });
  await assert.rejects(rl.waitForTokens(6), /exceeds capacity/);
});

// ─── burst 借用 ───

test('burst 借用 - 先耗尽 main 再借 burst', () => {
  const rl = new RateLimiter({ capacity: 3, refillRate: 1, burstCapacity: 3, burstRefillRate: 1 });
  assert.ok(rl.tryConsume(2));
  assert.strictEqual(rl.getAvailable(), 1);
  assert.strictEqual(rl.getAvailableBurst(), 3);

  assert.ok(rl.tryConsume(2));
  assert.strictEqual(rl.getAvailable(), 0);
  assert.strictEqual(rl.getAvailableBurst(), 2);
});

test('burst 借用 - 一次性跨越 main 和 burst', () => {
  const rl = new RateLimiter({ capacity: 2, refillRate: 1, burstCapacity: 3, burstRefillRate: 1 });
  assert.ok(rl.tryConsume(5));
  assert.strictEqual(rl.getAvailable(), 0);
  assert.strictEqual(rl.getAvailableBurst(), 0);
});

test('burst 耗尽后降级拒绝', () => {
  const rl = new RateLimiter({ capacity: 2, refillRate: 1, burstCapacity: 3, burstRefillRate: 1 });
  assert.ok(rl.tryConsume(5));
  assert.ok(!rl.tryConsume(1));
  assert.strictEqual(rl.getAvailable(), 0);
  assert.strictEqual(rl.getAvailableBurst(), 0);
});

// ─── burst 恢复 ───

test('burst token 随时间恢复', async () => {
  const rl = new RateLimiter({ capacity: 1, refillRate: 100, burstCapacity: 1, burstRefillRate: 100 });
  rl.tryConsume(2);
  assert.strictEqual(rl.getAvailableBurst(), 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(rl.getAvailableBurst(), 1);
});

test('burst 配置 - burstRefillRate 默认等于 refillRate', async () => {
  const rl = new RateLimiter({ capacity: 1, refillRate: 50, burstCapacity: 1 });
  rl.tryConsume(2);
  assert.strictEqual(rl.getAvailableBurst(), 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(rl.getAvailableBurst() >= 1);
});

test('burst 配置 - burstRefillRate 可独立设置（慢于主桶）', async () => {
  const rl = new RateLimiter({ capacity: 1, refillRate: 1000, burstCapacity: 1, burstRefillRate: 10 });
  rl.tryConsume(2);
  assert.strictEqual(rl.getAvailableBurst(), 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(rl.getAvailableBurst(), 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(rl.getAvailableBurst(), 1);
});

// ─── waitForTokens + burst ───

test('burst - waitForTokens 可借用 burst 立即通过', async () => {
  const rl = new RateLimiter({ capacity: 2, refillRate: 1, burstCapacity: 3, burstRefillRate: 1 });
  const start = Date.now();
  await rl.waitForTokens(5);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10, 'should resolve immediately');
  assert.strictEqual(rl.getAvailable(), 0);
  assert.strictEqual(rl.getAvailableBurst(), 0);
});

test('burst - waitForTokens count 超过 capacity+burstCapacity 抛错', async () => {
  const rl = new RateLimiter({ capacity: 2, refillRate: 1, burstCapacity: 3, burstRefillRate: 1 });
  await assert.rejects(rl.waitForTokens(6), /exceeds capacity/);
});

// ─── 参数校验 ───

test('校验 - burstCapacity 为负数抛错', () => {
  assert.throws(
    () => new RateLimiter({ capacity: 1, refillRate: 1, burstCapacity: -1 }),
    /non-negative/
  );
});

test('校验 - burstRefillRate 非正数抛错', () => {
  assert.throws(
    () => new RateLimiter({ capacity: 1, refillRate: 1, burstCapacity: 1, burstRefillRate: 0 }),
    /positive/
  );
});

// ─── 并发安全 ───

test('并发安全 - 无 burst 时 tryConsume 不超卖', async () => {
  const rl = new RateLimiter({ capacity: 10, refillRate: 1 });
  const tasks = [];
  for (let i = 0; i < 30; i++) {
    tasks.push(new Promise((resolve) => setImmediate(() => resolve(rl.tryConsume(1)))));
  }
  const results = await Promise.all(tasks);
  const consumed = results.filter(Boolean).length;
  assert.strictEqual(consumed, 10);
});

test('并发安全 - burst 启用时不超卖', async () => {
  const rl = new RateLimiter({ capacity: 5, refillRate: 1, burstCapacity: 5, burstRefillRate: 1 });
  const tasks = [];
  for (let i = 0; i < 30; i++) {
    tasks.push(new Promise((resolve) => setImmediate(() => resolve(rl.tryConsume(1)))));
  }
  const results = await Promise.all(tasks);
  const consumed = results.filter(Boolean).length;
  assert.strictEqual(consumed, 10);
});

test('并发安全 - waitForTokens 与 tryConsume 混合不超卖', async () => {
  const rl = new RateLimiter({ capacity: 3, refillRate: 1000, burstCapacity: 0 });
  rl.tryConsume(3);

  const waiters = [
    rl.waitForTokens(1, 200),
    rl.waitForTokens(1, 200),
    rl.waitForTokens(1, 200),
  ];

  const syncTasks = [
    new Promise((r) => setTimeout(() => r(rl.tryConsume(1)), 5)),
    new Promise((r) => setTimeout(() => r(rl.tryConsume(1)), 10)),
  ];

  const waiterResults = await Promise.all(waiters);
  const syncResults = await Promise.all(syncTasks);

  const totalConsumed = waiterResults.filter(Boolean).length + syncResults.filter(Boolean).length;
  assert.ok(totalConsumed <= 5, `consumed ${totalConsumed}, should not exceed 5 (3 capacity + ~2 refilled)`);
  assert.ok(rl.tokens >= 0, 'tokens must never go negative');
});
