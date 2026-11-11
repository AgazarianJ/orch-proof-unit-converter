// Deterministic, offline build: dist/ = copy of app/ + version.json.
// LOCKED EVALUATOR FILE: orchestrator packages must not modify this file.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');
const distDir = join(root, 'dist');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(appDir, distDir, { recursive: true });

const sha = process.env.GITHUB_SHA ?? 'local';
await writeFile(join(distDir, 'version.json'), JSON.stringify({ sha }) + '\n');

console.log(`build: wrote ${distDir} (sha=${sha})`);
