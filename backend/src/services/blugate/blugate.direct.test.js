/**
 * CONTENT_PROVIDER switches the transport, not the provider.
 *
 * Why these assertions and not others: the parsers in rapidApi*Service were
 * written against the shapes the UPSTREAM providers return, and BluGate passes
 * those through unchanged. So direct mode is only safe while it calls the same
 * upstream — twitter241, ig-downloader-api, facebook-scraper3. If "direct" ever
 * came to mean instagram120 (what this backend used before the migration) every
 * Instagram parser would break on a payload it has never seen.
 *
 * Run: npm test  (node --test)
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const DIR = path.join(__dirname, 'blugate.direct.js');

/** Fresh module with a given environment, so the switch is read each time. */
const withEnv = (env, fn) => {
  const saved = { ...process.env };
  for (const k of ['CONTENT_PROVIDER', 'RAPIDAPI_KEY', 'YOUTUBE_API_KEY',
                   'RAPIDAPI_X_KEY', 'RAPIDAPI_X_BASE_URL', 'RAPIDAPI_HOST',
                   'RAPIDAPI_INSTAGRAM_KEYS', 'RAPIDAPI_INSTAGRAM_HOST',
                   'RAPIDAPI_FACEBOOK_KEY', 'RAPIDAPI_FACEBOOK_HOST']) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve(DIR)];
  try {
    return fn(require(DIR));
  } finally {
    process.env = saved;
    delete require.cache[require.resolve(DIR)];
  }
};

// ----------------------------------------------------------- the switch

test('the gateway is the default, so an unset switch changes nothing', () => {
  withEnv({}, (d) => {
    assert.strictEqual(d.mode(), 'blugate');
    assert.strictEqual(d.isDirect(), false);
  });
});

test('only an explicit rapidapi value turns direct mode on', () => {
  for (const value of ['rapidapi', 'RapidAPI', '  RAPIDAPI  ']) {
    withEnv({ CONTENT_PROVIDER: value }, (d) => {
      assert.strictEqual(d.isDirect(), true, `${value} should enable direct`);
    });
  }
  for (const value of ['blugate', '', 'true', 'yes', 'rapid', 'gateway']) {
    withEnv({ CONTENT_PROVIDER: value }, (d) => {
      assert.strictEqual(d.isDirect(), false, `${value} must NOT enable direct`);
    });
  }
});

// --------------------------------------------- the same upstream provider

test('direct mode calls the same upstream the gateway fronts', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k' }, (d) => {
    assert.match(d.describeDirect('x').baseUrl, /twitter241/);
    assert.match(d.describeDirect('facebook').baseUrl, /facebook-scraper3/);
    // instagram120 is commented out in .env from before the migration; it is a
    // different provider with different response bodies and must not be used.
    assert.match(d.describeDirect('instagram').baseUrl, /ig-downloader/);
    assert.doesNotMatch(d.describeDirect('instagram').baseUrl, /instagram120/);
  });
});

test('youtube is google, not rapidapi', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi' }, (d) => {
    const yt = d.describeDirect('youtube');
    assert.strictEqual(yt.auth, 'google_key');
    assert.match(yt.baseUrl, /googleapis\.com\/youtube\/v3/);
    assert.match(yt.keyEnv, /YOUTUBE_API_KEY/);
  });
});

test('a base url can be overridden without a code change', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k',
            RAPIDAPI_X_BASE_URL: 'https://example.invalid/v2/' }, (d) => {
    assert.strictEqual(d.describeDirect('x').baseUrl, 'https://example.invalid/v2');
  });
});

// ------------------------------------------------------- configured-ness

test('direct mode is configured only when its key is present', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi' }, (d) => {
    assert.strictEqual(d.isDirectConfigured('x'), false);
  });
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k' }, (d) => {
    assert.strictEqual(d.isDirectConfigured('x'), true);
    assert.strictEqual(d.isDirectConfigured('facebook'), true);
    // YouTube has its own key and must not be satisfied by the RapidAPI one.
    assert.strictEqual(d.isDirectConfigured('youtube'), false);
  });
  withEnv({ CONTENT_PROVIDER: 'rapidapi', YOUTUBE_API_KEY: 'g' }, (d) => {
    assert.strictEqual(d.isDirectConfigured('youtube'), true);
    assert.strictEqual(d.isDirectConfigured('x'), false);
  });
});

test('a per-platform key overrides the shared one', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_X_KEY: 'only-x' }, (d) => {
    assert.strictEqual(d.isDirectConfigured('x'), true);
    assert.strictEqual(d.isDirectConfigured('facebook'), false);
  });
});

test('an unknown platform is refused rather than guessed', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k' }, (d) => {
    assert.strictEqual(d.directConfig('tiktok'), null);
    assert.strictEqual(d.isDirectConfigured('tiktok'), false);
    assert.strictEqual(d.describeDirect('tiktok'), null);
  });
});

// ------------------------------------------------------- failure is clear

test('a missing key names the variable to set', async () => {
  await withEnv({ CONTENT_PROVIDER: 'rapidapi' }, async (d) => {
    await assert.rejects(
      () => d.directRequest({ slug: 'x', path: '/search', label: 'X' }),
      (err) => {
        assert.match(err.message, /RAPIDAPI_KEY/);
        assert.strictEqual(err.status, 400);
        return true;
      }
    );
  });
});

test('an unconfigured platform fails closed, it does not fall back to the gateway', async () => {
  await withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k' }, async (d) => {
    await assert.rejects(
      () => d.directRequest({ slug: 'tiktok', path: '/x', label: 'TikTok' }),
      /no direct provider is configured/
    );
  });
});

// ------------------------------------------- the chokepoint honours it

test('every platform shorthand goes through the one switch', () => {
  const saved = { ...process.env };
  process.env.CONTENT_PROVIDER = 'rapidapi';
  delete process.env.RAPIDAPI_KEY;
  for (const m of Object.keys(require.cache)) {
    if (m.includes('blugate')) delete require.cache[m];
  }
  try {
    const blugate = require('./index');
    assert.strictEqual(typeof blugate.transport, 'function');
    assert.strictEqual(blugate.transport().mode, 'rapidapi');
    // Without a key, every platform reports itself unusable — so monitorService
    // chooses the scraper rather than calling a provider with no credential.
    const names = blugate.transport().platforms.map((p) => p.slug);
    assert.deepStrictEqual(names.sort(), ['facebook', 'instagram', 'x', 'youtube']);
    assert.ok(blugate.transport().platforms.every((p) => p.configured === false));
  } finally {
    process.env = saved;
    for (const m of Object.keys(require.cache)) {
      if (m.includes('blugate')) delete require.cache[m];
    }
  }
});

test('isConfigured answers for the ACTIVE transport', async () => {
  const saved = { ...process.env };
  process.env.CONTENT_PROVIDER = 'rapidapi';
  process.env.RAPIDAPI_KEY = 'k';
  for (const m of Object.keys(require.cache)) {
    if (m.includes('blugate')) delete require.cache[m];
  }
  try {
    const blugate = require('./index');
    // True from the environment key alone — no tenant scope, no database.
    assert.strictEqual(await blugate.isConfigured('x'), true);
    assert.strictEqual(await blugate.isConfigured('youtube'), false);
  } finally {
    process.env = saved;
    for (const m of Object.keys(require.cache)) {
      if (m.includes('blugate')) delete require.cache[m];
    }
  }
});


// ------------------------------- the names this .env already uses

test('the existing .env variable names are honoured', () => {
  // Uncommenting the block that is already in .env must be enough: a bare host
  // with no scheme, and the plural RAPIDAPI_INSTAGRAM_KEYS.
  withEnv({ CONTENT_PROVIDER: 'rapidapi',
            RAPIDAPI_KEY: 'shared',
            RAPIDAPI_HOST: 'twitter241.p.rapidapi.com',
            RAPIDAPI_FACEBOOK_HOST: 'facebook-scraper3.p.rapidapi.com',
            RAPIDAPI_INSTAGRAM_KEYS: 'ig-key' }, (d) => {
    assert.strictEqual(d.describeDirect('x').baseUrl, 'https://twitter241.p.rapidapi.com');
    assert.strictEqual(d.describeDirect('facebook').baseUrl,
                       'https://facebook-scraper3.p.rapidapi.com');
    assert.strictEqual(d.isDirectConfigured('instagram'), true, 'plural KEYS must count');
    assert.strictEqual(d.isDirectConfigured('x'), true);
  });
});

test('a bare host and a full url both resolve, trailing slash removed', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k',
            RAPIDAPI_HOST: 'bare.example.com' }, (d) => {
    assert.strictEqual(d.describeDirect('x').baseUrl, 'https://bare.example.com');
  });
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k',
            RAPIDAPI_X_BASE_URL: 'https://full.example.com/v2/' }, (d) => {
    assert.strictEqual(d.describeDirect('x').baseUrl, 'https://full.example.com/v2');
  });
});

test('instagram120 is never the default, even though it sits in .env', () => {
  withEnv({ CONTENT_PROVIDER: 'rapidapi', RAPIDAPI_KEY: 'k' }, (d) => {
    assert.match(d.describeDirect('instagram').baseUrl, /ig-downloader-api/);
  });
});
