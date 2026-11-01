export interface FakeRequest {
  id: unknown;
  method: string;
  params: unknown[];
  url: string;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | ((id: unknown) => string);
  error?: { code: number; message: string };
  result?: unknown;
}

export interface FakeRpc {
  url: string;
  port: number;
  requests: FakeRequest[];
  count(...methods: string[]): number;
  close(): Promise<void>;
}

export function startFakeRpc(options?: {
  upstream?: string;
  rule?: (request: FakeRequest) => FakeReply | undefined;
  path?: string;
}): Promise<FakeRpc>;

export type ShapeClass = 'retryable' | 'exhausted' | 'pruned' | 'fatal';

export interface ShapeCase {
  name: string;
  reply: FakeReply;
  hh2: ShapeClass;
  hh3: ShapeClass;
  hh2Shape: Record<string, unknown>;
  hh3Shape: Record<string, unknown>;
  requests?: number;
}

export const SHAPE_CASES: ShapeCase[];
export function requestsFor(shape: ShapeCase, kind: ShapeClass): number;
