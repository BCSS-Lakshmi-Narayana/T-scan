/**
 * Diagnostic script to test Instagram RapidAPI integration end-to-end.
 * Run: node backend/scripts/test_instagram_api.js [username]
 * Example: node backend/scripts/test_instagram_api.js hyderabaddailynews
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

// Use command line arg or default
const TEST_USERNAME = process.argv[2] || 'hyderabaddailynews';

async function main() {
  console.log('=== Instagram RapidAPI Diagnostic ===\n');
  console.log(`Testing with username: @${TEST_USERNAME}\n`);

  // 1. Check env vars
  const keysStr = process.env.RAPIDAPI_INSTAGRAM_KEYS || process.env.RAPIDAPI_INSTAGRAM_KEY || process.env.RAPIDAPI_KEY || '';
  const keys = keysStr.split(',').map(k => k.trim()).filter(Boolean);
  const host = process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram120.p.rapidapi.com';

  console.log(`[1] RAPIDAPI_INSTAGRAM_KEYS: ${keys.length} keys found`);
  console.log(`[1] RAPIDAPI_INSTAGRAM_HOST: ${host}`);
  keys.forEach((k, i) => console.log(`    Key ${i}: ${k.substring(0, 10)}...${k.substring(k.length - 6)} (len=${k.length})`));

  if (keys.length === 0) {
    console.error('\n❌ FATAL: No Instagram RapidAPI keys found in env. Cannot proceed.');
    process.exit(1);
  }

  // 2. Test raw API call with first key
  const axios = require('axios');
  const key = keys[0];

  console.log(`\n[2] Testing raw POST to https://${host}/api/instagram/userInfo with key ${key.substring(0, 10)}...`);
  try {
    const resp = await axios.post(`https://${host}/api/instagram/userInfo`, { username: TEST_USERNAME }, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    console.log(`    Status: ${resp.status}`);
    console.log(`    Data keys: ${Object.keys(resp.data || {}).join(', ')}`);
    const dataStr = JSON.stringify(resp.data).substring(0, 500);
    console.log(`    Data preview: ${dataStr}`);
  } catch (err) {
    console.error(`    ❌ Error: ${err.response?.status} — ${JSON.stringify(err.response?.data || err.message).substring(0, 300)}`);
  }

  // 3. Test posts endpoint
  console.log(`\n[3] Testing raw POST to https://${host}/api/instagram/posts with key ${key.substring(0, 10)}...`);
  try {
    const resp = await axios.post(`https://${host}/api/instagram/posts`, { username: TEST_USERNAME }, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    console.log(`    Status: ${resp.status}`);
    console.log(`    Data keys: ${Object.keys(resp.data || {}).join(', ')}`);
    const dataStr = JSON.stringify(resp.data).substring(0, 500);
    console.log(`    Data preview: ${dataStr}`);
  } catch (err) {
    console.error(`    ❌ Error: ${err.response?.status} — ${JSON.stringify(err.response?.data || err.message).substring(0, 300)}`);
  }

  // 4. Test through the service module
  console.log(`\n[4] Testing via rapidApiInstagramService.fetchUserProfile('${TEST_USERNAME}')...`);
  try {
    const svc = require('../src/services/rapidApiInstagramService');
    const profile = await svc.fetchUserProfile(TEST_USERNAME);
    if (profile) {
      console.log(`    ✅ Profile received. Keys: ${Object.keys(profile).join(', ')}`);
      console.log(`    Preview: ${JSON.stringify(profile).substring(0, 500)}`);
    } else {
      console.log(`    ⚠️ Profile returned null`);
    }
  } catch (err) {
    console.error(`    ❌ Service error: ${err.message}`);
  }

  console.log(`\n[5] Testing via rapidApiInstagramService.fetchUserPosts('${TEST_USERNAME}')...`);
  try {
    const svc = require('../src/services/rapidApiInstagramService');
    const posts = await svc.fetchUserPosts(TEST_USERNAME);
    if (posts) {
      console.log(`    ✅ Posts received. Type: ${typeof posts}, Keys: ${Object.keys(posts).join(', ')}`);
      console.log(`    Preview: ${JSON.stringify(posts).substring(0, 500)}`);
    } else {
      console.log(`    ⚠️ Posts returned null`);
    }
  } catch (err) {
    console.error(`    ❌ Service error: ${err.message}`);
  }

  // 5.5. Test Stories endpoint
  console.log(`\n[5.5] Testing via rapidApiInstagramService.fetchUserStories('${TEST_USERNAME}')...`);
  try {
    const svc = require('../src/services/rapidApiInstagramService');
    const stories = await svc.fetchUserStories(TEST_USERNAME);
    if (stories) {
      console.log(`    ✅ Stories received. Type: ${typeof stories}, Keys: ${Object.keys(stories).join(', ')}`);
      console.log(`    Preview: ${JSON.stringify(stories).substring(0, 800)}`);
      
      // Try to extract story items - handle case where result is directly an array
      const data = stories?.data?.data || stories?.data || stories?.result || stories;
      let items = [];
      
      if (Array.isArray(data)) {
        items = data;
      } else {
        const candidates = [
          data?.reel?.items,
          data?.reels_media?.[0]?.items,
          data?.stories,
          data?.data?.stories,
          data?.items,
          data?.story?.items
        ];
        items = candidates.find(Array.isArray) || [];
      }
      
      console.log(`    📖 Extracted ${items.length} story items`);
      if (items.length > 0) {
        const sample = items[0];
        const storyId = sample.id || sample.pk || sample.media_id;
        console.log(`    Sample story: id=${storyId}, taken_at=${sample.taken_at}`);
        const storyUrl = `https://www.instagram.com/stories/${TEST_USERNAME}/${storyId}/`;
        console.log(`    Story URL: ${storyUrl}`);
        
        // Show media info
        if (sample.image_versions2?.candidates?.[0]) {
          console.log(`    Has image: ✅`);
        }
        if (sample.video_versions?.[0]) {
          console.log(`    Has video: ✅`);
        }
      }
    } else {
      console.log(`    ⚠️ Stories returned null (user may have no active stories)`);
    }
  } catch (err) {
    console.error(`    ❌ Service error: ${err.message}`);
  }

  // 6. Key health status
  console.log('\n[6] Key health after tests:');
  try {
    const svc = require('../src/services/rapidApiInstagramService');
    const health = svc.getKeyHealthStatus();
    console.table(health);
  } catch (err) {
    console.error(`    Error: ${err.message}`);
  }

  console.log('\n=== Diagnostic Complete ===');
}

main().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
