// Scaffold evaluator tests: build output and hosted smoke-check behaviour.
// LOCKED EVALUATOR FILE: orchestrator packages must not modify this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<main id="app">';
const GOOD_SHA = 'deadbeefcafebabe0123456789abcdef01234567';

function run(script, args = [], env = {}) {
  return execFileP(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err) => ({ code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  );
}

async function withServer({ sha, html }, fn) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/version.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha }));
    } else if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const FAST = { SMOKE_ATTEMPTS: '2', SMOKE_DELAY_MS: '10' };
const GOOD_HTML = `<!doctype html><html lang="en"><body>${MARKER}</main></body></html>`;

test('build writes dist/index.html with marker and dist/version.json with GITHUB_SHA', async () => {
  const r = await run('scripts/build.mjs', [], { GITHUB_SHA: GOOD_SHA });
  assert.equal(r.code, 0, r.stderr);
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  assert.ok(html.includes(MARKER), 'dist/index.html must contain <main id="app">');
  const version = JSON.parse(await readFile(join(root, 'dist', 'version.json'), 'utf8'));
  assert.deepEqual(version, { sha: GOOD_SHA });
});

test('smoke passes when the server serves the expected sha and marker', async () => {
  const r = await withServer({ sha: GOOD_SHA, html: GOOD_HTML }, (url) =>
    run('scripts/smoke.mjs', [url, GOOD_SHA], FAST),
  );
  assert.equal(r.code, 0, r.stderr);
});

test('smoke fails on a stale sha', async () => {
  const r = await withServer({ sha: 'stale0000000000000000000000000000000000', html: GOOD_HTML }, (url) =>
    run('scripts/smoke.mjs', [url, GOOD_SHA], FAST),
  );
  assert.notEqual(r.code, 0, 'stale sha must fail');
  assert.match(r.stderr, /sha mismatch/);
});

test('smoke fails when the root marker is missing', async () => {
  const r = await withServer({ sha: GOOD_SHA, html: '<!doctype html><main>no marker</main>' }, (url) =>
    run('scripts/smoke.mjs', [url, GOOD_SHA], FAST),
  );
  assert.notEqual(r.code, 0, 'missing marker must fail');
  assert.match(r.stderr, /does not contain/);
});
