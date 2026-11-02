export function secretPieces(url: string): string[];
export function makeRedactor(urls: Array<string | undefined>): (text: string) => string;
export function redactDeep<T>(value: T, redact: (text: string) => string): T;
