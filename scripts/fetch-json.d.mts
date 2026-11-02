export class CouldNotCheck extends Error {}
export function fetchJson(
  url: string,
  init?: RequestInit,
  options?: { attempts?: number; retryDelayMs?: number }
): Promise<{ status: number; body: any }>;
