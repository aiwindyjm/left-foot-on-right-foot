import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { readText, root } from './repository.mjs';

const parser = unified().use(remarkParse);

export function markdownTree(text) {
  return parser.parse(text);
}

export function nodes(tree) {
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}

export function plainText(node) {
  return node.value ?? (node.children ?? []).map(plainText).join('');
}

function headingAnchors(tree) {
  const counts = new Map();
  return new Set(nodes(tree).filter((node) => node.type === 'heading').map((node) => {
    const base = plainText(node).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  }));
}

export function checkMarkdownLinks(path, text = readText(path)) {
  const tree = markdownTree(text);
  const all = nodes(tree);
  const definitions = new Map(all.filter((node) => node.type === 'definition')
    .map((node) => [node.identifier, node.url]));
  const links = all.filter((node) => ['link', 'image', 'linkReference', 'imageReference'].includes(node.type));
  const errors = [];

  for (const link of links) {
    const url = link.url ?? definitions.get(link.identifier);
    if (!url) {
      errors.push(`${path}: unresolved link reference ${link.identifier}`);
      continue;
    }
    if (/^(?:https?:|mailto:)/i.test(url)) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
      errors.push(`${path}: unsupported link scheme`);
      continue;
    }
    try {
      const parsed = new URL(url, 'https://local.invalid/');
      const localPath = decodeURIComponent(url.split(/[?#]/, 1)[0]);
      const target = localPath ? resolve(dirname(resolve(root, path)), localPath) : resolve(root, path);
      const rel = relative(root, target);
      if (isAbsolute(localPath) || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
        errors.push(`${path}: link escapes repository`);
      } else if (!existsSync(target)) {
        errors.push(`${path}: missing link target ${localPath}`);
      } else if (parsed.hash && target.endsWith('.md')) {
        const anchors = headingAnchors(markdownTree(readText(rel)));
        if (!anchors.has(decodeURIComponent(parsed.hash.slice(1)))) {
          errors.push(`${path}: missing heading ${parsed.hash}`);
        }
      }
    } catch {
      errors.push(`${path}: invalid relative link`);
    }
  }
  return errors;
}
