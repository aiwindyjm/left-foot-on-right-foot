import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { git, projectFiles, readText, root } from '../scripts/repository.mjs';
import { readStrictJson } from '../scripts/fixture-validation.mjs';
import { checkMarkdownLinks } from '../scripts/markdown.mjs';
import { scanText } from '../scripts/check-secrets.mjs';

test('required foundation assets exist and are nonempty', () => {
  const required = [
    'README.md', 'LICENSE', 'AGENTS.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
    'SECURITY.md', 'CHANGELOG.md', '.gitignore', '.gitattributes', '.editorconfig',
    'package.json', 'package-lock.json', 'docs/PRD.md', 'docs/architecture.md', 'docs/requirements.md',
    'docs/workflow.md', 'docs/workflow-model.json', 'docs/development.md', 'docs/tech-stack.md',
    'docs/agent-execution.md', 'docs/desktop-integration.md', 'docs/originals/manifest.json',
    'docs/roadmap/phase-1a.md', 'docs/phase-1a-report.md', 'evaluation/README.md',
    'evaluation/case.schema.json', 'evaluation/acceptance.json', 'evaluation/practice.json',
    'protocol/README.md', 'protocol/message.schema.json', 'protocol/examples.json',
    '.github/workflows/validate.yml', '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/proposal.yml', '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md', '.github/CODEOWNERS',
    ...Array.from({ length: 6 }, (_, i) => `docs/roadmap/phase-${i}.md`),
  ];
  for (const path of required) {
    assert.ok(existsSync(resolve(root, path)), path);
    assert.ok(readText(path).trim().length > 0, path);
  }
});

test('original sources retain their exact bytes and disable Git text conversion', () => {
  const manifest = readStrictJson(readText('docs/originals/manifest.json'));
  assert.equal(manifest.files.length, 2);
  for (const { path, sha256 } of manifest.files) {
    const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
    assert.equal(actual, sha256, path);
    const attributes = git(['check-attr', '-z', 'text', '--', path]).split('\0');
    assert.equal(attributes[2], 'unset', path);
  }
});

test('all project Markdown relative links resolve', () => {
  const errors = projectFiles().filter((path) => path.endsWith('.md')).flatMap((path) => checkMarkdownLinks(path));
  assert.deepEqual(errors, []);
});

test('link checker handles reference links and rejects missing targets, escaping paths and missing anchors', () => {
  assert.equal(checkMarkdownLinks('README.md', '[bad](missing-file.md)').length, 1);
  assert.equal(checkMarkdownLinks('README.md', '[bad](../outside.md)').length, 1);
  assert.equal(checkMarkdownLinks('README.md', '[bad](README.md#nonexistent-heading)').length, 1);
  assert.equal(checkMarkdownLinks('README.md', '[good](docs/architecture.md)').length, 0);
  assert.equal(checkMarkdownLinks('README.md', '[good][arch]\n\n[arch]: docs/architecture.md').length, 0);
});

test('known secret patterns are detected without embedding real credentials', () => {
  const samples = [
    ['gh' + 'p_', 'a'.repeat(36)],
    ['sk-' + 'proj-', 'a'.repeat(40)],
    ['AK' + 'IA', 'A'.repeat(16)],
    ['-----BEGIN ', 'PRIVATE KEY-----'],
    ['Bearer ', 'a'.repeat(32)],
    ['api_key = "', 'a'.repeat(32) + '"'],
  ];
  for (const chunks of samples) assert.ok(scanText(chunks.join('')).length > 0);
  assert.deepEqual(scanText('yuanjiaomin@gmail.com'), []);
  assert.deepEqual(scanText('13315738+aiwindyjm@users.noreply.github.com'), []);
});

test('representative credentials and runtime state are ignored but examples remain visible', () => {
  const ignored = [
    '.env', '.env.local', '.npmrc', 'cookies.json', 'tokens.json', '.auth/session.json',
    'playwright/.auth/user.json', 'browser-profile-test/Default/Cookies', 'sessions/current.json',
    'logs/run.log', '.codex/state.json', '.vscode/settings.json', 'node_modules/a/index.js',
  ];
  const actual = git(['check-ignore', '--stdin'], { input: `${ignored.join('\n')}\n` }).trim().split(/\r?\n/);
  assert.deepEqual(actual, ignored);
  assert.ok(projectFiles().includes('protocol/examples.json'));
});
