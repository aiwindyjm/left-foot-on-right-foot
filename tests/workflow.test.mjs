import assert from 'node:assert/strict';
import test from 'node:test';
import { readText } from '../scripts/repository.mjs';
import { readStrictJson, schema } from '../scripts/fixture-validation.mjs';
import { markdownTree, nodes, plainText } from '../scripts/markdown.mjs';

const model = readStrictJson(readText('docs/workflow-model.json'));
const states = Object.keys(model.states);

test('state graph is closed, connected and has the required states', () => {
  assert.deepEqual(new Set(states), new Set([
    'IDLE', 'AGENT_RUNNING', 'AGENT_WAITING', 'CAPTURE_REPORT', 'SEND_TO_PLANNER',
    'PLANNER_THINKING', 'PLANNER_DONE', 'PARSE_TASK', 'SEND_TO_AGENT',
    'SUPERVISE_REPORT', 'SUPERVISE_PLAN',
    'HUMAN_GATE', 'ERROR', 'COMPLETED', 'PAUSED',
  ]));
  const reached = new Set();
  const pending = [model.initial];
  while (pending.length) {
    const state = pending.pop();
    if (reached.has(state)) continue;
    assert.ok(Object.hasOwn(model.states, state), state);
    reached.add(state);
    assert.equal(new Set(model.states[state]).size, model.states[state].length);
    pending.push(...model.states[state]);
  }
  assert.deepEqual(reached, new Set(states));
  assert.deepEqual(model.terminal, ['COMPLETED']);
  assert.deepEqual(model.states.COMPLETED, []);
});

test('Markdown transition declarations match the model exactly', () => {
  const declared = {};
  let state;
  for (const node of markdownTree(readText('docs/workflow.md')).children) {
    if (node.type === 'heading') state = plainText(node);
    if (node.type === 'paragraph' && plainText(node).startsWith('允许转移：')) {
      assert.ok(states.includes(state));
      assert.ok(!Object.hasOwn(declared, state), `Duplicate state section: ${state}`);
      declared[state] = nodes(node).filter((child) => child.type === 'inlineCode').map((child) => child.value);
    }
  }
  assert.deepEqual(declared, model.states);
});

test('every action has a documented parse destination; errors cannot directly resend', () => {
  assert.deepEqual(new Set(Object.keys(model.actionTargets)), new Set(schema.$defs.task.properties.ACTION.enum));
  for (const target of Object.values(model.actionTargets)) assert.ok(model.states.PARSE_TASK.includes(target));
  assert.equal(model.actionTargets.CONTINUE, 'SUPERVISE_PLAN');
  assert.equal(model.actionTargets.COMPLETED, 'SUPERVISE_PLAN');
  for (const state of ['ERROR', 'HUMAN_GATE', 'PAUSED']) {
    assert.equal(model.states[state].includes('SEND_TO_AGENT'), false);
  }
});

test('dispatch and completion cannot bypass local plan supervision', () => {
  for (const target of ['SEND_TO_AGENT', 'COMPLETED']) {
    const predecessors = states.filter((state) => model.states[state].includes(target));
    assert.deepEqual(predecessors, ['SUPERVISE_PLAN']);
  }
  assert.deepEqual(states.filter((state) => model.states[state].includes('SEND_TO_PLANNER')),
    ['SUPERVISE_REPORT', 'SUPERVISE_PLAN']);
  assert.ok(model.states.CAPTURE_REPORT.includes('SUPERVISE_REPORT'));
  assert.deepEqual(model.supervisionRules, {
    localModelUnavailable: 'ERROR', invalidDecision: 'ERROR', evidenceMismatch: 'ERROR',
    staleDecision: 'ERROR', bypassSupervisor: false, cloudFallback: false,
  });
});

test('decision actions map to permitted supervision transitions', () => {
  const actions = new Set();
  for (const [review, targets] of Object.entries(model.decisionTargets)) {
    const state = review === 'PLAN' ? 'SUPERVISE_PLAN' : 'SUPERVISE_REPORT';
    for (const [action, target] of Object.entries(targets)) {
      actions.add(action);
      assert.ok(model.states[state].includes(target));
    }
  }
  assert.deepEqual(actions, new Set(schema.$defs.decision.properties.ACTION.enum));
  assert.equal(model.decisionTargets.PLAN.REQUEST_REVISION, 'SEND_TO_PLANNER');
  assert.equal(model.decisionTargets.PLAN.DISPATCH_TASK, 'SEND_TO_AGENT');
  assert.equal(model.decisionTargets.REPORT.FORWARD_REPORT, 'SEND_TO_PLANNER');
});

test('delivery policy is fail-closed (static contract, not a runtime implementation)', () => {
  assert.deepEqual(model.deliveryRules, {
    sameIdSameContent: 'IGNORE_DUPLICATE',
    sameIdDifferentContent: 'HUMAN_GATE',
    contextMismatch: 'ERROR',
    replyMismatch: 'ERROR',
    unknownDelivery: 'HUMAN_GATE',
  });
});
