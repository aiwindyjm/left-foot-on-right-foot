import { checkMarkdownLinks } from './markdown.mjs';
import { scanFiles } from './check-secrets.mjs';
import { git, projectFiles } from './repository.mjs';

const files = projectFiles();
const errors = [
  ...files.filter((path) => path.endsWith('.md')).flatMap((path) => checkMarkdownLinks(path)),
  ...scanFiles(files),
];

try {
  git(['diff', '--check']);
  git(['diff', '--cached', '--check', '--', '.', ':!docs/originals/**']);
} catch {
  errors.push('Git whitespace check failed (historical originals are preserved unchanged).');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${files.length} Git-visible files: local Markdown links, known secret patterns and Git whitespace.`);
  console.log('Static foundation checks only; no Agent or LLM integration has been exercised.');
}
