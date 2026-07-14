import { EventEmitter } from 'events';

/**
 * TokenBucket Rate Limiter
 *
 * 工作件代码 - 保留改进空间：
 * - 无持久化（重启后 token 清零）
 * - 无多桶支持
 * - refill 精度依赖 Date.now()，高频场景可能漂移
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class RateLimiter extends EventEmitter {
  constructor({ capacity = 10, refillRate = 1, burstCapacity = 0, burstRefillRate } = {}) {
    super();
    if (capacity <= 0) throw new Error('capacity must be positive');
    if (refillRate <= 0) throw new Error('refillRate must be positive');
    if (burstCapacity < 0) throw new Error('burstCapacity must be non-negative');

    this.capacity = capacity;
    this.refillRate = refillRate; // tokens per second
    this.tokens = capacity;
    this.burstCapacity = burstCapacity;
    this.burstTokens = burstCapacity;
    if (burstCapacity > 0) {
      this.burstRefillRate = burstRefillRate ?? refillRate;
      if (this.burstRefillRate <= 0) throw new Error('burstRefillRate must be positive');
    } else {
      this.burstRefillRate = 0;
    }
    this.lastRefill = Date.now();
    this._notifyTimer = null;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.burstTokens = Math.min(this.burstCapacity, this.burstTokens + elapsed * this.burstRefillRate);
    this.lastRefill = now;
  }

  _deduct(count) {
    const fromMain = Math.min(this.tokens, count);
    this.tokens -= fromMain;
    this.burstTokens -= count - fromMain;
  }

  tryConsume(count = 1) {
    this._refill();
    if (this.tokens + this.burstTokens >= count) {
      this._deduct(count);
      return true;
    }
    this._scheduleNotify(count);
    return false;
  }

  // 精确计算 token 恢复时刻并一次性唤醒，取代上层固定间隔轮询
  _scheduleNotify(count) {
    if (this._notifyTimer) return;
    const needed = count - (this.tokens + this.burstTokens);
    const totalRate = this.refillRate + this.burstRefillRate;
    const waitMs = Math.max(1, Math.ceil((needed / totalRate) * 1000));
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = null;
      this._refill();
      this.emit('available', this.tokens + this.burstTokens);
    }, waitMs);
  }

  cancelNotify() {
    if (this._notifyTimer) {
      clearTimeout(this._notifyTimer);
      this._notifyTimer = null;
    }
  }

  getAvailable() {
    this._refill();
    return Math.floor(this.tokens);
  }

  getAvailableBurst() {
    this._refill();
    return Math.floor(this.burstTokens);
  }

  async waitForTokens(count = 1, timeout = 30000) {
    const maxCapacity = this.capacity + this.burstCapacity;
    if (count > maxCapacity) {
      throw new Error(`count (${count}) exceeds capacity (${maxCapacity})`);
    }
    if (count <= 0) {
      throw new Error('count must be positive');
    }
    if (timeout < 0) {
      throw new Error('timeout must be non-negative');
    }

    const startTime = Date.now();

    // 快速路径：已有足够 token
    this._refill();
    if (this.tokens + this.burstTokens >= count) {
      this._deduct(count);
      return;
    }

    return new Promise((resolve, reject) => {
      let timeoutId;
      let checkIntervalId;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (checkIntervalId) clearInterval(checkIntervalId);
      };

      // 超时处理
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`waitForTokens timed out after ${timeout}ms`));
      }, timeout);

      // 定期检查 token
      const check = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          return; // let timeout handle it
        }

        this._refill();
        if (this.tokens + this.burstTokens >= count) {
          this._deduct(count);
          cleanup();
          resolve();
        }
      };

      // 计算需要等待的时间，使用更精确的检查间隔
      const needed = count - (this.tokens + this.burstTokens);
      const totalRate = this.refillRate + this.burstRefillRate;
      const waitMs = Math.max(10, Math.ceil((needed / totalRate) * 1000));
      checkIntervalId = setInterval(check, Math.min(waitMs / 2, 50));

      // 立即检查一次
      check();
    });
  }

  // TODO: toJSON() / fromJSON() - 持久化支持
  // TODO: getStats() - 返回拒绝次数、使用峰值等指标
}
