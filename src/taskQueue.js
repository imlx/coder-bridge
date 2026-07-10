/**
 * Async Task Queue
 * 
 * 工作件代码 - 故意保留改进空间：
 * - 无优先级
 * - 无任务取消
 * - 无错误重试
 * - 无并发控制（processOne 串行执行）
 */
export class TaskQueue {
  constructor() {
    this.queue = [];
    this.completed = 0;
    this.failed = 0;
  }

  enqueue(task) {
    if (typeof task !== 'function') throw new Error('task must be a function');
    this.queue.push(task);
    return this.queue.length;
  }

  size() {
    return this.queue.length;
  }

  async processOne() {
    if (this.queue.length === 0) return null;

    const task = this.queue.shift();
    try {
      const result = await task();
      this.completed++;
      return { status: 'ok', result };
    } catch (err) {
      this.failed++;
      return { status: 'error', error: err.message };
    }
  }

  async processAll() {
    const results = [];
    while (this.queue.length > 0) {
      results.push(await this.processOne());
    }
    return results;
  }

  getStats() {
    return {
      pending: this.queue.length,
      completed: this.completed,
      failed: this.failed,
    };
  }

  // TODO: enqueuePriority(task) - 高优先级插队
  // TODO: cancel(index) - 取消队列中的任务
  // TODO: retry failed - 重试失败任务
}
