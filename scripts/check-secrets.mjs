import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectFiles, readText } from './repository.mjs';

const patterns = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['API secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/i],
  ['credential assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_./+=-]{20,}["']/i],
  ['local home path', /(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+|\/(?:home|Users)\/[^/\s]+)/i],
];

export function scanText(text) {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export function scanFiles(files = projectFiles()) {
  const findings = [];
  for (const path of files) {
    if (/(^|\/)(?:\.env(?:\..+)?|credentials\.json|auth\.json|tokens\.json|cookies[^/]*\.(?:json|txt))$/i.test(path)
        && !path.endsWith('/.env.example') && path !== '.env.example') {
      findings.push(`${path}: sensitive filename`);
    }
    for (const label of scanText(readText(path))) {
      findings.push(`${path}: ${label}`);
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = scanFiles();
  if (findings.length) {
    console.error(findings.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('No known secret patterns found in Git-visible files. Manual review is still required.');
  }
}
