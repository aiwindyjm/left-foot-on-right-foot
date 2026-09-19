import { mkdir, readFile, realpath, lstat, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PROFILE, PROMPT_VERSION, EvalError, createTransport, evaluate, hash, loadCases, object, preflight, summary } from './core.js';
import type { Result } from './core.js';
import { resources, resourceGate, startResourceSampling } from './resources.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const mode = args[0];
const flags = args.slice(1);
const knownFlags = ['--allow-local-inference', '--resources-ready', '--cases-reviewed'];
const abort = new AbortController();
process.once('SIGINT', () => { console.error('已取消本地等待，不会派发任务；不代表推理服务已经停止。'); abort.abort(); });

async function privateOutput() {
  const base = await realpath(root);
  let path = base;
  for (const segment of ['.local', 'evaluation']) {
    path = join(path, segment);
    try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new EvalError('UNSAFE_OUTPUT_PATH');
  }
  path = join(path, randomUUID());
  await mkdir(path, { mode: 0o700 });
  return path;
}

async function main() {
  if (!['preflight', 'practice', 'acceptance'].includes(mode ?? '') || flags.some(f => !knownFlags.includes(f))
    || new Set(flags).size !== flags.length) throw new EvalError('INVALID_ARGUMENTS');
  const caseSchema = object(JSON.parse(await readFile(join(root, 'evaluation/case.schema.json'), 'utf8')));
  const practice = loadCases(await readFile(join(root, 'evaluation/practice.json'), 'utf8'), caseSchema);
  const cases = mode === 'acceptance'
    ? loadCases(await readFile(join(root, 'evaluation/acceptance.json'), 'utf8'), caseSchema, true) : practice;
  // This CLI deliberately cannot select an arbitrary service or user-data input.
  const transport = createTransport('http://127.0.0.1:11434');
  const readOnly = createTransport('http://127.0.0.1:11434', 5000);
  const environment = await preflight(readOnly, abort.signal);
  const sample = await resources();
  const path = await privateOutput();
  const record = { mode, profile: PROFILE, promptVersion: PROMPT_VERSION, caseSetHash: hash(cases),
    schemaHash: hash(await readFile(join(root, 'protocol/message.schema.json'), 'utf8')),
    implementationHash: hash(await readFile(new URL('./core.js', import.meta.url), 'utf8')),
    startedAt: new Date().toISOString(), environment, resourceBefore: sample, sendsToAgents: 0, sendsToPlanners: 0 };
  await writeFile(join(path, 'manifest.json'), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`记录目录：.local/evaluation/${path.split(/[\\/]/).at(-1)}`);
  console.log(`模型服务 ${environment.version}；权重 ${Math.round(environment.weightBytes / 1024 ** 2)} MiB；空闲显存 ${sample.gpu?.freeMiB ?? '未知'} MiB。`);
  const expectedLoaded = environment.loaded.filter(m => m.digest === PROFILE.digest);
  try { resourceGate(sample, environment.weightBytes, expectedLoaded); }
  catch (error) {
    await writeFile(join(path, 'summary.json'), JSON.stringify({ status: 'BLOCKED', reason: 'RESOURCE_NOT_READY', inferenceCalls: 0, releaseApproved: false }, null, 2), { flag: 'wx', mode: 0o600 });
    throw error;
  }
  if (mode === 'preflight') {
    await writeFile(join(path, 'summary.json'), JSON.stringify({ status: 'READY_FOR_EVALUATION', inferenceCalls: 0,
      releaseApproved: false }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('只读预检结束，未加载模型。资源初筛通过不代表运行或质量达标。');
    return;
  }
  if (!flags.includes('--allow-local-inference') || !flags.includes('--resources-ready')
    || (mode === 'acceptance' && !flags.includes('--cases-reviewed'))) throw new EvalError('EXPLICIT_CONFIRMATION_REQUIRED');
  const repeats = 3;
  const results: Result[] = [];
  const file = await open(join(path, 'results.jsonl'), 'wx', 0o600);
  const runSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(60 * 60 * 1000)]);
  let status = 'INCOMPLETE';
  let stopReason: string | null = null;
  const stopSampling = startResourceSampling();
  try {
    const warmup = await evaluate(practice[0]!, 0, transport, runSignal);
    await writeFile(join(path, 'warmup.json'), JSON.stringify(warmup, null, 2), { flag: 'wx', mode: 0o600 });
    for (const c of cases) {
      for (let attempt = 1; attempt <= repeats; attempt++) {
        runSignal.throwIfAborted();
        const current = await preflight(readOnly, runSignal);
        const before = await resources();
        const loaded = current.loaded.filter(m => m.digest === PROFILE.digest);
        if (!loaded.some(m => typeof m.size === 'number' && typeof m.sizeVram === 'number' && m.sizeVram >= m.size))
          throw new EvalError('GPU_OFFLOAD_OR_UNLOADED');
        resourceGate(before, current.weightBytes, loaded);
        const start = performance.now();
        let value: Awaited<ReturnType<typeof evaluate>>;
        try {
          value = await evaluate(c, attempt, transport, runSignal);
        } catch (error) {
          const result: Result = { caseId: c.id, group: c.group, attempt, correct: false,
            elapsedMs: Math.round(performance.now() - start), error: error instanceof EvalError ? error.code : 'LOCAL_FAILURE', decision: null };
          results.push(result);
          await file.write(JSON.stringify(result) + '\n'); await file.sync();
          throw error;
        }
        const result = { ...value, caseId: c.id, group: c.group, attempt, error: null };
        results.push(result);
        await file.write(JSON.stringify({ ...result, resourceBefore: before, resourceAfter: await resources() }) + '\n');
        await file.sync();
        console.log(`${c.id} 第${attempt}次：${value.correct ? '动作及引用符合预期' : '不符合预期'}，${value.elapsedMs}ms；理由仍须人工复核。`);
      }
    }
    status = 'FINISHED';
  } catch (error) {
    stopReason = error instanceof EvalError ? error.code : runSignal.aborted ? 'CANCELLED_OR_RUN_LIMIT' : 'LOCAL_FAILURE';
    throw error;
  } finally {
    const resourceSamples = await stopSampling();
    await file.close();
    const report = { ...summary(cases, results, repeats), status, stopReason, mode, resourceAfter: await resources(),
      resourceSamples, realWorldAdaptation: 'NOT_TESTED', sendsToAgents: 0, sendsToPlanners: 0 };
    report.automatedPass = status === 'FINISHED' && report.automatedPass;
    await writeFile(join(path, 'summary.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    if (!report.automatedPass) process.exitCode = 2;
    console.log('结果已保存。自动评分不是语义审查或上岗批准，没有向两端发送任务。');
  }
}
main().catch(error => {
  console.error(`评估停止：${error instanceof EvalError ? error.code : 'LOCAL_FAILURE'}。未启用真实任务发送。`);
  process.exitCode = 2;
});
