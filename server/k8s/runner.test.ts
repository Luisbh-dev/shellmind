import { describe, expect, it } from 'vitest';
import { localRunner } from './runner';

// The local runner (a local server with the kubectl preset) runs a program
// without a shell, bounded by a timeout, an output cap and an abort signal.
// Node itself stands in for kubectl here.

const node = localRunner(1, process.execPath);
const script = (source: string) => ['-e', source];

describe('local kubectl runner', () => {
    it('collects stdout, stderr and the exit status', async () => {
        const result = await node.run(script('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'), { timeoutMs: 10_000 });
        expect(result).toEqual({ stdout: 'out', stderr: 'err', code: 3 });
    });

    it('passes arguments as they are, never through a shell', async () => {
        const tricky = "a b; echo pwned && $(id) `id` 'q' \"d\"";
        const result = await node.run([...script('process.stdout.write(JSON.stringify(process.argv.slice(1)))'), tricky], { timeoutMs: 10_000 });
        expect(JSON.parse(result.stdout)).toEqual([tricky]);
    });

    it('gives up after the timeout, saying why', async () => {
        await expect(node.run(script('setTimeout(() => {}, 30000)'), { timeoutMs: 300 })).rejects.toMatchObject({ code: 'K8S_TIMEOUT', status: 504 });
    });

    it('stops a command that prints too much', async () => {
        await expect(node.run(script('process.stdout.write("x".repeat(200000))'), { timeoutMs: 10_000, maxOutputBytes: 1000 }))
            .rejects.toMatchObject({ code: 'EXEC_OUTPUT_TOO_LARGE' });
    });

    it('is cancelled by its signal', async () => {
        const controller = new AbortController();
        const run = node.run(script('setTimeout(() => {}, 30000)'), { timeoutMs: 20_000, signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        await expect(run).rejects.toMatchObject({ code: 'EXEC_ABORTED' });
    });

    it('streams output as it comes and stops when aborted', async () => {
        const controller = new AbortController();
        let text = '';
        const stream = node.stream(script('let n = 0; setInterval(() => console.log("line " + (++n)), 20)'), {
            signal: controller.signal,
            onData: (chunk) => {
                text += chunk;
                if (text.includes('line 3')) controller.abort();
            }
        });
        await expect(stream).rejects.toMatchObject({ code: 'EXEC_ABORTED' });
        expect(text).toContain('line 1');
    });

    it('streams to the end with the exit status', async () => {
        let text = '';
        const outcome = await node.stream(script('console.log("a"); console.error("b"); process.exit(2)'), { signal: new AbortController().signal, onData: (chunk) => { text += chunk; } });
        expect(outcome).toEqual({ code: 2 });
        expect(text).toContain('a');
        expect(text).toContain('b');
    });

    // Pod logs: kubectl's own messages are not lines of the container's output.
    it("keeps kubectl's messages apart from the output when asked", async () => {
        let out = '';
        let err = '';
        const outcome = await node.stream(script('console.log("a log line"); console.error("Error from server (BadRequest): is waiting to start"); process.exit(1)'), {
            signal: new AbortController().signal,
            onData: (chunk) => { out += chunk; },
            onStderr: (chunk) => { err += chunk; }
        });
        expect(outcome).toEqual({ code: 1 });
        expect(out).toBe('a log line\n');
        expect(err).toContain('is waiting to start');
    });

    it('shows commands the way a user would type them', () => {
        expect(node.display(['--context', 'kind-dev', 'get', 'pods', '-l', 'app=web x'])).toBe("kubectl --context kind-dev get pods -l 'app=web x'");
    });
});
