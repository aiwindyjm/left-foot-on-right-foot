// Ollama 原生 /api/chat 客户端（真实 HTTP 实现，W3/R8加固）。
// 边界（R8）：仅本机 http/https 端点、拒绝凭据；期限覆盖 headers 与正文读取全程；
// 响应体按字节流式限制（错误响应同样受限）；已取消请求不发出；
// 校验完成状态 done、模型身份与 message.content；响应 JSON 严格解析（拒绝重复键）。
import { strictJsonParse } from '../shared/strict-json.js';

export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** 结构化输出 JSON Schema（Ollama format 参数）。 */
  format?: Record<string, unknown>;
  options?: { temperature?: number; num_ctx?: number; num_predict?: number };
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface ChatResponse {
  content: string;
  done: boolean;
  evalCount: number | null;
  model: string;
}

export class OllamaHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`ollama http ${status}: ${message}`);
    this.name = 'OllamaHttpError';
  }
}

/** 响应不完整/身份不符/协议形状错误（服务侧异常，不是模型输出内容问题）。 */
export class OllamaProtocolError extends Error {
  constructor(message: string) {
    super(`ollama protocol: ${message}`);
    this.name = 'OllamaProtocolError';
  }
}

export class OllamaUnreachableError extends Error {
  constructor(message: string) {
    super(`ollama unreachable: ${message}`);
    this.name = 'OllamaUnreachableError';
  }
}

export class OllamaTimeoutError extends Error {
  constructor(detail: string) {
    super(`ollama timeout: ${detail}`);
    this.name = 'OllamaTimeoutError';
  }
}

/** 本机允许的主机名（Ollama 为本机服务；产品语义即本地推理）。 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parseEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OllamaUnreachableError(`invalid base url: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OllamaUnreachableError(`only http/https endpoints allowed: ${baseUrl}`);
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new OllamaUnreachableError(
      `endpoint must be local (got host '${url.hostname}'); remote inference is out of product boundary`,
    );
  }
  if (url.username || url.password) {
    throw new OllamaUnreachableError('endpoint must not carry credentials');
  }
  return url;
}

interface LimitedBody {
  text: string;
}

export class OllamaClient {
  private readonly base: URL;

  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = parseEndpoint(baseUrl);
  }

  /**
   * 发起请求并读取响应体。期限与取消覆盖 headers 和 body 全程：
   * 计时器在 fetch resolve 后继续生效，正文经流式读取按字节限制。
   */
  private async request(path: string, init: RequestInit, timeoutMs: number, outerSignal?: AbortSignal | undefined): Promise<{ status: number; body: LimitedBody; ok: boolean }> {
    if (outerSignal?.aborted) {
      throw new OllamaTimeoutError('aborted before request was sent');
    }
    const url = new URL(path.replace(/^\//, ''), this.base);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, timeoutMs);
    const onOuterAbort = () => controller.abort(outerSignal?.reason ?? new Error('aborted'));
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      // headers 已到；正文读取仍在同一 controller/计时器控制下。
      const limit = response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BYTES;
      const text = await readBodyLimited(response, limit, controller);
      if (timedOut) {
        throw new OllamaTimeoutError(`response not completed within ${timeoutMs}ms`);
      }
      return { status: response.status, ok: response.ok, body: { text } };
    } catch (error) {
      if (timedOut) {
        throw new OllamaTimeoutError(`not completed within ${timeoutMs}ms`);
      }
      if (outerSignal?.aborted) {
        throw new OllamaTimeoutError('aborted by caller');
      }
      if (error instanceof OllamaHttpError || error instanceof OllamaProtocolError) {
        throw error;
      }
      throw new OllamaUnreachableError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** 非流式 chat 调用；校验完成状态、模型身份与响应结构。 */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
    };
    if (request.format) body.format = request.format;
    if (request.options) body.options = request.options;
    const { status, ok, body: response } = await this.request(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      request.timeoutMs,
      request.signal,
    );
    if (!ok) {
      throw new OllamaHttpError(status, response.text.slice(0, 500));
    }
    let parsed: unknown;
    try {
      parsed = strictJsonParse(response.text);
    } catch {
      throw new OllamaProtocolError('response is not valid strict JSON');
    }
    const value = parsed as {
      model?: unknown;
      message?: { content?: unknown };
      done?: unknown;
      eval_count?: unknown;
    };
    if (typeof value.model === 'string' && value.model !== request.model) {
      throw new OllamaProtocolError(`model mismatch: requested ${request.model}, got ${value.model}`);
    }
    if (value.done !== true) {
      throw new OllamaProtocolError('generation incomplete (done=false); refusing truncated result');
    }
    if (!value || typeof value !== 'object' || typeof value.message?.content !== 'string') {
      throw new OllamaProtocolError('response missing message.content');
    }
    return {
      content: value.message.content,
      done: true,
      evalCount: typeof value.eval_count === 'number' ? value.eval_count : null,
      model: typeof value.model === 'string' ? value.model : request.model,
    };
  }

  /** 列出可用模型（健康检查/预检）。 */
  async listModels(timeoutMs: number): Promise<string[]> {
    const { status, ok, body: response } = await this.request('/api/tags', { method: 'GET' }, timeoutMs);
    if (!ok) {
      throw new OllamaHttpError(status, response.text.slice(0, 500));
    }
    const parsed = strictJsonParse(response.text) as { models?: Array<{ name?: unknown }> };
    return (parsed.models ?? [])
      .map((model) => (typeof model.name === 'string' ? model.name : ''))
      .filter((name) => name.length > 0);
  }
}

/** 流式读取响应体，按字节上限中止；不把整个超限响应载入内存。 */
async function readBodyLimited(response: Response, limitBytes: number, controller: AbortController): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limitBytes) {
        void reader.cancel().catch(() => {});
        controller.abort(new Error('response too large'));
        throw new OllamaHttpError(413, `response exceeds ${limitBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}
