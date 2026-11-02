/**
 * The limit on RPC calls in flight, and the settings of the retry layer.
 *
 * There is one {@link Limiter} per decoder context, shared by every call made on it, so that
 * overlapping `read()`s and a `readAll()` on one context cannot add up past the limit. Two
 * contexts on the same endpoint do not share one. The retry loop itself is in `CallScope`, in
 * `execute.ts`, since its budget belongs to one call.
 *
 * A call holds its permit until it settles and nothing here times it out, so a custom context's
 * functions must have a timeout of their own: one that never settles holds its permit for good.
 */

import type { StorageDecoderContext } from './StorageQueryBuilder.js';

/** Settings of the retry layer. Each must be a positive integer. */
export interface RetryOptions {
  /** Most times one RPC call is sent, the first included. Default 3; 1 disables retries. */
  readonly maxAttempts?: number;
  /** The backoff before the first retry is at most this, doubling after. Default 250. */
  readonly baseDelayMs?: number;
  /** No backoff is longer than this. Default 5000. */
  readonly maxDelayMs?: number;
  /**
   * Failures one `read()`, `readMany()` or `readAll()` tolerates before it stops retrying and
   * rejects its queued calls with the failure, instead of sending them. Default 32. A
   * `readMany()` mixing contexts keeps one count of failures across them, and each failure is
   * compared with the budget of its own context.
   */
  readonly budget?: number;
}

/** Options of `createStorageDecoder`. They apply to the context, not to one chain. */
export interface StorageDecoderOptions {
  /** Most RPC calls in flight on the context, backoffs included. A positive integer; default 16. */
  readonly maxConcurrentReads?: number;
  /** See {@link RetryOptions}. */
  readonly retry?: RetryOptions;
}

/**
 * Most calls one context keeps in flight unless told otherwise. A public keyless Sepolia
 * endpoint took 64 without a failure; there was no second endpoint to confirm that, and the
 * rule for choosing this default falls back to 16 in that case.
 */
const DEFAULT_MAX_CONCURRENT_READS = 16;

/** The retry settings a context has unless told otherwise. */
const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5000,
  budget: 32,
};

/** A running backoff. {@link Timer.cancel} must settle {@link Timer.elapsed} at once. */
export interface Timer {
  /** Resolves when the time is up or the timer is cancelled. */
  readonly elapsed: Promise<void>;
  /** End the wait early. Harmless once it is over. */
  cancel(): void;
}

/** Where a {@link Limiter} gets its waiting and randomness from; replaced by tests. */
export interface RetrySources {
  /** Start waiting `ms` milliseconds. */
  readonly sleep: (ms: number) => Timer;
  /** A number in `[0, 1)`, as `Math.random` gives. */
  readonly random: () => number;
}

/** Real time and real randomness. */
const DEFAULT_SOURCES: RetrySources = {
  sleep: (ms) => {
    let cancel = (): void => {};
    const elapsed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancel = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return { elapsed, cancel };
  },
  random: Math.random,
};

/**
 * A counting semaphore: at most `permits` functions passed to {@link Semaphore.run} are
 * running at any moment. Callers beyond that wait in arrival order.
 */
class Semaphore {
  /** Permits not currently held. Never negative; stays 0 while anyone is waiting. */
  #available: number;
  /** Wake-up callbacks of the callers waiting for a permit, oldest first. */
  readonly #waiting: (() => void)[] = [];

  /**
   * @param permits - How many functions may run at once.
   */
  constructor(permits: number) {
    this.#available = permits;
  }

  /**
   * Run `fn` once a permit is free, and release the permit when it settles either way.
   *
   * @param fn - The work to run under a permit. It is not called until a permit is held.
   * @returns `fn`'s result; rejects with whatever `fn` rejects with.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#available > 0) {
      this.#available -= 1;
    } else {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      // Hand the permit straight to the next waiter rather than returning it to the pool.
      if (next === undefined) this.#available += 1;
      else next();
    }
  }
}

/** The concurrency limit and retry settings of one context. */
export class Limiter {
  /** Held for a whole RPC call, including its backoffs, as Hardhat's own 429 sleep holds it. */
  readonly #semaphore: Semaphore;
  /** The retry settings in effect, defaults filled in. */
  readonly retry: Required<RetryOptions>;
  /** Where backoffs get their waiting and randomness from. */
  readonly #sources: RetrySources;

  /**
   * @param maxConcurrentReads - Most functions passed to {@link Limiter.run} running at once.
   * @param retry - The retry settings, complete.
   * @param sources - Where backoffs get their waiting and randomness from.
   */
  constructor(
    maxConcurrentReads: number,
    retry: Required<RetryOptions>,
    sources: RetrySources
  ) {
    this.#semaphore = new Semaphore(maxConcurrentReads);
    this.retry = retry;
    this.#sources = sources;
  }

  /**
   * Run `fn` under a permit.
   *
   * @param fn - The work to run. It is not called until a permit is held.
   * @returns `fn`'s result; rejects with whatever `fn` rejects with.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.#semaphore.run(fn);
  }

  /**
   * Start the wait before a retry: full jitter, up to an exponentially growing ceiling.
   *
   * @param attempt - How many times the call has been sent so far, at least 1.
   * @returns The running wait.
   */
  backoff(attempt: number): Timer {
    const { baseDelayMs, maxDelayMs } = this.retry;
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return this.#sources.sleep(Math.floor(this.#sources.random() * ceiling));
  }
}

/** Each context's limiter. Weak, so a limiter never keeps a context alive. */
const limiters = new WeakMap<StorageDecoderContext, Limiter>();

/**
 * Check one numeric option.
 *
 * @param name - The option's name, for the error.
 * @param value - The value given.
 * @param fallback - What an omitted option means.
 * @returns `value`, or `fallback` when it is `undefined`.
 * @throws {TypeError} when `value` is given and is not a positive safe integer.
 */
function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`createStorageDecoder: "${name}" must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Give a context a new limiter, replacing any it had. Calls already running finish under the
 * old one, so while they do the two limits can add up. Omitted options take their defaults, not
 * the earlier values, so `{}` resets a custom limit.
 *
 * @param context - The context the options apply to.
 * @param options - The caller's options; omitted ones take their defaults.
 * @param sources - Where backoffs get their waiting and randomness from; tests replace it.
 * @throws {TypeError} when `options` is not an object, `options.retry` is neither an object nor
 *   `null`, which is treated as omitted, or a setting is not a positive integer.
 */
export function configureLimiter(
  context: StorageDecoderContext,
  options: StorageDecoderOptions,
  sources: RetrySources = DEFAULT_SOURCES
): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createStorageDecoder: options must be an object when given');
  }
  const retry = options.retry ?? {};
  if (typeof retry !== 'object') {
    throw new TypeError('createStorageDecoder: "retry" must be an object when given');
  }
  limiters.set(
    context,
    new Limiter(
      positiveInteger('maxConcurrentReads', options.maxConcurrentReads, DEFAULT_MAX_CONCURRENT_READS),
      {
        maxAttempts: positiveInteger('retry.maxAttempts', retry.maxAttempts, DEFAULT_RETRY.maxAttempts),
        baseDelayMs: positiveInteger('retry.baseDelayMs', retry.baseDelayMs, DEFAULT_RETRY.baseDelayMs),
        maxDelayMs: positiveInteger('retry.maxDelayMs', retry.maxDelayMs, DEFAULT_RETRY.maxDelayMs),
        budget: positiveInteger('retry.budget', retry.budget, DEFAULT_RETRY.budget),
      },
      sources
    )
  );
}

/**
 * The limiter of a context, created with the defaults on first use, which is what a directly
 * constructed `new StorageQueryBuilder(context)` gets.
 *
 * @param context - The context, compared by identity.
 * @returns Its limiter.
 */
export function limiterFor(context: StorageDecoderContext): Limiter {
  let limiter = limiters.get(context);
  if (limiter === undefined) {
    limiter = new Limiter(DEFAULT_MAX_CONCURRENT_READS, DEFAULT_RETRY, DEFAULT_SOURCES);
    limiters.set(context, limiter);
  }
  return limiter;
}
