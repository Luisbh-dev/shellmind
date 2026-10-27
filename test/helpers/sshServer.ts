import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { Server, utils, type AuthContext, type Connection, type ServerChannel, type SFTPWrapper } from 'ssh2';
import { sshFingerprint } from '../../server/ssh/hostKeys';

// In-process SSH server for tests: password, public key and
// keyboard-interactive auth, exec with a few scripted commands, an echoing
// shell, direct-tcpip forwarding (for jump hosts) and a read-only SFTP
// listing. It listens on its own net.Server and injects the sockets into
// ssh2, so tests can freeze the transport to simulate a dead network.

export type HarnessUser = {
    username: string;
    password?: string;
    // OpenSSH public key accepted for this user.
    publicKey?: string;
};

export type SshHarnessOptions = {
    users?: HarnessUser[];
    // Only keyboard-interactive is offered for passwords.
    keyboardInteractiveOnly?: boolean;
    // Its single prompt; a hidden "Password: " by default.
    keyboardInteractivePrompt?: { prompt: string; echo: boolean };
    // OpenSSH private host key; a new ed25519 key by default.
    hostKey?: string;
    // More host keys of other types (e.g. RSA) the server can present.
    extraHostKeys?: string[];
    // Handles exec requests first; return false to fall back to the built-in commands.
    exec?: (command: string, channel: ServerChannel) => boolean;
    // --- terminal ---
    // Serves shell requests first; return false to fall back to the echoing shell.
    shell?: (channel: ServerChannel) => boolean;
    // Session channels allowed per connection, like sshd's MaxSessions: more
    // are refused as "administratively prohibited".
    maxSessions?: number;
    // Serves SFTP sessions instead of the read-only listing (see sftpDirectory.ts).
    sftp?: (sftp: SFTPWrapper) => void;
    // --- ssh core (V1) ---
    // Where a forwarded (jump host) connection to destHost:destPort really
    // goes, e.g. another harness for the same private address behind another
    // bastion; "hang" never answers it (a target whose SYN is dropped).
    forward?: (destHost: string, destPort: number) => { host: string; port: number } | 'hang';
};

export type SshHarness = {
    host: '127.0.0.1';
    port: number;
    // OpenSSH-style SHA256 fingerprint of the host key.
    fingerprint: string;
    // Fingerprint of every host key by key type ("ssh-ed25519", "ssh-rsa", ...).
    fingerprints: Record<string, string>;
    // ssh connections accepted so far / open now.
    connections: () => number;
    openConnections: () => number;
    // Exec channels open now / most open at the same time.
    activeExecs: () => number;
    maxActiveExecs: () => number;
    // "auth:password", "exec:<cmd>", "exec-closed:<cmd>", "shell", "sftp", "tcpip:<host>:<port>", "signal:<name>".
    log: string[];
    // Stops reading from every open transport (the peer sees silence).
    freeze: () => void;
    close: () => Promise<void>;
};

export const HARNESS_OS = 'Harness Linux 1.0';
export const HARNESS_BANNER = 'Welcome to the ShellMind test harness';
export const HARNESS_PROMPT = 'harness$ ';

export const SFTP_ROOT = [
    { filename: 'hello.txt', isDir: false, size: 5 },
    { filename: 'docs', isDir: true, size: 0 },
];

export function generateKeyPair(type: 'ed25519' | 'rsa' = 'ed25519'): { privateKey: string; publicKey: string } {
    // ssh2 drops a leading zero byte of about 1 in 250 ed25519 keys and then
    // cannot parse the key it wrote ("Malformed OpenSSH private key"), which
    // made harness starts fail at random: generate until the pair round-trips.
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const pair = type === 'rsa' ? utils.generateKeyPairSync('rsa', { bits: 2048 }) : utils.generateKeyPairSync('ed25519');
        if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) {
            return { privateKey: pair.private, publicKey: pair.public };
        }
    }
    throw new Error(`Could not generate a usable ${type} key pair`);
}

function hostKeyInfo(privateKey: string): { type: string; fingerprint: string } {
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error) throw parsed;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    return { type: key.type, fingerprint: sshFingerprint(key.getPublicSSH()) };
}

function sameBytes(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}

// Whether a fake host can still answer on the channel: the client has not
// closed it (nor the host ended it). ssh2 ends the channel's output as soon as
// the client closes it, but emits 'close' only after the 'end' of its stdin,
// which the close causes too: a host answering on that 'end' (a script read
// from stdin) or from a timer looks here, not for 'close'. On stderr, a write
// after that end is an uncaught "write after end".
export function channelOpen(channel: ServerChannel): boolean {
    return channel.writable && channel.stderr.writable;
}

function finish(channel: ServerChannel, code: number): void {
    channel.exit(code);
    channel.end();
}

function builtinExec(command: string, channel: ServerChannel): void {
    let match: RegExpExecArray | null;
    if (command === 'grep PRETTY_NAME /etc/os-release || uname -sr') {
        channel.write(`PRETTY_NAME="${HARNESS_OS}"\n`);
        finish(channel, 0);
    } else if ((match = /^echo (.*)$/s.exec(command))) {
        channel.write(`${match[1]}\n`);
        finish(channel, 0);
    } else if ((match = /^sleep-ms (\d+)$/.exec(command))) {
        setTimeout(() => {
            // Unless the client gave up meanwhile (a timeout, a cancel).
            if (!channelOpen(channel)) return;
            channel.write('slept\n');
            finish(channel, 0);
        }, Number(match[1]));
    } else if (command === 'hang') {
        // Never ends on its own.
    } else if (command === 'fail') {
        channel.stderr.write('boom\n');
        finish(channel, 3);
    } else if (command === 'utf8-split') {
        // "ñ" is two bytes: split it across two packets.
        const bytes = Buffer.from('ñandú €', 'utf8');
        channel.write(bytes.subarray(0, 1));
        setTimeout(() => {
            if (!channelOpen(channel)) return;
            channel.write(bytes.subarray(1));
            finish(channel, 0);
        }, 20);
    } else {
        channel.stderr.write(`harness: ${command}: not found\n`);
        finish(channel, 127);
    }
}

function serveShell(channel: ServerChannel): void {
    channel.write(`${HARNESS_BANNER}\r\n${HARNESS_PROMPT}`);
    let line = '';
    channel.on('data', (data: Buffer) => {
        for (const char of data.toString('utf8')) {
            if (char === '\r' || char === '\n') {
                channel.write(`\r\n`);
                if (line === 'exit') {
                    finish(channel, 0);
                    return;
                }
                if (line) channel.write(`you typed: ${line}\r\n`);
                channel.write(HARNESS_PROMPT);
                line = '';
            } else {
                line += char;
                channel.write(char);
            }
        }
    });
}

function serveSftp(sftp: SFTPWrapper): void {
    const { STATUS_CODE } = utils.sftp;
    const attrs = (isDir: boolean, size: number) => ({
        mode: (isDir ? 0o040000 : 0o100000) | 0o755,
        uid: 0,
        gid: 0,
        size,
        atime: 1_700_000_000,
        mtime: 1_700_000_000,
    });
    const handles = new Map<string, { listed: boolean }>();
    let nextHandle = 0;

    sftp.on('REALPATH', (reqid, path) => {
        const resolved = path === '.' || path === '' ? '/' : path;
        sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: attrs(true, 0) }]);
    });
    sftp.on('STAT', (reqid, path) => {
        if (path === '/') return sftp.attrs(reqid, attrs(true, 0));
        const entry = SFTP_ROOT.find((item) => `/${item.filename}` === path);
        if (!entry) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        sftp.attrs(reqid, attrs(entry.isDir, entry.size));
    });
    sftp.on('OPENDIR', (reqid, path) => {
        if (path !== '/') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        const handle = String(nextHandle++);
        handles.set(handle, { listed: false });
        sftp.handle(reqid, Buffer.from(handle));
    });
    sftp.on('READDIR', (reqid, handle) => {
        const state = handles.get(handle.toString());
        if (!state) return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (state.listed) return sftp.status(reqid, STATUS_CODE.EOF);
        state.listed = true;
        sftp.name(reqid, SFTP_ROOT.map((item) => ({
            filename: item.filename,
            longname: item.filename,
            attrs: attrs(item.isDir, item.size),
        })));
    });
    sftp.on('CLOSE', (reqid, handle) => {
        handles.delete(handle.toString());
        sftp.status(reqid, STATUS_CODE.OK);
    });
}

export async function startSshServer(options: SshHarnessOptions = {}): Promise<SshHarness> {
    const users = options.users ?? [{ username: 'tester', password: 'secret' }];
    const hostKeys = [options.hostKey ?? generateKeyPair().privateKey, ...(options.extraHostKeys ?? [])];
    const keyInfos = hostKeys.map(hostKeyInfo);
    const fingerprint = keyInfos[0].fingerprint;
    const fingerprints = Object.fromEntries(keyInfos.map((info) => [info.type, info.fingerprint]));
    const kbdPrompt = options.keyboardInteractivePrompt ?? { prompt: 'Password: ', echo: false };

    const log: string[] = [];
    const sockets = new Set<net.Socket>();
    let connections = 0;
    let open = 0;
    let activeExecs = 0;
    let maxActiveExecs = 0;

    const authenticate = (ctx: AuthContext) => {
        const user = users.find((candidate) => candidate.username === ctx.username);
        const offered: Array<'password' | 'publickey' | 'keyboard-interactive'> = options.keyboardInteractiveOnly
            ? ['keyboard-interactive', 'publickey']
            : ['password', 'publickey'];
        if (!user) return ctx.reject(offered);

        if (ctx.method === 'password' && !options.keyboardInteractiveOnly) {
            log.push('auth:password');
            return ctx.password === user.password ? ctx.accept() : ctx.reject(offered);
        }
        if (ctx.method === 'keyboard-interactive' && options.keyboardInteractiveOnly) {
            log.push('auth:keyboard-interactive');
            return ctx.prompt([kbdPrompt], (answers) => {
                if (answers[0] === user.password) ctx.accept();
                else ctx.reject(offered);
            });
        }
        if (ctx.method === 'publickey' && user.publicKey) {
            const allowed = utils.parseKey(user.publicKey);
            if (allowed instanceof Error) return ctx.reject(offered);
            const key = Array.isArray(allowed) ? allowed[0] : allowed;
            if (ctx.key.algo !== key.type || !sameBytes(ctx.key.data, key.getPublicSSH())) return ctx.reject(offered);
            if (ctx.signature && ctx.blob) {
                log.push('auth:publickey');
                return key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(offered);
            }
            return ctx.accept();
        }
        ctx.reject(offered);
    };

    const ssh = new Server({ hostKeys }, (client: Connection) => {
        connections += 1;
        open += 1;
        client.on('close', () => { open -= 1; });
        client.on('error', () => { /* the client went away */ });
        client.on('authentication', authenticate);

        client.on('ready', () => {
            client.on('tcpip', (accept, reject, info) => {
                log.push(`tcpip:${info.destIP}:${info.destPort}`);
                const route = options.forward?.(info.destIP, info.destPort) ?? { host: info.destIP, port: info.destPort };
                if (route === 'hang') return;
                const upstream = net.connect(route.port, route.host);
                upstream.once('connect', () => {
                    const channel = accept();
                    channel.pipe(upstream).pipe(channel);
                    channel.on('close', () => upstream.destroy());
                    upstream.on('close', () => channel.close());
                });
                upstream.once('error', () => reject());
            });

            // ssh2 refuses session channels itself while this flag is set.
            const limited = client as Connection & { noMoreSessions: boolean };
            let sessions = 0;
            const enforceMaxSessions = () => {
                if (options.maxSessions !== undefined) limited.noMoreSessions = sessions >= options.maxSessions;
            };
            client.on('session', (accept) => {
                const session = accept();
                sessions += 1;
                enforceMaxSessions();
                session.on('close', () => {
                    sessions -= 1;
                    enforceMaxSessions();
                });
                session.on('pty', (acceptPty) => acceptPty?.());
                session.on('window-change', (acceptChange) => acceptChange?.());
                session.on('env', (acceptEnv) => acceptEnv?.());
                session.on('signal', (acceptSignal, _reject, info) => {
                    log.push(`signal:${info.name}`);
                    acceptSignal?.();
                });
                session.on('shell', (acceptShell) => {
                    log.push('shell');
                    const channel = acceptShell();
                    if (!options.shell?.(channel)) serveShell(channel);
                });
                session.on('exec', (acceptExec, _reject, info) => {
                    const channel = acceptExec();
                    // stdin is ignored; reading it lets the channel end and close.
                    channel.resume();
                    log.push(`exec:${info.command}`);
                    activeExecs += 1;
                    maxActiveExecs = Math.max(maxActiveExecs, activeExecs);
                    channel.on('close', () => {
                        activeExecs -= 1;
                        log.push(`exec-closed:${info.command}`);
                    });
                    if (!options.exec?.(info.command, channel)) builtinExec(info.command, channel);
                });
                session.on('sftp', (acceptSftp) => {
                    log.push('sftp');
                    (options.sftp ?? serveSftp)(acceptSftp());
                });
            });
        });
    });

    const listener = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        ssh.injectSocket(socket);
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as net.AddressInfo;

    return {
        host: '127.0.0.1',
        port,
        fingerprint,
        fingerprints,
        connections: () => connections,
        openConnections: () => open,
        activeExecs: () => activeExecs,
        maxActiveExecs: () => maxActiveExecs,
        log,
        freeze: () => {
            for (const socket of sockets) socket.pause();
        },
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => listener.close(() => resolve()));
        },
    };
}
