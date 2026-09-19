import type { ValidateFunction } from 'ajv';
export function readStrictJson(text: string): unknown;
export const schema: Record<string, unknown>;
export function compileSchema(value: object): ValidateFunction;
export const validateMessage: ValidateFunction;
export function validateFixture(text: string): Record<string, unknown>;
