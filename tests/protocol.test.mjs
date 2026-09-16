import assert from 'node:assert/strict';
import test from 'node:test';
import { readText } from '../scripts/repository.mjs';
import { readStrictJson, schema, validateFixture, validateMessage } from '../scripts/fixture-validation.mjs';

const examples = readStrictJson(readText('protocol/examples.json'));
const invalid = readStrictJson(readText('tests/fixtures/invalid-messages.json'));

for (const message of examples) {
  test(`valid static message: ${message.MESSAGE_ID}`, () => {
    assert.deepEqual(validateFixture(JSON.stringify(message)), message);
  });
}

test('examples cover every action and both message types', () => {
  assert.deepEqual(new Set(examples.filter((m) => m.TYPE === 'TASK').map((m) => m.ACTION)),
    new Set(schema.$defs.task.properties.ACTION.enum));
  assert.deepEqual(new Set(examples.map((m) => m.TYPE)), new Set(['TASK', 'REPORT']));
  assert.equal(new Set(examples.map((m) => m.MESSAGE_ID)).size, examples.length);
});

for (const fixture of invalid) {
  test(`invalid static message: ${fixture.name}`, () => {
    const value = { ...structuredClone(examples[fixture.base]), ...fixture.patch };
    for (const key of fixture.remove ?? []) delete value[key];
    assert.equal(validateMessage(value), false);
  });
}

const valid = JSON.stringify(examples[0]);
const malformed = [
  ['natural language prefix', `Here is the task:\n${valid}`],
  ['natural language suffix', `${valid}\nContinue now.`],
  ['Markdown fence', `\`\`\`json\n${valid}\n\`\`\``],
  ['multiple objects', `${valid}\n${valid}`],
  ['array envelope', `[${valid}]`],
  ['null envelope', 'null'],
  ['primitive envelope', '"CONTINUE"'],
  ['truncated object', valid.slice(0, -1)],
  ['comments', `/* task */ ${valid}`],
  ['trailing comma', `${valid.slice(0, -1)},}`],
  ['BOM', `\uFEFF${valid}`],
  ['duplicate property', valid.replace('"TYPE":"TASK"', '"TYPE":"REPORT","TYPE":"TASK"')],
  ['escaped duplicate property', valid.replace('"TYPE":"TASK"', '"TYPE":"REPORT","\\u0054YPE":"TASK"')],
  ['nested duplicate property', JSON.stringify(examples[6]).replace('"code":"INCOMPLETE_EVIDENCE"', '"code":"X","code":"INCOMPLETE_EVIDENCE"')],
];
for (const [name, text] of malformed) {
  test(`reject transport fixture: ${name}`, () => assert.throws(() => validateFixture(text)));
}

test('JSON whitespace is allowed; independent objects may reuse keys', () => {
  assert.deepEqual(validateFixture(` \n${valid}\r\n`), examples[0]);
  assert.deepEqual(readStrictJson('[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }]);
});

test('future provider identifiers are not vendor-whitelisted', () => {
  const message = { ...examples[0], AGENT: 'another-agent' };
  assert.equal(validateMessage(message), true);
});

test('example replies refer to existing messages of the other type', () => {
  const byId = new Map(examples.map((message) => [message.MESSAGE_ID, message]));
  for (const message of examples) {
    if (message.IN_REPLY_TO === null) {
      assert.equal(message.TYPE, 'TASK');
      continue;
    }
    const previous = byId.get(message.IN_REPLY_TO);
    assert.ok(previous);
    assert.notEqual(previous.TYPE, message.TYPE);
    for (const key of ['SESSION_ID', 'AGENT', 'STAGE']) assert.equal(message[key], previous[key]);
  }
});
