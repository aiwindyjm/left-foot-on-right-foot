// 协调模型服务：理解 A 回复（唯一职责），输出经契约校验。
// 生产模式用 OllamaCoordinationModel（真实客户端）；模拟模式的假模型服务
// 是测试依赖，由桌面宿主在 simulated 模式注入相同接口实现，不进入生产兜底。
import { OllamaClient, OllamaHttpError, OllamaProtocolError, OllamaTimeoutError, OllamaUnreachableError } from './client.js';
import { strictJsonParse } from '../shared/strict-json.js';
import { understandSystemPrompt, understandUserPrompt } from './prompts.js';
import {
  ModelError,
  nextPromptMatchesSource,
  parseUnderstandOutcome,
  understandOutcomeSchema,
  type UnderstandInput,
  type UnderstandOutcome,
} from '../shared/ai-contract.js';

export interface CoordinationModel {
  readonly name: string;
  readonly endpoint: string;
  understand(input: UnderstandInput, timeoutMs: number, signal?: AbortSignal): Promise<UnderstandOutcome>;
  /** 可选健康检查：返回可用模型名列表。 */
  health?(timeoutMs: number): Promise<string[]>;
}

export class OllamaCoordinationModel implements CoordinationModel {
  private readonly client: OllamaClient;

  constructor(
    readonly endpoint: string,
    readonly name: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new OllamaClient(endpoint, fetchImpl);
  }

  async understand(input: UnderstandInput, timeoutMs: number, signal?: AbortSignal): Promise<UnderstandOutcome> {
    let content: string;
    try {
      const response = await this.client.chat(
        {
          model: this.name,
          messages: [
            { role: 'system', content: understandSystemPrompt() },
            { role: 'user', content: understandUserPrompt(input) },
          ],
          format: understandOutcomeSchema as unknown as Record<string, unknown>,
          options: { temperature: 0.1, num_ctx: 8192, num_predict: 1536 },
          timeoutMs,
          signal,
        },
      );
      content = response.content;
    } catch (error) {
      throw mapTransportError(error, timeoutMs);
    }
    let parsedJson: unknown;
    try {
      parsedJson = strictJsonParse(content);
    } catch {
      throw new ModelError('MODEL_INVALID_OUTPUT', `model returned non-JSON or duplicate-key content (${content.slice(0, 200)})`);
    }
    const outcome = parseUnderstandOutcome(parsedJson);
    if (outcome.kind === 'evaluation' && !nextPromptMatchesSource(outcome, input.reply)) {
      throw new ModelError(
        'MODEL_INVALID_OUTPUT',
        'extracted nextPrompt is not a verbatim substring of the evaluator reply; refusing paraphrase',
      );
    }
    return outcome;
  }

  async health(timeoutMs: number): Promise<string[]> {
    return this.client.listModels(timeoutMs);
  }
}

function mapTransportError(error: unknown, timeoutMs: number): ModelError {
  if (error instanceof OllamaTimeoutError) {
    return new ModelError('MODEL_TIMEOUT', `${error.message} (limit ${timeoutMs}ms)`);
  }
  if (error instanceof OllamaUnreachableError) {
    return new ModelError('MODEL_UNREACHABLE', error.message);
  }
  if (error instanceof OllamaProtocolError) {
    return new ModelError('MODEL_REJECTED', error.message);
  }
  if (error instanceof OllamaHttpError) {
    return new ModelError('MODEL_REJECTED', error.message);
  }
  return new ModelError('MODEL_UNREACHABLE', error instanceof Error ? error.message : String(error));
}
