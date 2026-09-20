// 严格 JSON 解析（R8）：拒绝重复键（含嵌套），防止后出现的重复属性覆盖模型结构字段。
// 基于 jsonc-parser 的 visit（与 protocol/validation.mjs 同语义），供运行时使用。
import { visit } from 'jsonc-parser';

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

export function strictJsonParse(text: string): unknown {
  const keyStack: Array<Set<string>> = [];
  try {
    visit(text, {
      onObjectBegin() {
        keyStack.push(new Set<string>());
      },
      onObjectProperty(property: string) {
        const keys = keyStack.at(-1);
        if (!keys) throw new StrictJsonError('property outside object');
        if (keys.has(property)) {
          throw new StrictJsonError(`duplicate property: ${property}`);
        }
        keys.add(property);
      },
      onObjectEnd() {
        keyStack.pop();
      },
      onError() {
        throw new StrictJsonError('invalid JSON syntax');
      },
    }, { disallowComments: true, allowTrailingComma: false });
  } catch (error) {
    if (error instanceof StrictJsonError) throw error;
    throw new StrictJsonError('invalid JSON syntax');
  }
  return JSON.parse(text) as unknown;
}
