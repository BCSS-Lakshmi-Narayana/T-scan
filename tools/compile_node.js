#!/usr/bin/env node
/* Build a compiled copy of the Node backend, so no readable source ships.
 *
 *   node tools/compile_node.js  backend  build/backend
 *   node tools/compile_node.js  backend  build/backend  --smoke
 *
 * Run it with the Node version that will RUN the result, on the machine that
 * will run it: V8 bytecode only loads on the same Node/V8 build it was made with.
 *
 * What the output contains
 *   * every .js module as V8 bytecode (.jsc) plus a one-line loader .js that
 *     requires it — the loader holds no logic, only `require('./x.jsc')`
 *   * data the code reads at runtime: .json, .geojson, the scraper .py, public/
 *   * package.json, package-lock.json, node_modules (installed by the caller)
 * What it leaves out
 *   * tests, .env, .git, logs, runtime storage/downloads, build output
 *
 * A file that will not compile is left as .js and listed at the end, and the
 * tool exits non-zero, so a partial build is never shipped silently.
 *
 * Why a function sent to the browser must already be a string: once compiled,
 * a function's source text is filler, so page.evaluate(fn) would ship filler.
 * The two such calls were made string arguments before compiling (see the PDF
 * services). This tool does not rewrite them.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'tests', '__tests__', 'coverage',
  'build', 'dist', '.nyc_output', 'storage', 'downloads', 'logs', '.vscode',
]);
// Files kept as source because they are not part of the running server, or are
// executed by a separate interpreter.
const KEEP_AS_SOURCE = new Set(['scraper.py']);
const isTest = (name) => /\.test\.js$/.test(name) || name === 'audit_tmp.js';
const isEnv = (name) => name === '.env' || name.startsWith('.env.');

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), path.join(base, entry.name), out);
    } else if (entry.isFile()) {
      if (isTest(entry.name) || isEnv(entry.name)) continue;
      if (/\.(pyc|jsc|map)$/.test(entry.name)) continue;
      out.push(path.join(base, entry.name));
    }
  }
}

function copyTree(src, dst, files) {
  for (const rel of files) {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// One-line loaders carry no business logic — only the require plumbing.
const LOADER = (base) => `'use strict';\nrequire('bytenode');\nmodule.exports = require('./${base}.jsc');\n`;

async function main() {
  const [src, dst, ...flags] = process.argv.slice(2);
  if (!src || !dst) {
    console.error('usage: node tools/compile_node.js <src> <dst> [--smoke] [--port N]');
    process.exit(2);
  }
  const smoke = flags.includes('--smoke');
  const port = (() => { const i = flags.indexOf('--port'); return i >= 0 ? flags[i + 1] : '8099'; })();

  const srcDir = path.resolve(src);
  const dstDir = path.resolve(dst);

  let bytenode;
  try {
    bytenode = require(path.join(srcDir, 'node_modules', 'bytenode'));
  } catch {
    try { bytenode = require('bytenode'); } catch {
      console.error('bytenode is not installed. In the backend: npm install bytenode');
      process.exit(2);
    }
  }

  if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true, force: true });
  const files = [];
  walk(srcDir, '', files);
  copyTree(srcDir, dstDir, files);

  const toCompile = files.filter((f) => f.endsWith('.js') && !KEEP_AS_SOURCE.has(path.basename(f)));
  console.log(`compiling ${toCompile.length} modules ...`);

  const failed = [];
  const t0 = Date.now();
  for (const rel of toCompile) {
    const jsPath = path.join(dstDir, rel);
    const jscPath = jsPath.slice(0, -3) + '.jsc';
    try {
      await bytenode.compileFile({ filename: jsPath, output: jscPath, compileAsModule: true });
      fs.writeFileSync(jsPath, LOADER(path.basename(rel, '.js')));   // replace source with loader
    } catch (err) {
      failed.push([rel, String(err && err.message || err).split('\n').pop()]);
    }
  }

  console.log(`compiled ${toCompile.length - failed.length} of ${toCompile.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (failed.length) {
    console.log(`\n${failed.length} module(s) did NOT compile and are still .js:`);
    for (const [rel, msg] of failed) console.log(`  - ${rel}\n      ${msg}`);
    console.log('\nREFUSING TO CONTINUE: the build would contain readable source.');
    process.exit(1);
  }

  // Any readable .js left that is not a known loader/kept file is a miss.
  const leftover = [];
  const check = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) check(path.join(dir, e.name), path.join(base, e.name)); continue; }
      if (!e.name.endsWith('.js')) continue;
      const body = fs.readFileSync(path.join(dir, e.name), 'utf8');
      if (!body.includes(".jsc')")) leftover.push(path.join(base, e.name));
    }
  };
  check(dstDir, '');
  if (leftover.length) {
    console.log(`\nREFUSING TO CONTINUE: ${leftover.length} .js file(s) are not compiled:`);
    leftover.forEach((f) => console.log('   ', f));
    process.exit(1);
  }
  console.log('every .js is a bytecode loader; no readable source remains.');

  if (smoke) return runSmoke(dstDir);
  process.exit(0);
}

// Load the compiled entry graph (TSCAN_BOOT=off) in a child process: proves every
// .jsc is valid for this Node version and the modules evaluate without throwing.
// It does NOT connect to the database, start collection, or listen — so it spends
// no quota and is safe to run next to a live server. The HTTP behaviour of the
// live instance is checked by the deploy script's post-restart health check.
function runSmoke(dstDir) {
  console.log('\nsmoke test: loading the compiled module graph (TSCAN_BOOT=off) ...');
  const r = spawnSync(process.execPath, ['src/index.js'],
    { cwd: dstDir, env: { ...process.env, TSCAN_BOOT: 'off' }, stdio: 'inherit', timeout: 60000 });
  if (r.status === 0) { console.log('\nsmoke test PASSED: the compiled build loads on this Node version.'); process.exit(0); }
  console.error(`\nsmoke test FAILED (exit ${r.status}${r.signal ? ', ' + r.signal : ''}): the compiled build did not load.`);
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
