import { execFile } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { EvalError } from './core.js';

export async function resources() {
  let gpu: { name: string; totalMiB: number; freeMiB: number } | null = null;
  try {
    const { stdout } = await promisify(execFile)('nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length === 1) {
      const [name, total, free] = lines[0]!.split(',').map(s => s.trim());
      const totalMiB = Number(total); const freeMiB = Number(free);
      if (name && Number.isFinite(totalMiB) && Number.isFinite(freeMiB) && totalMiB > 0 && freeMiB >= 0 && freeMiB <= totalMiB)
        gpu = { name, totalMiB, freeMiB };
    }
  } catch { /* Unknown resources must never be treated as sufficient. */ }
  return { at: new Date().toISOString(), gpu, freeRamBytes: freemem(), totalRamBytes: totalmem(), processRssBytes: process.memoryUsage().rss };
}

export function resourceGate(sample: Awaited<ReturnType<typeof resources>>, weightBytes: number, loaded: { digest: unknown; size: unknown; sizeVram: unknown }[]) {
  // Conservative pre-load guard, not a claim that this amount guarantees success.
  const fullyLoaded = loaded.some(m => typeof m.size === 'number' && typeof m.sizeVram === 'number' && m.sizeVram >= m.size);
  const requiredMiB = fullyLoaded ? 1024 : Math.ceil(weightBytes / 1024 ** 2) + 2048;
  if (!sample.gpu || sample.gpu.freeMiB < requiredMiB || sample.freeRamBytes < 8 * 1024 ** 3)
    throw new EvalError('RESOURCE_NOT_READY');
  return { requiredMiB, fullyLoaded };
}

export function startResourceSampling(read = resources, intervalMs = 1000) {
  const samples: Awaited<ReturnType<typeof resources>>[] = [];
  let pending: Promise<void> = Promise.resolve();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    pending = read().then(value => { samples.push(value); }).finally(() => { busy = false; });
  }, intervalMs);
  return async () => {
    clearInterval(timer);
    await pending;
    const known = samples.filter(s => s.gpu !== null);
    return { intervalMs, samples, sampledPeakGpuUsedMiB: known.length
      ? Math.max(...known.map(s => s.gpu!.totalMiB - s.gpu!.freeMiB)) : null,
    sampledPeakSystemUsedRamBytes: samples.length ? Math.max(...samples.map(s => s.totalRamBytes - s.freeRamBytes)) : null,
    sampledPeakProcessRssBytes: samples.length ? Math.max(...samples.map(s => s.processRssBytes)) : null,
    limitation: 'Samples include other processes; short peaks between samples may be missed.' };
  };
}
