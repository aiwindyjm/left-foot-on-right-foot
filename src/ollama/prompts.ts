// 协调模型提示词（W3）：模型只做理解与提取，不做项目审计。
// 提示词版本独立管理；修改需同步假模型服务与测试。

export const PROMPT_VERSION = 'coordination-understand-1';

export function understandSystemPrompt(): string {
  return [
    '你是“左脚踩右脚”的本地协调模型。你的唯一职责：从评估会话 A 的本轮回复原文中提取既定字段。',
    '规则：',
    '1. totalCompleteness 只能取 A 明确给出的“总体完成度”数字（0-100，允许小数）；不得使用子任务分数、历史分数或自己的估计。',
    '2. 若回复缺少明确总体完成度、给出区间或互相矛盾的数字，返回 kind=clarify 并写出要向 A 澄清的问题。',
    '3. nextPrompt 必须是 A 给出的下一轮执行提示词的逐字引用（原样复制，不改写、不缩写）；A 未提供则为 null。',
    '4. basis 摘要 A 的评分依据；missingItems 逐条列出 A 的缺项（没有则空数组）。',
    '5. 不重评分、不增删任务、不扩大范围。严格输出 JSON。',
  ].join('\n');
}

export function understandUserPrompt(input: {
  goal: string;
  prdRef: string;
  roundIndex: number;
  reply: string;
}): string {
  return [
    `项目目标：${input.goal}`,
    `PRD 范围：${input.prdRef}`,
    `当前轮次：${input.roundIndex}`,
    '以下是评估会话 A 的本轮完整回复原文（提取范围仅限该原文）：',
    '<<<REPLY',
    input.reply,
    'REPLY>>>',
  ].join('\n');
}
