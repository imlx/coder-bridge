import { RateLimiter } from './rateLimiter.js';
import { TaskQueue } from './taskQueue.js';

/**
 * Scheduler - 结合 RateLimiter 和 TaskQueue
 * 
 * 在速率限制下处理任务队列：每次处理前先消耗 token，
 * token 不足时等待下一个 refill 周期。
 * 
 * 改进空间：
 * - 无退避策略（token 不足时 busy-wait）
 * - 无优雅关闭
 * - 无 metrics 上报
 */
export class Scheduler {
  constructor({ capacity = 5, refillRate = 2 } = {}) {
    this.limiter = new RateLimiter({ capacity, refillRate });
    this.queue = new TaskQueue();
    this.running = false;
  }

  addTask(task) {
    return this.queue.enqueue(task);
  }

  async run() {
    this.running = true;
    const results = [];

    while (this.running && this.queue.size() > 0) {
      if (this.limiter.tryConsume(1)) {
        const result = await this.queue.processOne();
        results.push(result);
      } else {
        // 等待 token 恢复 - 当前是 busy-wait，应该改成 event-driven
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    this.running = false;
    return results;
  }

  stop() {
    this.running = false;
  }

  getStats() {
    return {
      ...this.queue.getStats(),
      availableTokens: this.limiter.getAvailable(),
    };
  }

  getMetrics() {
    return {
      running: this.running,
      queueSize: this.queue.size(),
      availableTokens: this.limiter.getAvailable(),
      capacity: this.limiter.capacity,
    };
  }
}
