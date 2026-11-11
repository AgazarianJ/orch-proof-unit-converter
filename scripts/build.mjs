// Deterministic, offline build: dist/ = copy of app/ + version.json.
// LOCKED EVALUATOR FILE: orchestrator packages must not modify this file.
//
// app/ may contain only regular files and directories. Symbolic links (and any
// other special file) are rejected so the published site can never include
// files from outside app/.
import { cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');
const distDir = join(root, 'dist');

async function assertPlainTree(path) {
  const st = await lstat(path);
  const rel = relative(root, path) || '.';
  if (st.isSymbolicLink()) {
    throw new Error(`build: refusing to copy symbolic link ${rel} (app/ must contain only regular files and directories)`);
  }
  if (st.isDirectory()) {
    for (const name of await readdir(path)) await assertPlainTree(join(path, name));
  } else if (!st.isFile()) {
    throw new Error(`build: refusing to copy special file ${rel} (app/ must contain only regular files and directories)`);
  }
}

try {
  await assertPlainTree(appDir);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(appDir, distDir, { recursive: true });

// Written after the copy, so a forged app/version.json is always overwritten.
const sha = process.env.GITHUB_SHA ?? 'local';
await writeFile(join(distDir, 'version.json'), JSON.stringify({ sha }) + '\n');

console.log(`build: wrote ${distDir} (sha=${sha})`);
