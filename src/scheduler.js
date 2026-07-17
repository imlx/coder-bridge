import { EventEmitter } from 'events';
import { RateLimiter } from './rateLimiter.js';
import { TaskQueue } from './taskQueue.js';

/**
 * Scheduler - 结合 RateLimiter 和 TaskQueue
 *
 * 在速率限制下处理任务队列：每次处理前先消耗 token，
 * token 不足时等待 RateLimiter 的 'available' 事件唤醒（非轮询）。
 */
export class Scheduler extends EventEmitter {
  constructor({ capacity = 5, refillRate = 2 } = {}) {
    super();
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

    try {
      while (this.running && this.queue.size() > 0) {
        if (this.limiter.tryConsume(1)) {
          const result = await this.queue.processOne();
          results.push(result);
        } else {
          await this._waitForToken();
        }
      }
    } finally {
      this.running = false;
      this.limiter.cancelNotify();
    }
    return results;
  }

  // 等待 limiter 的 'available' 事件；stop() 触发 'stop' 时立即解除等待
  _waitForToken() {
    return new Promise((resolve) => {
      if (!this.running) return resolve();
      const done = () => {
        this.limiter.removeListener('available', done);
        this.removeListener('stop', done);
        resolve();
      };
      this.limiter.once('available', done);
      this.once('stop', done);
    });
  }

  stop() {
    this.running = false;
    this.emit('stop');
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
