/**
 * Test each key individually against the posts endpoint to find which keys work.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');

const TEST_USERNAME = 'queen_of_sanatani___07';

async function main() {
  const keysStr = process.env.RAPIDAPI_INSTAGRAM_KEYS || '';
  const keys = keysStr.split(',').map(k => k.trim()).filter(Boolean);
  const host = process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram120.p.rapidapi.com';

  console.log(`Testing ${keys.length} keys against posts endpoint...\n`);

  // Test the endpoint that worked in raw test (step 2 of previous diagnostic)
  const endpoints = [
    '/api/instagram/posts',
    '/api/instagram/userInfo',
  ];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    console.log(`\n--- Key ${i}: ${key.substring(0, 10)}... (len=${key.length}) ---`);

    for (const ep of endpoints) {
      try {
        const resp = await axios.post(`https://${host}${ep}`, { username: TEST_USERNAME }, {
          headers: {
            'x-rapidapi-key': key,
            'x-rapidapi-host': host,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });
        const dataKeys = Object.keys(resp.data || {});
        console.log(`  ${ep}: ✅ ${resp.status} (keys: ${dataKeys.join(', ')})`);
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.message;
        console.log(`  ${ep}: ❌ ${status} — ${msg}`);
      }
    }
  }
}

main().catch(console.error);
