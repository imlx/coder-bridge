import { RateLimiter, TimeoutError } from './rateLimiter.js';
import { TaskQueue } from './taskQueue.js';
import { Scheduler } from './scheduler.js';

export { RateLimiter, TimeoutError, TaskQueue, Scheduler };

// Demo - 快速验证基本功能
const scheduler = new Scheduler({ capacity: 3, refillRate: 1 });

for (let i = 1; i <= 5; i++) {
  scheduler.addTask(async () => {
    console.log(`Task ${i} done at ${new Date().toISOString()}`);
    return i;
  });
}

console.log('Starting scheduler demo...');
const results = await scheduler.run();
console.log('Results:', results);
console.log('Stats:', scheduler.getStats());
