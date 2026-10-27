const LRU_MAX = Number(process.env.CACHE_LRU_MAX || 1000);

const localCache = new Map();
let redisClient = null;
let redisReady = false;

const getRedisClient = async () => {
  if (redisClient || !process.env.REDIS_URL) return redisClient;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', () => {
      redisReady = false;
    });
    await redisClient.connect();
    redisReady = true;
  } catch (_) {
    redisClient = null;
    redisReady = false;
  }
  return redisClient;
};

const pruneLocalCache = () => {
  if (localCache.size <= LRU_MAX) return;
  const oldestKey = localCache.keys().next().value;
  if (oldestKey) localCache.delete(oldestKey);
};

const setLocal = (key, value, ttlSeconds) => {
  localCache.set(key, {
    value,
    expiresAt: Date.now() + (ttlSeconds * 1000)
  });
  pruneLocalCache();
};

const getLocal = (key) => {
  const entry = localCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    localCache.delete(key);
    return null;
  }
  return entry.value;
};

const get = async (key) => {
  try {
    const client = await getRedisClient();
    if (client && redisReady) {
      const raw = await client.get(key);
      if (raw) return JSON.parse(raw);
    }
  } catch (_) {
    redisReady = false;
  }
  return getLocal(key);
};

const set = async (key, value, ttlSeconds) => {
  try {
    const client = await getRedisClient();
    if (client && redisReady) {
      await client.setEx(key, ttlSeconds, JSON.stringify(value));
    }
  } catch (_) {
    redisReady = false;
  }
  setLocal(key, value, ttlSeconds);
};

const del = async (key) => {
  localCache.delete(key);
  try {
    const client = await getRedisClient();
    if (client && redisReady) await client.del(key);
  } catch (_) {
    redisReady = false;
  }
};

const invalidatePrefix = async (prefix) => {
  const keys = Array.from(localCache.keys());
  keys.forEach((key) => {
    if (key.startsWith(prefix)) localCache.delete(key);
  });

  try {
    const client = await getRedisClient();
    if (!client || !redisReady) return;
    let cursor = '0';
    do {
      const result = await client.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
      cursor = result.cursor;
      if (result.keys.length > 0) await client.del(result.keys);
    } while (cursor !== '0');
  } catch (_) {
    redisReady = false;
  }
};

module.exports = {
  get,
  set,
  del,
  invalidatePrefix
};
