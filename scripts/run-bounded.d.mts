export function killProcessTree(pid: number): boolean;
export function runBounded(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    timeoutMs: number;
    graceMs?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    killTree?: (pid: number) => boolean;
  }
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean; killFailed: boolean }>;
