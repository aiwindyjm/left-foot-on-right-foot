import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
}

export function projectFiles() {
  return [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0').filter(Boolean))]
    .filter((path) => existsSync(resolve(root, path)))
    .sort();
}

export function readText(path) {
  return readFileSync(resolve(root, path), 'utf8');
}
