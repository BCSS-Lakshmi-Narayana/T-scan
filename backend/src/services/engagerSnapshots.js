/**
 * Pure helpers shared by the engager analysis and its report.
 */

// Engager frequency tier from how many of the account's posts they retweeted.
const frequencyFor = (tweetsRetweeted, totalTweets) => {
  const ratio = totalTweets > 0 ? tweetsRetweeted / totalTweets : 0;
  if (ratio >= 0.5 || tweetsRetweeted >= 10) return 'super-active';
  if (ratio >= 0.25 || tweetsRetweeted >= 5) return 'regular';
  if (tweetsRetweeted >= 2) return 'occasional';
  return 'one-time';
};

const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

// Old snapshots not re-fetched in this run are kept; re-fetched ones are replaced.
const mergeSnapshots = (oldSnapshots = [], newSnapshots = []) => {
  const newIds = new Set(newSnapshots.map((t) => String(t.tweet_id)));
  const kept = oldSnapshots.map(plain).filter((t) => !newIds.has(String(t.tweet_id)));
  return [...kept, ...newSnapshots];
};

// Posts older than the cutoff, or with no date, are dropped from the stored analysis.
const dropOlderThan = (snapshots, cutoff) => snapshots.filter((t) => {
  const ms = t.created_at ? new Date(t.created_at).getTime() : NaN;
  return Number.isFinite(ms) && ms >= cutoff.getTime();
});

module.exports = { frequencyFor, mergeSnapshots, dropOlderThan };
