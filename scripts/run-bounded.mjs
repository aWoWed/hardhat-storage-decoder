/**
 * Runs a command with a timeout that really ends it.
 *
 * `spawn`'s own `timeout` kills only the direct child. Under a Windows shell that is `cmd.exe`, so
 * whatever it started keeps running and keeps the output pipes open, and `close` does not fire until
 * that grandchild ends. So the whole tree is killed, and the result is settled shortly after `exit`
 * instead of waiting for `close`.
 */
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_GRACE_MS = 2_000;

/** `taskkill`'s exit code for a process that does not exist. */
const TASKKILL_NOT_FOUND = 128;

/**
 * Ends a process and everything it started.
 *
 * @param {number} pid
 * @returns {boolean} True when the tree was killed or was already gone; false for a real failure.
 */
export function killProcessTree(pid) {
  if (process.platform === 'win32') {
    const { status } = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return status === 0 || status === TASKKILL_NOT_FOUND;
  }
  try {
    // The child leads its own process group, because `runBounded` starts it detached.
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.shell]
 * @param {number} options.timeoutMs
 * @param {number} [options.graceMs] - How long after `exit`, or after a kill, to wait for the output.
 * @param {(chunk: string) => void} [options.onStdout]
 * @param {(chunk: string) => void} [options.onStderr]
 * @param {(pid: number) => boolean} [options.killTree] - Replaces {@link killProcessTree} in a test.
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, timedOut: boolean, killFailed: boolean }>}
 *   `status` is null when it timed out, could not start, or died to a signal. `killFailed` means
 *   something from a timed-out run may still be running.
 */
export function runBounded(command, args, { cwd, env, shell = false, timeoutMs, graceMs = DEFAULT_GRACE_MS, onStdout, onStderr, killTree = killProcessTree }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killFailed = false;
    let exited = false;
    let settled = false;
    const timers = [];
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const settle = (status) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      // A grandchild that outlived the child can still hold these, and they would keep this process up.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ status: timedOut ? null : status, stdout, stderr, timedOut, killFailed });
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      onStderr?.(chunk);
    });
    child.on('error', () => settle(null));
    child.on('exit', (status) => {
      exited = true;
      timers.push(setTimeout(() => settle(status), graceMs));
    });
    child.on('close', (status) => settle(status));
    timers.push(
      setTimeout(() => {
        // It finished in time and only its output is still being waited for.
        if (exited) return;
        timedOut = true;
        try {
          killFailed = !killTree(child.pid);
        } catch {
          // This runs in a timer, where a throw would end the whole process with no result.
          killFailed = true;
        }
        timers.push(setTimeout(() => settle(null), graceMs));
      }, timeoutMs)
    );
  });
}
