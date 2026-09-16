import { visit } from 'jsonc-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import { readText } from './repository.mjs';

// Tooling-only validation of static fixtures; this is not a runtime transport parser.
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

export const schema = readStrictJson(readText('protocol/message.schema.json'));
export const validateMessage = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

export function validateFixture(text) {
  const value = readStrictJson(text);
  if (!validateMessage(value)) {
    throw new Error(`Invalid protocol fixture: ${JSON.stringify(validateMessage.errors)}`);
  }
  return value;
}
