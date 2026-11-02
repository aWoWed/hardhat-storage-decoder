export interface StepResult {
  status: 'pass' | 'fail' | 'could-not-check' | 'not-run';
  detail?: string;
}
export interface GateDeps {
  git(args: string[]): { status: number | null; stdout: string };
  exec(
    command: string,
    args: string[],
    options?: { quiet?: boolean; keep?: string[] }
  ): Promise<{ status: number | null; stdout: string; killFailed?: boolean }>;
  readText(file: string): string | undefined;
  writeText(file: string, text: string): void;
  clear(file: string): void;
  log(line: string): void;
  now(): string;
}
export const SEPOLIA: number;
export const BURST_SIZE: number;
export const RELEASE_BASELINE: string;
export function gateEnv(env: Record<string, string | undefined>, keep?: string[]): Record<string, string | undefined>;
export function scanText(text: string): string[];
export function evaluateReadback(status: number | null, text: string | undefined): StepResult;
export function evaluateManifest(text: string | undefined): StepResult;
export function evaluateMainnetReport(text: string | undefined, head: string, candidatesText: string | undefined): StepResult;
export function evaluateCiRuns(stdout: string, head: string): StepResult;
export function gateSteps(): Array<{ name: string; command?: string }>;
export function runGate(
  deps: GateDeps,
  options?: { preflight?: boolean }
): Promise<{
  outcome: 'pass' | 'fail' | 'could-not-check';
  exitCode: 0 | 1 | 3;
  head: string | null;
  steps: Array<{ name: string } & StepResult>;
}>;
