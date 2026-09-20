// 假模型服务（测试/模拟模式专用，不进入生产路径）：
// 以真实 Ollama /api/chat、/api/tags HTTP 协议应答，让真实 OllamaClient
// 与契约校验代码全链路参与；"理解"由确定性规则从 A 回复原文提取。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeModelBehavior {
  /** 基础故障注入（测试）：'http500' | 'invalid-json' | 'empty' | 'paraphrase' | 'no-total' */
  fault?: 'http500' | 'invalid-json' | 'empty' | 'paraphrase' | 'no-total';
  delayMs?: number;
  /** R8 边界注入：响应头立即返回、正文延迟 bodyDelayMs 后再发。 */
  bodyDelayMs?: number;
  /** R8 边界注入：正文超过 bigBodyBytes（默认 20MB）。 */
  bigBodyBytes?: number;
  /** R8 边界注入：500 错误响应携带超大正文（errorBigBodyBytes）。 */
  errorBigBodyBytes?: number;
  /** R8 边界注入：done=false（截断生成）。 */
  doneFalse?: boolean;
  /** R8 边界注入：响应 model 字段与请求不符。 */
  modelMismatch?: boolean;
  /** R8 边界注入：message.content 为含重复键的 JSON。 */
  duplicateKey?: boolean;
}

interface ChatBody {
  messages?: Array<{ role?: unknown; content?: unknown }>;
}

export type FakeExtraction =
  | { kind: 'evaluation'; totalCompleteness: number; basis: string; missingItems: string[]; nextPrompt: string | null }
  | { kind: 'clarify'; question: string };

/** 从 A 回复原文确定性提取（模拟”本地模型理解”）。 */
export function extractFromReply(reply: string): FakeExtraction {
  const totalMatch = reply.match(/总体完成度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/)
    ?? reply.match(/完成度[^\d\n]{0,8}(\d+(?:\.\d+)?)\s*%/);
  if (!totalMatch) {
    return { kind: 'clarify', question: '请明确给出本轮总体完成度（0-100% 的单一数字）。' };
  }
  const total = Number(totalMatch[1] ?? '0');
  const basisMatch = reply.match(/(?:评估依据|依据)\s*[:：]\s*(.+)/);
  const promptMatch = reply.match(/「([^」]+)」/);
  const missing: string[] = [];
  const missingBlock = reply.match(/缺项\s*[:：]?\s*\n([\s\S]*?)(?:\n\s*\n|\n下一轮|$)/);
  const missingBody = missingBlock?.[1] ?? '';
  for (const line of missingBody.split('\n')) {
      const item = line.replace(/^\s*[-*·]\s*/, '').trim();
      if (item) missing.push(item);
    }
  return {
    kind: 'evaluation',
    totalCompleteness: total,
    basis: basisMatch?.[1]?.trim() ?? '（A 未说明依据）',
    missingItems: missing,
    nextPrompt: promptMatch?.[1] ?? null,
  };
}

export interface FakeModelServer {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
  setBehavior(behavior: FakeModelBehavior): void;
}

export async function startFakeModelServer(modelName = 'fake-qwen3:8b'): Promise<FakeModelServer> {
  let behavior: FakeModelBehavior = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const respond = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? '/';
      if (url === '/api/tags' && req.method === 'GET') {
        respond(200, { models: [{ name: modelName }] });
        return;
      }
      if (url === '/api/chat' && req.method === 'POST') {
        let body: ChatBody = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatBody;
        } catch {
          respond(400, { error: 'invalid json' });
          return;
        }
        const lastUser = [...(body.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'user' && typeof message.content === 'string');
        const lastContent = lastUser !== undefined && typeof lastUser.content === 'string' ? lastUser.content : '';
        const replyText = extractBoundedReply(lastContent);
        const sendChat = () => {
          if (behavior.fault === 'http500') {
            if (behavior.errorBigBodyBytes !== undefined && behavior.errorBigBodyBytes > 0) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.write(JSON.stringify({ error: 'injected failure' }));
              const filler = Buffer.alloc(1024, 0x78);
              let written = 0;
              const target = behavior.errorBigBodyBytes;
              const pump = () => {
                while (written < target) {
                  written += filler.length;
                  if (!res.write(filler)) {
                    res.once('drain', pump);
                    return;
                  }
                }
                res.end();
              };
              pump();
              return;
            }
            respond(500, { error: 'injected failure' });
            return;
          }
          if (behavior.fault === 'invalid-json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: { content: 'not-json{' }, done: true }));
            return;
          }
          if (behavior.fault === 'empty') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: { content: '' }, done: true }));
            return;
          }
          let extraction = extractFromReply(replyText);
          if (behavior.fault === 'no-total') {
            extraction = { kind: 'clarify', question: '请明确给出本轮总体完成度（0-100% 的单一数字）。' };
          }
          if (behavior.fault === 'paraphrase' && extraction.kind === 'evaluation') {
            extraction = {
              ...extraction,
              nextPrompt: extraction.nextPrompt !== null ? `${extraction.nextPrompt}（改写版）` : null,
            };
          }
          let contentText = JSON.stringify(extraction);
          if (behavior.duplicateKey && extraction.kind === 'evaluation') {
            // 构造重复键载荷：后一个 totalCompleteness 覆盖前者（严格解析必须拒绝）。
            contentText = `{"kind":"evaluation","totalCompleteness":95,"basis":"x","missingItems":[],"nextPrompt":null,"totalCompleteness":${extraction.totalCompleteness}}`;
          }
          const payload = {
            model: behavior.modelMismatch === true ? 'other-model:latest' : modelName,
            message: { role: 'assistant', content: contentText },
            done: behavior.doneFalse === true ? false : true,
            eval_count: 128,
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          if (behavior.bigBodyBytes !== undefined && behavior.bigBodyBytes > 0) {
            res.write(JSON.stringify(payload));
            const filler = Buffer.alloc(1024, 0x78);
            let written = 0;
            const target = behavior.bigBodyBytes;
            const pump = () => {
              while (written < target) {
                written += filler.length;
                if (!res.write(filler)) {
                  res.once('drain', pump);
                  return;
                }
              }
              res.end();
            };
            pump();
            return;
          }
          res.end(JSON.stringify(payload));
        };
        const sendWithBodyDelay = () => {
          // 先发响应头，正文按 bodyDelayMs 延迟（R8：正文阶段期限）。
          res.writeHead(200, { 'content-type': 'application/json' });
          setTimeout(() => {
            res.end(JSON.stringify({
              model: modelName,
              message: { role: 'assistant', content: JSON.stringify(extractFromReply(replyText)) },
              done: true,
              eval_count: 128,
            }));
          }, behavior.bodyDelayMs ?? 0);
        };
        if (behavior.bodyDelayMs !== undefined) {
          if (behavior.delayMs && behavior.delayMs > 0) {
            setTimeout(sendWithBodyDelay, behavior.delayMs);
          } else {
            sendWithBodyDelay();
          }
          return;
        }
        if (behavior.delayMs && behavior.delayMs > 0) {
          setTimeout(sendChat, behavior.delayMs);
        } else {
          sendChat();
        }
        return;
      }
      respond(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    setBehavior(next: FakeModelBehavior) {
      behavior = next;
    },
    close() {
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function extractBoundedReply(prompt: string): string {
  const match = prompt.match(/<<<REPLY\n([\s\S]*?)\nREPLY>>>/);
  return match?.[1] ?? '';
}
