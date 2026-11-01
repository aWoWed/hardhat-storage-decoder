export const LOCAL_CHAIN: string;
export interface ValueLine {
  expression: string;
  pageValue: string;
  contract?: string;
  entry?: string;
}
export function parseValueLine(line: string): ValueLine | undefined;
export function expectedValue(line: ValueLine, chainId: string | number, manifest: unknown): string;
