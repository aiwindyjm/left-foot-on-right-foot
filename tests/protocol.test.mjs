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

test('examples cover every task and decision action and all three message types', () => {
  assert.deepEqual(new Set(examples.filter((m) => m.TYPE === 'TASK').map((m) => m.ACTION)),
    new Set(schema.$defs.task.properties.ACTION.enum));
  assert.deepEqual(new Set(examples.filter((m) => m.TYPE === 'DECISION').map((m) => m.ACTION)),
    new Set(schema.$defs.decision.properties.ACTION.enum));
  assert.deepEqual(new Set(examples.map((m) => m.TYPE)), new Set(['TASK', 'REPORT', 'DECISION']));
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
  const message = { ...examples[0], AGENT: 'another-agent', PLANNER: 'another-planner', SUPERVISOR: 'another-local-model' };
  assert.equal(validateMessage(message), true);
});

const decisionCases = [
  ['missing reason', 'decision-dispatch', { REASON: ' ' }],
  ['missing evidence', 'decision-dispatch', { EVIDENCE: [] }],
  ['duplicate evidence', 'decision-dispatch', { EVIDENCE: ['task-002', 'task-002'] }],
  ['decision cannot be initial', 'decision-dispatch', { IN_REPLY_TO: null }],
  ['decision cannot contain an executable prompt', 'decision-dispatch', { PROMPT: 'Run this instead' }],
  ['dispatch cannot contain a revision', 'decision-dispatch', { REQUEST: 'Modify the task' }],
  ['revision needs a request', 'decision-revise', { REQUEST: null }],
  ['revision cannot be blank', 'decision-revise', { REQUEST: ' ' }],
  ['gate must be true', 'decision-gate', { HUMAN_GATE: false }],
  ['dispatch cannot claim human approval', 'decision-dispatch', { HUMAN_GATE: true }],
  ['decision error needs details', 'decision-error', { ERROR: null }],
  ['non-error rejects error details', 'decision-pause', { ERROR: { code: 'X', message: 'Failure' } }],
  ['unknown review', 'decision-dispatch', { REVIEW: 'ANYTHING' }],
  ['unknown supervisor action', 'decision-dispatch', { ACTION: 'EXECUTE_SHELL' }],
];
for (const [name, id, patch] of decisionCases) {
  test(`invalid supervision decision: ${name}`, () => {
    const message = { ...structuredClone(examples.find((m) => m.MESSAGE_ID === id)), ...patch };
    assert.equal(validateMessage(message), false);
  });
}

test('supervision scope restricts every action to its declared review type', () => {
  const allowed = {
    REPORT: ['FORWARD_REPORT', 'PAUSE', 'HUMAN_GATE', 'ERROR'],
    PLAN: ['DISPATCH_TASK', 'REQUEST_REVISION', 'PAUSE', 'HUMAN_GATE', 'COMPLETED', 'ERROR'],
  };
  for (const review of ['REPORT', 'PLAN']) {
    for (const action of schema.$defs.decision.properties.ACTION.enum) {
      const sample = examples.find((m) => m.TYPE === 'DECISION' && m.ACTION === action);
      assert.equal(validateMessage({ ...sample, REVIEW: review }), allowed[review].includes(action), `${review}: ${action}`);
    }
  }
});

test('all three message types require planner and local supervisor bindings and reject 0.1', () => {
  for (const type of ['TASK', 'REPORT', 'DECISION']) {
    const original = examples.find((m) => m.TYPE === type);
    for (const field of ['PLANNER', 'SUPERVISOR']) {
      const message = structuredClone(original);
      delete message[field];
      assert.equal(validateMessage(message), false);
    }
    assert.equal(validateMessage({ ...original, VERSION: '0.1' }), false);
  }
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
    for (const key of ['SESSION_ID', 'AGENT', 'STAGE', 'PLANNER', 'SUPERVISOR']) assert.equal(message[key], previous[key]);
    if (message.TYPE === 'DECISION') {
      assert.equal(previous.TYPE, message.REVIEW === 'PLAN' ? 'TASK' : 'REPORT');
      assert.ok(message.EVIDENCE.includes(previous.MESSAGE_ID));
      for (const ref of message.EVIDENCE) assert.ok(byId.has(ref));
      if (message.ACTION === 'DISPATCH_TASK') assert.equal(previous.ACTION, 'CONTINUE');
      if (message.ACTION === 'COMPLETED') assert.equal(previous.ACTION, 'COMPLETED');
    } else if (message.TYPE === 'REPORT') {
      assert.equal(previous.TYPE, 'TASK');
      assert.ok(examples.some((decision) => decision.TYPE === 'DECISION'
        && decision.IN_REPLY_TO === previous.MESSAGE_ID && decision.ACTION === 'DISPATCH_TASK'));
    } else if (previous.TYPE === 'DECISION') {
      assert.equal(previous.ACTION, 'REQUEST_REVISION');
    } else {
      assert.equal(previous.TYPE, 'REPORT');
    }
  }
});
