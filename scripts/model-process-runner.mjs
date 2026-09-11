import { spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

export class ModelProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ModelProcessError';
    Object.assign(this, details);
  }
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try {
        child.kill(signal);
      } catch (fallbackError) {
        if (fallbackError.code !== 'ESRCH') throw fallbackError;
      }
    }
  }
}

function appendBounded(chunks, chunk, state, limit) {
  const remaining = limit - state.bytes;
  if (remaining <= 0) return false;
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(accepted);
  state.bytes += accepted.length;
  return accepted.length === chunk.length;
}

export function runModelProcess(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 90_000);
  const terminationGraceMs = Number(options.terminationGraceMs ?? 1_500);
  const maxStdoutBytes = Number(options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const maxStderrBytes = Number(options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let forcedReason = null;
    let killTimer = null;

    const timeoutTimer = setTimeout(() => {
      forcedReason = 'model_timeout';
      terminateProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), terminationGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const forceOutputLimit = () => {
      if (forcedReason) return;
      forcedReason = 'model_output_limit_exceeded';
      terminateProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), terminationGraceMs);
      killTimer.unref?.();
    };

    child.stdout.on('data', (chunk) => {
      if (!appendBounded(stdout, chunk, stdoutState, maxStdoutBytes)) forceOutputLimit();
    });
    child.stderr.on('data', (chunk) => {
      if (!appendBounded(stderr, chunk, stderrState, maxStderrBytes)) forceOutputLimit();
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(new ModelProcessError('Unable to start model process', {
        code: error.code || 'model_process_spawn_failed',
        cause: error,
        pid: child.pid || null,
      }));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      const result = {
        code,
        signal,
        pid: child.pid,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (forcedReason) {
        reject(new ModelProcessError(`Model process terminated: ${forcedReason}`, {
          ...result,
          code: forcedReason,
        }));
        return;
      }
      if (code !== 0) {
        reject(new ModelProcessError('Model process exited unsuccessfully', {
          ...result,
          code: 'model_process_failed',
        }));
        return;
      }
      resolve(result);
    });

    if (options.input === undefined || options.input === null) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
