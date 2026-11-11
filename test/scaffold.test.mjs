// Scaffold evaluator tests: build output and hosted smoke-check behaviour.
// LOCKED EVALUATOR FILE: orchestrator packages must not modify this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<main id="app">';
const GOOD_SHA = 'deadbeefcafebabe0123456789abcdef01234567';
const STALE_SHA = 'stale0000000000000000000000000000000000';

function runAt(scriptPath, args = [], env = {}, cwd = root) {
  return execFileP(process.execPath, [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err) => ({ code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  );
}

function run(script, args = [], env = {}) {
  return runAt(join(root, script), args, env);
}

// Default handler: serves { sha } at /version.json and html at / (status 200).
function siteHandler({ sha, html, indexStatus = 200 }) {
  return (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/version.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha }));
    } else if (path === '/' || path === '/index.html') {
      res.writeHead(indexStatus, { 'content-type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  };
}

// withServer(spec | handler, fn): fn(baseUrl, requests) where requests records
// every request the server received ({ url, headers }).
async function withServer(specOrHandler, fn) {
  const handler = typeof specOrHandler === 'function' ? specOrHandler : siteHandler(specOrHandler);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Runs a byte-identical copy of scripts/build.mjs against a throwaway tree in a
// temp directory, so fixtures never touch the repository's app/ or dist/.
async function withBuildFixture(setup, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-build-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await copyFile(join(root, 'scripts', 'build.mjs'), join(dir, 'scripts', 'build.mjs'));
    await setup(dir);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FAST = { SMOKE_ATTEMPTS: '2', SMOKE_DELAY_MS: '10' };
const GOOD_HTML = `<!doctype html><html lang="en"><body>${MARKER}</main></body></html>`;

// ---------------------------------------------------------------- build

test('build writes dist/index.html with marker and dist/version.json with GITHUB_SHA', async () => {
  const r = await run('scripts/build.mjs', [], { GITHUB_SHA: GOOD_SHA });
  assert.equal(r.code, 0, r.stderr);
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  assert.ok(html.includes(MARKER), 'dist/index.html must contain <main id="app">');
  const version = JSON.parse(await readFile(join(root, 'dist', 'version.json'), 'utf8'));
  assert.deepEqual(version, { sha: GOOD_SHA });
});

test('build overwrites a forged app/version.json with the real sha', async () => {
  await withBuildFixture(
    async (dir) => {
      await mkdir(join(dir, 'app'));
      await writeFile(join(dir, 'app', 'index.html'), GOOD_HTML);
      await writeFile(join(dir, 'app', 'version.json'), JSON.stringify({ sha: 'forged' }));
    },
    async (dir) => {
      const r = await runAt(join(dir, 'scripts', 'build.mjs'), [], { GITHUB_SHA: GOOD_SHA }, dir);
      assert.equal(r.code, 0, r.stderr);
      const version = JSON.parse(await readFile(join(dir, 'dist', 'version.json'), 'utf8'));
      assert.deepEqual(version, { sha: GOOD_SHA });
    },
  );
});

test('build rejects a symlinked file inside app/', async () => {
  await withBuildFixture(
    async (dir) => {
      await mkdir(join(dir, 'app', 'nested'), { recursive: true });
      await writeFile(join(dir, 'app', 'index.html'), GOOD_HTML);
      await writeFile(join(dir, 'outside.txt'), 'secret outside app/');
      await symlink(join(dir, 'outside.txt'), join(dir, 'app', 'nested', 'leak.txt'));
    },
    async (dir) => {
      const r = await runAt(join(dir, 'scripts', 'build.mjs'), [], { GITHUB_SHA: GOOD_SHA }, dir);
      assert.notEqual(r.code, 0, 'a symlink in app/ must fail the build');
      assert.match(r.stderr, /refusing to copy symbolic link app\/nested\/leak\.txt/);
      await assert.rejects(readFile(join(dir, 'dist', 'nested', 'leak.txt')), 'symlink must not be published');
    },
  );
});

test('build rejects app/ itself being a symlink', async () => {
  await withBuildFixture(
    async (dir) => {
      await mkdir(join(dir, 'real'));
      await writeFile(join(dir, 'real', 'index.html'), GOOD_HTML);
      await symlink(join(dir, 'real'), join(dir, 'app'));
    },
    async (dir) => {
      const r = await runAt(join(dir, 'scripts', 'build.mjs'), [], { GITHUB_SHA: GOOD_SHA }, dir);
      assert.notEqual(r.code, 0, 'a symlinked app/ must fail the build');
      assert.match(r.stderr, /refusing to copy symbolic link app /);
    },
  );
});

// ---------------------------------------------------------------- smoke

test('smoke passes when the server serves the expected sha and marker', async () => {
  const r = await withServer({ sha: GOOD_SHA, html: GOOD_HTML }, (url) =>
    run('scripts/smoke.mjs', [url, GOOD_SHA], FAST),
  );
  assert.equal(r.code, 0, r.stderr);
});

test('smoke fails on a stale sha', async () => {
  const r = await withServer({ sha: STALE_SHA, html: GOOD_HTML }, (url) =>
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

test('smoke fails on a non-2xx index page even if its body contains the marker', async () => {
  const r = await withServer({ sha: GOOD_SHA, html: GOOD_HTML, indexStatus: 404 }, (url) =>
    run('scripts/smoke.mjs', [url, GOOD_SHA], FAST),
  );
  assert.notEqual(r.code, 0, 'a 404 page with the marker must fail');
  assert.match(r.stderr, /HTTP 404/);
});

test('smoke fails when the index page redirects, even to a page with the marker', async () => {
  const good = siteHandler({ sha: GOOD_SHA, html: GOOD_HTML });
  const handler = (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/') {
      res.writeHead(302, { location: '/elsewhere/index.html' });
      res.end();
    } else if (path === '/elsewhere/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(GOOD_HTML);
    } else {
      good(req, res);
    }
  };
  const { r, requests } = await withServer(handler, async (url, requests) => ({
    r: await run('scripts/smoke.mjs', [url, GOOD_SHA], FAST),
    requests,
  }));
  assert.notEqual(r.code, 0, 'a redirect must fail');
  assert.match(r.stderr, /redirect/i);
  assert.ok(!requests.some((q) => q.url.startsWith('/elsewhere')), 'redirect target must not be fetched');
});

test('smoke fails when version.json redirects', async () => {
  const good = siteHandler({ sha: GOOD_SHA, html: GOOD_HTML });
  const handler = (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/version.json') {
      res.writeHead(301, { location: '/other/version.json' });
      res.end();
    } else if (path === '/other/version.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha: GOOD_SHA }));
    } else {
      good(req, res);
    }
  };
  const r = await withServer(handler, (url) => run('scripts/smoke.mjs', [url, GOOD_SHA], FAST));
  assert.notEqual(r.code, 0, 'a redirected version.json must fail');
  assert.match(r.stderr, /redirect/i);
});

test('smoke sends a cache-busting query and no-cache headers on every request', async () => {
  // Stale sha so both attempts run; each attempt must use a fresh query value.
  const requests = await withServer({ sha: STALE_SHA, html: GOOD_HTML }, async (url, requests) => {
    await run('scripts/smoke.mjs', [url, GOOD_SHA], FAST);
    return requests;
  });
  assert.equal(requests.length, 2, 'two attempts, each fetching version.json only (sha mismatch)');
  const busts = [];
  for (const q of requests) {
    const u = new URL(q.url, 'http://x');
    assert.equal(u.pathname, '/version.json');
    assert.match(u.search, /^\?t=\d+-[a-z0-9]+$/, `missing cache-busting query on ${q.url}`);
    busts.push(u.searchParams.get('t'));
    assert.equal(q.headers['cache-control'], 'no-cache');
    assert.equal(q.headers.pragma, 'no-cache');
  }
  assert.notEqual(busts[0], busts[1], 'each attempt must use a new cache-busting value');

  // Successful attempt: index request carries the same headers and a query too.
  const ok = await withServer({ sha: GOOD_SHA, html: GOOD_HTML }, async (url, requests) => {
    const r = await run('scripts/smoke.mjs', [url, GOOD_SHA], FAST);
    return { r, requests };
  });
  assert.equal(ok.r.code, 0, ok.r.stderr);
  const index = ok.requests.find((q) => new URL(q.url, 'http://x').pathname === '/');
  assert.ok(index, 'index page must be requested');
  assert.match(new URL(index.url, 'http://x').search, /^\?t=\d+-[a-z0-9]+$/);
  assert.equal(index.headers['cache-control'], 'no-cache');
  assert.equal(index.headers.pragma, 'no-cache');
});

test('smoke retry recovers after a stale response', async () => {
  let versionHits = 0;
  const handler = (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/version.json') versionHits++;
    const sha = path === '/version.json' && versionHits <= 2 ? STALE_SHA : GOOD_SHA;
    siteHandler({ sha, html: GOOD_HTML })(req, res);
  };
  const r = await withServer(handler, (url) =>
    run('scripts/smoke.mjs', [url, GOOD_SHA], { SMOKE_ATTEMPTS: '3', SMOKE_DELAY_MS: '10' }),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /attempt 1\/3 failed: .*sha mismatch/);
  assert.match(r.stderr, /attempt 2\/3 failed: .*sha mismatch/);
  assert.match(r.stdout, /OK on attempt 3\/3/);
  assert.equal(versionHits, 3);
});

test('smoke fails after exactly N attempts when the response stays stale', async () => {
  const { r, requests } = await withServer({ sha: STALE_SHA, html: GOOD_HTML }, async (url, requests) => ({
    r: await run('scripts/smoke.mjs', [url, GOOD_SHA], { SMOKE_ATTEMPTS: '3', SMOKE_DELAY_MS: '10' }),
    requests,
  }));
  assert.notEqual(r.code, 0, 'persistently stale must fail');
  assert.match(r.stderr, /FAILED after 3 attempts/);
  assert.equal(requests.filter((q) => q.url.startsWith('/version.json')).length, 3);
});
