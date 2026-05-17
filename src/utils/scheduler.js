import cron from 'node-cron';

let job = null;

// runFn must handle its own concurrency guard before doing any work.
export function start(runFn) {
  if (job) return;
  job = cron.schedule('*/15 * * * *', () => {
    runFn().catch(() => {}); // errors are silently dropped — cron must not crash
  });
}

export function stop() {
  if (!job) return;
  job.stop();
  job = null;
}

export function isActive() {
  return job !== null;
}
