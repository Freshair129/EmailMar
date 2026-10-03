import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const roots = ['src', 'scripts', 'test'];
const files = [];

async function collect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (entry.isFile() && target.endsWith('.mjs')) files.push(target);
  }
}

for (const root of roots) {
  try { await collect(root); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(`${file}\n${result.stderr || result.stdout}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) process.stdout.write(`Syntax OK: ${files.length} JavaScript module(s).\n`);
