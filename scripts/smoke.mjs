// Hosted smoke test: node scripts/smoke.mjs <url> <sha>
// Passes only when <url>/version.json reports <sha> AND <url>/ contains <main id="app">.
// Retries with bounded attempts; tune with SMOKE_ATTEMPTS / SMOKE_DELAY_MS.
// Redirects are treated as failures (redirect: 'error').
// LOCKED EVALUATOR FILE: orchestrator packages must not modify this file.
const MARKER = '<main id="app">';

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`smoke: invalid ${name}=${JSON.stringify(raw)} (expected a non-negative integer)`);
    process.exit(2);
  }
  return n;
}

const [rawUrl, expectedSha] = process.argv.slice(2);
if (!rawUrl || !expectedSha) {
  console.error('usage: node scripts/smoke.mjs <url> <sha>');
  process.exit(2);
}

const attempts = Math.max(1, positiveInt('SMOKE_ATTEMPTS', 20));
const delayMs = positiveInt('SMOKE_DELAY_MS', 15000);
const base = rawUrl.endsWith('/') ? rawUrl : rawUrl + '/';

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      // Never follow redirects: the content must come from exactly <url>.
      redirect: 'error',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`GET ${url} failed: ${err.cause?.message ?? err.message}`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return body;
}

async function check() {
  const bust = `t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const versionUrl = new URL(`version.json?${bust}`, base).href;
  const text = await fetchText(versionUrl);
  let version;
  try {
    version = JSON.parse(text);
  } catch {
    throw new Error(`version.json is not valid JSON: ${text.slice(0, 200)}`);
  }
  if (version?.sha !== expectedSha) {
    throw new Error(`version.json sha mismatch: expected ${expectedSha}, got ${JSON.stringify(version?.sha)}`);
  }
  const indexUrl = new URL(`?${bust}`, base).href;
  const html = await fetchText(indexUrl);
  if (!html.includes(MARKER)) {
    throw new Error(`index page at ${base} does not contain ${MARKER}`);
  }
}

let lastError;
for (let i = 1; i <= attempts; i++) {
  try {
    await check();
    console.log(`smoke: OK on attempt ${i}/${attempts} — ${base} serves sha ${expectedSha} and ${MARKER}`);
    process.exit(0);
  } catch (err) {
    lastError = err;
    console.error(`smoke: attempt ${i}/${attempts} failed: ${err.message}`);
    if (i < attempts && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
}
console.error(`smoke: FAILED after ${attempts} attempts: ${lastError?.message}`);
process.exit(1);
