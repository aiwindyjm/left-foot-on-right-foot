import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PROFILE, binding, createTransport, evaluate, grade, loadCases, preflight, requestFor, summary } from '../.cache/evaluation/core.js';
import { resourceGate, startResourceSampling } from '../.cache/evaluation/resources.js';
import { readStrictJson } from '../protocol/validation.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const caseSchema = readStrictJson(read('../evaluation/case.schema.json'));
const cases = loadCases(read('../evaluation/acceptance.json'), caseSchema, true);
const practice = loadCases(read('../evaluation/practice.json'), caseSchema);
const signal = () => new AbortController().signal;
function answer(c = cases[0], action = c.expected.actions[0], attempt = 1) {
  return { ...binding(c, attempt), ACTION: action, REASON: '模拟服务的固定答案，不是模型质量证据。',
    EVIDENCE: [`source-${c.id}`, ...c.expected.evidence], REQUEST: action === 'REQUEST_REVISION' ? '请规划端修订范围。' : null,
    HUMAN_GATE: action === 'HUMAN_GATE', ERROR: action === 'ERROR' ? { code: 'TEST', message: 'Test' } : null };
}
function response(content = JSON.stringify(answer()), patch = {}) {
  return { model: PROFILE.model, done: true, done_reason: 'stop', prompt_eval_count: 700, eval_count: 200,
    message: { role: 'assistant', content }, ...patch };
}
async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}`;
}
test('40 independent acceptance cases, separate practice IDs, valid labels and bounded inputs', () => {
  assert.equal(cases.length, 40);
  assert.equal(new Set(cases.map(c => c.observation)).size, 40);
  assert.ok(practice.every(p => !cases.some(c => c.id === p.id || c.observation === p.observation)));
  for (const c of [...cases, ...practice]) {
    const request = requestFor(c, 1);
    const input = JSON.parse(request.messages[1].content);
    assert.equal(input.expected, undefined);
    assert.equal(input.group, undefined);
    assert.equal(grade(c, 1, JSON.stringify(answer(c))).correct, true);
  }
});
test('case schema rejects unknown fields, duplicate IDs, bad refs and wrong counts', () => {
  for (const mutate of [v => { v[0].extra = true; }, v => { v[1].id = v[0].id; },
    v => { v[0].expected.evidence = ['missing']; }, v => { v.pop(); },
    v => { v[0].evidence.push(v[0].evidence[0]); }, v => { v[1].expected.actions = ['DISPATCH_TASK']; }]) {
    const value = structuredClone(cases); mutate(value);
    assert.throws(() => loadCases(JSON.stringify(value), caseSchema, true));
  }
});
test('grading rejects wrappers, duplicate keys, wrong bindings and invented evidence', () => {
  const valid = JSON.stringify(answer());
  for (const invalid of [`text ${valid}`, `\`\`\`json\n${valid}\n\`\`\``, valid + valid,
    valid.replace('"TYPE":"DECISION"', '"TYPE":"TASK","TYPE":"DECISION"'),
    JSON.stringify({ ...answer(), SESSION_ID: 'wrong' }), JSON.stringify({ ...answer(), REVIEW: 'REPORT' }),
    JSON.stringify({ ...answer(), EVIDENCE: ['invented'] }), JSON.stringify({ ...answer(), MESSAGE_ID: 'other' })]) {
    assert.throws(() => grade(cases[0], 1, invalid));
  }
});
test('legal but wrong action and missing required evidence are failures, not repaired', () => {
  assert.equal(grade(cases[0], 1, JSON.stringify(answer(cases[0], 'PAUSE'))).correct, false);
  assert.equal(grade(cases[0], 1, JSON.stringify({ ...answer(), EVIDENCE: ['source-case-01'] })).correct, false);
});
test('incomplete and cherry-picked runs cannot pass; no automatic release approval', () => {
  const results = cases.flatMap(c => [1, 2, 3].map(attempt => ({ caseId: c.id, group: c.group, attempt,
    correct: true, elapsedMs: 100, error: null, decision: answer(c, c.expected.actions[0], attempt) })));
  assert.equal(summary(cases, [], 3).automatedPass, false);
  assert.equal(summary(cases, results.slice(1), 3).automatedPass, false);
  assert.equal(summary(cases, results, 3).automatedPass, true);
  assert.equal(summary(cases, results, 3).releaseApproved, false);
  assert.throws(() => summary(cases, [...results, results[0]], 3));
  const failed = structuredClone(results); failed.find(r => r.group === 'critical').correct = false;
  assert.equal(summary(cases, failed, 3).automatedPass, false);
  assert.equal(summary(cases, results.map(r => ({ ...r, elapsedMs: 31000 })), 3).automatedPass, false);
});
test('preflight checks identity without requesting inference', async () => {
  const routes = [];
  const values = { '/api/version': { version: PROFILE.ollama }, '/api/tags': { models: [{ name: PROFILE.model, digest: PROFILE.digest, size: 5225388164 }] }, '/api/ps': { models: [] } };
  const transport = async (route, body) => { routes.push(route); assert.equal(body, undefined); return values[route]; };
  assert.equal((await preflight(transport, signal())).model, PROFILE.model);
  assert.deepEqual(routes, ['/api/version', '/api/tags', '/api/ps']);
  values['/api/tags'].models[0].digest = 'changed';
  await assert.rejects(preflight(transport, signal()), /MODEL_MISMATCH/);
});
test('resource guard fails closed for unknown, insufficient and CPU-offloaded memory', () => {
  const ram = { freeRamBytes: 16 * 1024 ** 3 };
  assert.throws(() => resourceGate({ ...ram, gpu: null }, 5225388164, []), /RESOURCE/);
  assert.throws(() => resourceGate({ ...ram, gpu: { freeMiB: 2411 } }, 5225388164, []), /RESOURCE/);
  assert.throws(() => resourceGate({ ...ram, gpu: { freeMiB: 2411 } }, 5225388164, [{ size: 6000, sizeVram: 1000 }]), /RESOURCE/);
  assert.ok(resourceGate({ ...ram, gpu: { freeMiB: 8192 } }, 5225388164, []));
});
test('resource sampler records sampled peaks and waits for pending observation at stop', async () => {
  let calls = 0;
  const stop = startResourceSampling(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { gpu: { name: 'fake', totalMiB: 10000, freeMiB: 2000 }, totalRamBytes: 100, freeRamBytes: 40, processRssBytes: 5 };
  }, 5);
  await new Promise(resolve => setTimeout(resolve, 35));
  const result = await stop();
  assert.ok(calls > 0); assert.equal(result.samples.length, calls);
  assert.equal(result.sampledPeakGpuUsedMiB, 8000);
  assert.equal(result.sampledPeakSystemUsedRamBytes, 60);
  const count = calls; await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(calls, count);
});
test('no resource samples are not reported as zero usage', async () => {
  const stop = startResourceSampling(async () => { throw new Error('must not run'); }, 10000);
  const result = await stop(); assert.equal(result.sampledPeakGpuUsedMiB, null);
});
test('HTTP success uses only local approved route and validates generated decision', async t => {
  let count = 0;
  const origin = await server(t, async (req, res) => {
    count++; assert.equal(req.url, '/api/chat'); assert.equal(req.method, 'POST');
    let data = ''; for await (const chunk of req) data += chunk;
    const request = JSON.parse(data); assert.equal(request.think, false); assert.equal(request.stream, false);
    assert.equal(request.tools, undefined); assert.equal(request.model, PROFILE.model);
    res.end(JSON.stringify(response()));
  });
  const transport = createTransport(origin);
  assert.equal((await evaluate(cases[0], 1, transport, signal())).correct, true);
  assert.equal(count, 1);
  await assert.rejects(transport('/api/pull', {}, signal()), /ROUTE_NOT_ALLOWED/);
  assert.equal(count, 1);
});
test('cloud hosts, credentials and paths cannot configure transport', () => {
  for (const url of ['https://example.com', 'http://localhost', 'http://127.0.0.1/path', 'http://name:pass@127.0.0.1', 'http://127.0.0.1?x=1'])
    assert.throws(() => createTransport(url), /LOCAL_ENDPOINT/);
});
test('redirects are not followed', async t => {
  let targetCalls = 0;
  const target = await server(t, (_, res) => { targetCalls++; res.end('{}'); });
  const origin = await server(t, (_, res) => { res.writeHead(302, { Location: target }); res.end(); });
  await assert.rejects(createTransport(origin)('/api/version', undefined, signal()), /CONNECTION_FAILED/);
  assert.equal(targetCalls, 0);
});
test('body size and total response deadline are enforced without retry', async t => {
  let count = 0;
  const origin = await server(t, (_, res) => { count++; res.end('x'.repeat(500)); });
  await assert.rejects(createTransport(origin, 1000, 100)('/api/version', undefined, signal()), /RESPONSE_TOO_LARGE/);
  assert.equal(count, 1);
  const slow = await server(t, (_, res) => { res.writeHead(200); res.write('{'); });
  await assert.rejects(createTransport(slow, 100)('/api/version', undefined, signal()), /TIMEOUT/);
});
test('manual cancellation aborts before sending and while waiting', async t => {
  let count = 0;
  const origin = await server(t, (_, res) => { count++; res.writeHead(200); res.write('{'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createTransport(origin)('/api/version', undefined, controller.signal), /CANCELLED/);
  assert.equal(count, 0);
  const waiting = new AbortController();
  const timer = setTimeout(() => waiting.abort(), 100);
  try { await assert.rejects(createTransport(origin)('/api/version', undefined, waiting.signal), /CANCELLED/); }
  finally { clearTimeout(timer); }
});
test('malformed HTTP, bad UTF8, HTTP errors and disconnection fail closed', async t => {
  for (const body of ['{"x":1,"x":2}', 'prefix{}', Buffer.from([0xff])]) {
    const origin = await server(t, (_, res) => res.end(body));
    await assert.rejects(createTransport(origin)('/api/version', undefined, signal()), /INVALID_HTTP_JSON/);
  }
  const origin = await server(t, (_, res) => { res.writeHead(500); res.end('private error'); });
  await assert.rejects(createTransport(origin)('/api/version', undefined, signal()), /HTTP_FAILURE/);
  const disconnected = await server(t, req => req.socket.destroy());
  await assert.rejects(createTransport(disconnected)('/api/version', undefined, signal()), /CONNECTION_FAILED/);
});
test('unfinished generations, limits, wrong model and tool calls cannot become valid results', async () => {
  for (const patch of [{ done: false }, { done_reason: 'length' }, { model: 'another-model' },
    { prompt_eval_count: 8000 }, { eval_count: 1536 }, { eval_count: 0 },
    { message: { role: 'assistant', content: JSON.stringify(answer()), tool_calls: [] } }]) {
    await assert.rejects(evaluate(cases[0], 1, async () => response(undefined, patch), signal()));
  }
  const c = structuredClone(cases[0]); c.observation = 'x'.repeat(10000);
  let called = false;
  await assert.rejects(evaluate(c, 1, async () => { called = true; }, signal()), /INPUT_TOO_LARGE/);
  assert.equal(called, false);
});
test('CLI rejects accidental arbitrary endpoints before touching any service', () => {
  const result = spawnSync(process.execPath, ['.cache/evaluation/cli.js', 'practice', '--endpoint=https://example.com'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /INVALID_ARGUMENTS/);
});
