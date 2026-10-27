import { spawn } from 'node:child_process';
import type { TestContext } from 'vitest';
import { POWERSHELL_STDIN_COMMAND, powershellInvocation } from '../../server/ops/remote';
import { PROCESS_TEST_TIMEOUT_MS } from '../setup/timeouts';

export type LocalPowerShellResult = { stdout: string; stderr: string; code: number | null };

// Runs a script in this machine's Windows PowerShell exactly as the backend
// delivers it to a Windows server: on the stdin of
// `powershell -NoProfile -NonInteractive -Command -` (powershellInvocation()),
// so nothing but that fixed command line reaches the process list. Should
// endpoint protection block PowerShell anyway, the test is skipped, not
// failed. The process is killed after the budget of the test that waits for
// it (PROCESS_TEST_TIMEOUT_MS), not before.
export function runLocalPowerShell(script: string, skip: TestContext['skip'], timeoutMs = PROCESS_TEST_TIMEOUT_MS): Promise<LocalPowerShellResult> {
    const { command, stdin } = powershellInvocation(script, 'stdin');
    if (command !== POWERSHELL_STDIN_COMMAND) throw new Error('A test script must be ASCII (psQuote spells anything else).');
    const [program, ...args] = command.split(' ');
    return new Promise((resolve, reject) => {
        let settled = false;
        const blocked = (reason: string) => {
            if (settled) return;
            settled = true;
            try {
                skip(`PowerShell was blocked by endpoint protection (${reason})`);
            } catch (err) {
                reject(err);
            }
        };
        const child = spawn(`${program}.exe`, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child.stdin.on('error', () => undefined);
        child.on('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            if (err.code === 'EPERM') return blocked('spawn EPERM');
            if (settled) return;
            settled = true;
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (/ScriptContainedMaliciousContent/.test(stderr)) return blocked('AMSI');
            if (settled) return;
            settled = true;
            resolve({ stdout, stderr, code });
        });
        child.stdin.end(stdin);
    });
}
