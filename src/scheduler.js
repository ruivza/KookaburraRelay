// The gateway's periodic jobs on one timer. A job never overlaps itself and runs again one interval after it last
// started; a failure is counted for that job and handed to its onError, and the job keeps its schedule. close()
// stops scheduling and waits for jobs that are running.
export class Scheduler {
  constructor() {
    this.jobs = [];
  }
  every(name, interval, run, { onError } = {}) {
    this.jobs.push({ name, interval, run, onError, next: 0, running: null, failures: 0, lastSuccess: null });
    return this;
  }
  start(resolution = 1000) {
    if (this.timer || this.stopping) return;
    const time = performance.now();
    for (const job of this.jobs) job.next = time + job.interval;
    this.timer = setInterval(() => this.tick(), resolution).unref();
  }
  tick() {
    const time = performance.now();
    for (const job of this.jobs) if (!job.running && !this.stopping && time >= job.next) void this.run(job);
  }
  run(job) {
    job.next = performance.now() + job.interval;
    const running = (async () => {
      try {
        await job.run();
        job.lastSuccess = Date.now();
      } catch (error) {
        job.failures++;
        job.onError?.(error);
      }
    })();
    // Cleared after the assignment even when the job finished synchronously.
    job.running = running;
    void running.then(() => (job.running = null));
    return running;
  }
  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.jobs.map(job => job.running));
  }
  status() {
    return this.jobs.map(({ name, failures, lastSuccess, running }) => ({
      name,
      failures,
      lastSuccess,
      running: !!running,
    }));
  }
}
