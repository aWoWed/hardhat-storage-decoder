export const ANVIL_NO_PERSISTED_STATES: string[];
export const LOCAL_CHAIN_ID: number;
export const LOCAL_ANVIL_PORT: string;

export interface TransactionFields {
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
}

export interface Receipt {
  status: string;
  blockNumber: string;
  contractAddress: string | null;
}

export function jsonRpc(url: string, method: string, params?: unknown[]): Promise<any>;
export function waitForNode(url: string, attempts?: number, delayMs?: number): Promise<boolean>;
export function sendFromNode(url: string, from: string, fields: TransactionFields): Promise<Receipt>;
export function waitForReceipt(url: string, hash: string): Promise<Receipt>;
export function startProcess(
  command: string,
  args: string[],
  url: string,
  options?: { attempts?: number; cleanup?: () => void }
): Promise<{ url: string; stop: () => Promise<void> } | undefined>;
