// 协调契约 v1：本地模型理解结果的结构化定义。
// 与旧 protocol/ 0.2（独立审计语义）不同：模型不重评分、不重做规划，
// 只从评估会话 A 的本轮回复中提取既定字段；程序再做确定性校验与阈值比较。
import { Ajv2020 } from 'ajv/dist/2020.js';

export const AI_CONTRACT_VERSION = '1.0';

/** 模型从 A 回复中提取出的本轮评估。totalCompleteness 是 A 的判断，不是本地重评。 */
export interface EvaluationExtraction {
  kind: 'evaluation';
  /** A 给出的总体完成度，0-100，允许小数；不得四舍五入。 */
  totalCompleteness: number;
  /** A 说明的评分依据（简要）。 */
  basis: string;
  /** A 列出的缺损项目；无则为空数组。 */
  missingItems: string[];
  /** A 给出的下一轮执行提示词，必须是回复原文的逐字引用；A 未提供时为 null。 */
  nextPrompt: string | null;
}

/** A 回复缺总分/总分矛盾/缺提示词等，模型向 A 提出的澄清请求。 */
export interface ClarifyExtraction {
  kind: 'clarify';
  question: string;
}

export type UnderstandOutcome = EvaluationExtraction | ClarifyExtraction;

/** 提供给模型理解的输入：A 的完整回复 + 固定的目标/PRD 上下文。 */
export interface UnderstandInput {
  goal: string;
  prdRef: string;
  /** A 本轮完整回复原文。 */
  reply: string;
  /** 本轮序号（从 1 开始）。 */
  roundIndex: number;
}

/** 模型客户端故障（不可用、超时、输出非法）。按 PRD 12：停止新派发并说明原因，不静默兜底。 */
export type ModelFailureCode =
  | 'MODEL_UNREACHABLE'
  | 'MODEL_TIMEOUT'
  | 'MODEL_INVALID_OUTPUT'
  | 'MODEL_REJECTED';

export class ModelError extends Error {
  constructor(
    public readonly code: ModelFailureCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ModelError';
  }
}

const minLength1 = { type: 'string', minLength: 1 } as const;

/** 结构化输出 JSON Schema（2020-12）。同一对象用于 Ollama format 与 Ajv 复核。 */
export const understandOutcomeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  oneOf: [
    {
      properties: {
        kind: { const: 'evaluation' },
        totalCompleteness: { type: 'number', minimum: 0, maximum: 100 },
        basis: minLength1,
        missingItems: { type: 'array', items: minLength1, maxItems: 100 },
        nextPrompt: { anyOf: [minLength1, { type: 'null' }] },
      },
      required: ['kind', 'totalCompleteness', 'basis', 'missingItems', 'nextPrompt'],
      additionalProperties: false,
    },
    {
      properties: {
        kind: { const: 'clarify' },
        question: minLength1,
      },
      required: ['kind', 'question'],
      additionalProperties: false,
    },
  ],
} as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });
interface RawEvaluation {
  kind: 'evaluation';
  totalCompleteness: number;
  basis: string;
  missingItems: string[];
  nextPrompt: string | null;
}
interface RawClarify {
  kind: 'clarify';
  question: string;
}
const validateOutcome = ajv.compile<RawEvaluation | RawClarify>(understandOutcomeSchema);

/** 严格校验模型输出对象；非法即抛 ModelError(MODEL_INVALID_OUTPUT)。 */
export function parseUnderstandOutcome(value: unknown): UnderstandOutcome {
  if (!validateOutcome(value)) {
    throw new ModelError(
      'MODEL_INVALID_OUTPUT',
      `schema validation failed: ${JSON.stringify(validateOutcome.errors ?? [])}`,
    );
  }
  const raw = value as RawEvaluation | RawClarify;
  if (raw.kind === 'evaluation') {
    // 有限小数安全比较：拒绝 NaN/Infinity（JSON 里也不应出现）。
    if (!Number.isFinite(raw.totalCompleteness)) {
      throw new ModelError('MODEL_INVALID_OUTPUT', 'totalCompleteness must be finite');
    }
    return {
      kind: 'evaluation',
      totalCompleteness: raw.totalCompleteness,
      basis: raw.basis,
      missingItems: [...raw.missingItems],
      nextPrompt: raw.nextPrompt,
    };
  }
  return { kind: 'clarify', question: raw.question };
}

/**
 * 确定性原文校验（PRD FR-06/7.2）：nextPrompt 必须是 A 回复原文的逐字片段。
 * 校验失败按“提取无效”处理（澄清或模型故障），绝不发送模型改写版。
 */
export function nextPromptMatchesSource(extraction: EvaluationExtraction, reply: string): boolean {
  if (extraction.nextPrompt === null) return true;
  return extraction.nextPrompt.length > 0 && reply.includes(extraction.nextPrompt);
}
