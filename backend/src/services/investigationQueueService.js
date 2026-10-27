const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.INVESTIGATION_QUEUE_CONCURRENCY || 2));
const MAX_QUEUE_SIZE = Math.max(50, Number(process.env.INVESTIGATION_QUEUE_MAX || 500));

const queue = [];
let activeWorkers = 0;
const stats = {
  queued: 0,
  completed: 0,
  failed: 0,
  dropped: 0
};

const getConcurrency = () => Math.max(1, Number(process.env.INVESTIGATION_QUEUE_CONCURRENCY || DEFAULT_CONCURRENCY));

const runWorker = async () => {
  if (queue.length === 0) return;
  const item = queue.shift();
  if (!item) return;

  activeWorkers += 1;
  try {
    const result = await item.job();
    stats.completed += 1;
    item.resolve(result);
  } catch (error) {
    stats.failed += 1;
    item.reject(error);
  } finally {
    activeWorkers -= 1;
    setImmediate(pumpQueue);
  }
};

const pumpQueue = () => {
  const target = getConcurrency();
  while (activeWorkers < target && queue.length > 0) {
    runWorker();
  }
};

const enqueueInvestigation = (job, options = {}) => {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.INVESTIGATION_QUEUE_JOB_TIMEOUT_MS || 55000));

  return new Promise((resolve, reject) => {
    if (typeof job !== 'function') {
      reject(new Error('Investigation queue job must be a function'));
      return;
    }

    if (queue.length >= MAX_QUEUE_SIZE) {
      stats.dropped += 1;
      reject(new Error(`Investigation queue is full (${MAX_QUEUE_SIZE})`));
      return;
    }

    stats.queued += 1;

    const wrappedResolve = (value) => {
      clearTimeout(timer);
      resolve(value);
    };

    const wrappedReject = (error) => {
      clearTimeout(timer);
      reject(error);
    };

    const label = String(options.label || 'investigation').trim();
    const timer = setTimeout(() => {
      wrappedReject(new Error(`Investigation queue timeout for ${label} after ${timeoutMs}ms`));
    }, timeoutMs);

    queue.push({
      job,
      resolve: wrappedResolve,
      reject: wrappedReject,
      label,
      queuedAt: Date.now()
    });

    pumpQueue();
  });
};

const getInvestigationQueueStats = () => ({
  ...stats,
  pending: queue.length,
  activeWorkers,
  concurrency: getConcurrency()
});

module.exports = {
  enqueueInvestigation,
  getInvestigationQueueStats
};
