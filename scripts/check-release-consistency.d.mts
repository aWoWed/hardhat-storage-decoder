export const RELEASE_VERSION: string;
export function checkConsistency(
  expected: string,
  read: (file: string) => string | undefined
): { version: Array<{ file: string; found: string | null; message: string }>; docs: string[] };
