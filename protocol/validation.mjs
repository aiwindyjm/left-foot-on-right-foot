import { visit } from 'jsonc-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';

// Shared strict decoding for fixtures and isolated evaluation, never a dispatcher.
export function readStrictJson(text) {
  const objects = [];
  visit(text, {
    onObjectBegin() { objects.push(new Set()); },
    onObjectProperty(key) {
      const keys = objects.at(-1);
      if (keys.has(key)) throw new Error('Duplicate JSON property');
      keys.add(key);
    },
    onObjectEnd() { objects.pop(); },
    onError() { throw new Error('Invalid JSON syntax'); },
  }, { disallowComments: true, allowTrailingComma: false });
  return JSON.parse(text);
}

export const schema = readStrictJson(readFileSync(new URL('./message.schema.json', import.meta.url), 'utf8'));
export function compileSchema(value) {
  return new Ajv2020({ strict: true, allErrors: true }).compile(value);
}
export const validateMessage = compileSchema(schema);

export function validateFixture(text) {
  const value = readStrictJson(text);
  if (!validateMessage(value)) {
    throw new Error(`Invalid protocol fixture: ${JSON.stringify(validateMessage.errors)}`);
  }
  return value;
}
