import type { Receipt, TransactionFields } from '../local-node.mjs';

export type Exec = (
  command: string,
  args: string[],
  callback: (error: (Error & { code?: string | number; signal?: string }) | null, stdout: string, stderr: string) => void
) => unknown;

export function keySender(
  url: string,
  nodeAccount: string,
  exec?: Exec
): Promise<{ from: string; send: (fields: Omit<TransactionFields, 'gas'>) => Promise<Receipt> }>;
