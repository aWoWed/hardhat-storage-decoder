export function bare(hex: string): string;
export function solcAtLeast(version: string, minimum: readonly number[]): boolean;
export function encodeCall(call: { signature: string; args?: readonly (number | string)[] }): string;
export function decodeOracle(result: string, oracle: { output?: number; type: string }): string;
export function normalize(value: unknown, type: string): string;
export function isZeroValue(value: string, type: string): boolean;
