import type { ServerChannel } from 'ssh2';
import { channelOpen } from './sshServer';

// POWERSHELL_STDIN_COMMAND of server/ops/remote.ts, which is not imported:
// it reads the backend configuration, which bootTestServer() sets up first.
const POWERSHELL_STDIN_COMMAND = 'powershell -NoProfile -NonInteractive -Command -';

// A scripted remote host for the status and operations features, plugged
// into the SSH test harness (startSshServer({ exec: host.exec })). It answers
// the shapes of command those features send:
// - `sh -s` with a POSIX script on stdin,
// - `powershell ... -Command -` with a PowerShell script on stdin, the block
//   powershellStdin() makes (unwrapped; one that `respond` leaves unanswered
//   may be a Windows log stream, whose stdin stays open),
// - `powershell ... -EncodedCommand <base64>`, the fallback (decoded),
// - `sh -c '<watchdog script>'` for live log streams.
// Tests decide the answers by looking at the script.

export type Reply = {
    stdout?: string;
    stderr?: string;
    code?: number;
    delayMs?: number;
    // Never answers (until the client closes the channel).
    hang?: boolean;
};

export type StreamReply = {
    lines: string[];
    intervalMs?: number;
    // Ends with this exit code after the lines; otherwise repeats until closed.
    exitCode?: number;
    // Written to stderr first (e.g. PowerShell's CLIXML header and records).
    stderr?: string;
    // Writes this chunk as fast as the channel takes it (until closed),
    // waiting for "drain" like a real program blocked on write; `lines` is ignored.
    flood?: string;
    // Called right after each line is written (to act while it is in flight).
    onWrite?: (line: string) => void;
};

export type OpsHost = {
    exec: (command: string, channel: ServerChannel) => boolean;
    // Scripts received so far (decoded for PowerShell), oldest first.
    scripts: Array<{ kind: 'posix' | 'powershell' | 'stream'; script: string }>;
    // Log streams whose channel is still open.
    openStreams: () => number;
    // Bytes the log streams wrote so far.
    streamedBytes: () => number;
    respond: (handler: (script: string, kind: 'posix' | 'powershell') => Reply | undefined) => void;
    stream: (handler: (script: string) => StreamReply | undefined) => void;
};

export function decodePowerShell(command: string): string {
    return Buffer.from(command.split(' ').pop() ?? '', 'base64').toString('utf16le');
}

const STDIN_HEAD = '& {\n';
const STDIN_TAIL = '\nif(-not $?){exit 1}\n}\n\n';

// The script of a powershellStdin() block (the prelude and the compacted
// script, as decodePowerShell() reads the encoded form), or null while the
// block is incomplete.
export function unwrapPowerShellStdin(input: string): string | null {
    if (!input.startsWith(STDIN_HEAD) || !input.endsWith(STDIN_TAIL)) return null;
    return input.slice(STDIN_HEAD.length, -STDIN_TAIL.length);
}

export function createOpsHost(): OpsHost {
    let respond: (script: string, kind: 'posix' | 'powershell') => Reply | undefined = () => undefined;
    let stream: (script: string) => StreamReply | undefined = () => undefined;
    const scripts: OpsHost['scripts'] = [];
    let openStreams = 0;
    let streamedBytes = 0;

    const reply = (channel: ServerChannel, answer: Reply | undefined) => {
        const send = () => {
            // Closed by the client meanwhile, or before its script was in (a
            // command cancelled while its channel opened): the close also ends
            // stdin, which is what runs a script here.
            if (!channelOpen(channel)) return;
            const { stdout = '', stderr = '', code = 0 } = answer ?? { stderr: 'ops host: no scripted answer\n', code: 127 };
            if (stdout) channel.write(stdout);
            if (stderr) channel.stderr.write(stderr);
            channel.exit(code);
            channel.end();
        };
        if (answer?.hang) return;
        if (answer?.delayMs) setTimeout(send, answer.delayMs);
        else send();
    };

    const exec = (command: string, channel: ServerChannel): boolean => {
        if (command === 'sh -s') {
            let input = '';
            channel.on('data', (chunk: Buffer) => { input += chunk.toString('utf8'); });
            channel.once('end', () => {
                scripts.push({ kind: 'posix', script: input });
                reply(channel, respond(input, 'posix'));
            });
            return true;
        }
        // A PowerShell script nobody answers may be a (Windows) log stream.
        const powershell = (script: string) => {
            const answer = respond(script, 'powershell');
            const plan = answer === undefined ? stream(script) : undefined;
            if (plan) {
                scripts.push({ kind: 'stream', script });
                runStream(channel, plan);
                return;
            }
            scripts.push({ kind: 'powershell', script });
            reply(channel, answer);
        };
        if (command === POWERSHELL_STDIN_COMMAND) {
            // PowerShell runs the block once the empty line that closes it
            // arrives, whether stdin closes then (a script) or not (a stream).
            let input = '';
            let started = false;
            const start = () => {
                if (started) return;
                started = true;
                powershell(unwrapPowerShellStdin(input) ?? `unterminated: ${input}`);
            };
            channel.on('data', (chunk: Buffer) => {
                input += chunk.toString('utf8');
                if (unwrapPowerShellStdin(input) !== null) start();
            });
            channel.once('end', start);
            return true;
        }
        if (command.startsWith('powershell ')) {
            powershell(decodePowerShell(command));
            return true;
        }
        if (command.startsWith('sh -c ')) {
            // Undo the single quoting of `sh -c '<script>'`.
            const script = command.slice('sh -c '.length).replace(/^'|'$/g, '').split("'\\''").join("'");
            scripts.push({ kind: 'stream', script });
            const plan = stream(script);
            if (!plan) return false;
            runStream(channel, plan);
            return true;
        }
        return false;
    };

    const runStream = (channel: ServerChannel, plan: StreamReply) => {
        // A Windows stream also starts on the end of its stdin, which a client
        // closing the channel causes too.
        if (!channelOpen(channel)) return;
        openStreams += 1;
        if (plan.stderr) channel.stderr.write(plan.stderr);
        if (plan.flood !== undefined) {
            const chunk = plan.flood;
            const pump = () => {
                while (channelOpen(channel)) {
                    streamedBytes += chunk.length;
                    if (!channel.write(chunk)) {
                        channel.once('drain', pump);
                        return;
                    }
                }
            };
            channel.on('close', () => { openStreams -= 1; });
            setImmediate(pump);
            return;
        }
        let index = 0;
        const timer = setInterval(() => {
            if (!channelOpen(channel)) {
                clearInterval(timer);
                return;
            }
            if (plan.exitCode !== undefined && index >= plan.lines.length) {
                clearInterval(timer);
                channel.exit(plan.exitCode);
                channel.end();
                return;
            }
            const line = plan.lines[index % plan.lines.length];
            channel.write(`${line}\n`);
            index += 1;
            plan.onWrite?.(line);
        }, plan.intervalMs ?? 20);
        channel.on('close', () => {
            openStreams -= 1;
            clearInterval(timer);
        });
    };

    return {
        exec,
        scripts,
        openStreams: () => openStreams,
        streamedBytes: () => streamedBytes,
        respond: (handler) => { respond = handler; },
        stream: (handler) => { stream = handler; },
    };
}

// `<name>` section output as the POSIX scripts print it.
export function sections(values: Record<string, string>): string {
    return `${Object.entries(values).map(([name, body]) => `\n@@SM:${name}\n${body}`).join('')}\n@@SM:end\n`;
}
