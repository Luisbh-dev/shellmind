import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// Minimal in-process FTP server for tests, backed by a local directory: the
// commands basic-ftp uses (EPSV/PASV, LIST, RETR, STOR, SIZE, MDTM, CWD,
// MKD, RMD, DELE, RNFR/RNTO). Like a real server it handles one command at a
// time per connection; it records every command so tests can check what ran.

export type FtpHarnessOptions = {
    user?: string;
    password?: string;
    // Login directory (PWD); "/" by default.
    home?: string;
    // Delay (ms) between the 64 KiB pieces of a RETR.
    retrDelayMs?: number;
    // At most this many simultaneous logins; extra ones get 421.
    maxConnections?: number;
    // Upload-only drop boxes: RNFR and DELE are refused.
    refuseRename?: boolean;
    refuseDelete?: boolean;
    // Like servers that will not rename over an existing file (RNTO 553).
    refuseRenameOver?: boolean;
};

export type FtpHarness = {
    host: '127.0.0.1';
    port: number;
    // "<connection #>:<command>" for every command received (PASS masked).
    log: string[];
    connections: () => number;
    openConnections: () => number;
    close: () => Promise<void>;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function listLine(name: string, stats: fs.Stats): string {
    const date = stats.mtime;
    const time = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
    const type = stats.isDirectory() ? 'd' : '-';
    return `${type}rw-r--r-- 1 ftp ftp ${stats.isDirectory() ? 0 : stats.size} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${time} ${name}`;
}

function mdtm(date: Date): string {
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export async function startFtpServer(root: string, options: FtpHarnessOptions = {}): Promise<FtpHarness> {
    const user = options.user ?? 'ftpuser';
    const password = options.password ?? 'ftppass';
    const home = options.home ?? '/';
    const log: string[] = [];
    const sockets = new Set<net.Socket>();
    const dataServers = new Set<net.Server>();
    let connections = 0;
    let open = 0;

    const toLocal = (remote: string) => path.join(root, ...path.posix.normalize(remote).split('/').filter(Boolean));

    const control = net.createServer((socket) => {
        connections += 1;
        const id = connections;
        sockets.add(socket);
        socket.on('close', () => {
            sockets.delete(socket);
            open -= 1;
        });
        socket.on('error', () => { /* the client went away */ });
        open += 1;
        if (options.maxConnections && open > options.maxConnections) {
            // Reading on is what lets the client's FIN (after its QUIT) arrive.
            socket.resume();
            socket.end('421 Too many connections\r\n');
            return;
        }

        let cwd = home;
        let loggedIn = false;
        let pendingUser = '';
        let renameFrom: string | null = null;
        let dataServer: net.Server | null = null;
        let dataSocket: Promise<net.Socket> | null = null;
        let buffer = '';
        let busy = Promise.resolve();

        const reply = (line: string) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
        const resolve = (arg: string) => path.posix.normalize(arg.startsWith('/') ? arg : `${cwd}/${arg}`);

        const openPassive = async (): Promise<number> => {
            dataServer?.close();
            const server = net.createServer();
            dataServers.add(server);
            dataServer = server;
            dataSocket = new Promise((accept) => server.once('connection', (data) => {
                data.on('error', () => { /* aborted transfer */ });
                accept(data);
                server.close();
                dataServers.delete(server);
            }));
            await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
            return (server.address() as net.AddressInfo).port;
        };
        const takeData = async (): Promise<net.Socket | null> => {
            const pending = dataSocket;
            dataSocket = null;
            return pending ? pending : null;
        };

        const handle = async (line: string) => {
            const space = line.indexOf(' ');
            const command = (space < 0 ? line : line.slice(0, space)).toUpperCase();
            const arg = space < 0 ? '' : line.slice(space + 1);
            log.push(`${id}:${command === 'PASS' ? 'PASS ***' : line}`);

            if (command === 'USER') { pendingUser = arg; return reply('331 Password required'); }
            if (command === 'PASS') {
                loggedIn = pendingUser === user && arg === password;
                return reply(loggedIn ? '230 Logged in' : '530 Login incorrect');
            }
            if (command === 'QUIT') { reply('221 Bye'); socket.end(); return; }
            if (command === 'OPTS' || command === 'NOOP' || command === 'TYPE' || command === 'STRU') return reply('200 OK');
            if (command === 'FEAT') return reply('211-Features:\r\n UTF8\r\n SIZE\r\n MDTM\r\n EPSV\r\n211 End');
            if (command === 'SYST') return reply('215 UNIX Type: L8');
            if (!loggedIn) return reply('530 Please login with USER and PASS');

            try {
                switch (command) {
                    case 'PWD': return reply(`257 "${cwd}" is the current directory`);
                    case 'CWD': {
                        const target = resolve(arg);
                        if (!fs.statSync(toLocal(target)).isDirectory()) return reply('550 Failed to change directory.');
                        cwd = target;
                        return reply('250 Directory successfully changed.');
                    }
                    case 'EPSV': return reply(`229 Entering Extended Passive Mode (|||${await openPassive()}|)`);
                    case 'PASV': {
                        const port = await openPassive();
                        return reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
                    }
                    case 'LIST': {
                        const target = resolve(arg.replace(/^-a\s*/, '') || '.');
                        const names = fs.readdirSync(toLocal(target));
                        const data = await takeData();
                        if (!data) return reply('425 Use PASV first');
                        reply('150 Here comes the directory listing.');
                        const text = names.map((name) => listLine(name, fs.statSync(path.join(toLocal(target), name)))).join('\r\n');
                        data.end(text ? `${text}\r\n` : '');
                        await new Promise((done) => data.once('close', done));
                        return reply('226 Directory send OK.');
                    }
                    case 'RETR': {
                        const local = toLocal(resolve(arg));
                        if (!fs.statSync(local).isFile()) return reply('550 Failed to open file.');
                        const content = fs.readFileSync(local);
                        const data = await takeData();
                        if (!data) return reply('425 Use PASV first');
                        reply('150 Opening BINARY mode data connection.');
                        for (let at = 0; at < content.length && !data.destroyed; at += 64 * 1024) {
                            data.write(content.subarray(at, at + 64 * 1024));
                            if (options.retrDelayMs) await new Promise((done) => setTimeout(done, options.retrDelayMs));
                        }
                        if (data.destroyed) return reply('426 Connection closed; transfer aborted.');
                        data.end();
                        await new Promise((done) => data.once('close', done));
                        return reply('226 Transfer complete.');
                    }
                    case 'STOR': {
                        const local = toLocal(resolve(arg));
                        const data = await takeData();
                        if (!data) return reply('425 Use PASV first');
                        // Like real servers: the file exists from the start and
                        // an aborted upload leaves what arrived so far.
                        const fd = fs.openSync(local, 'w');
                        reply('150 Ok to send data.');
                        data.on('data', (chunk: Buffer) => fs.writeSync(fd, chunk));
                        await new Promise((done) => data.once('close', done));
                        fs.closeSync(fd);
                        return reply('226 Transfer complete.');
                    }
                    case 'SIZE': {
                        const stats = fs.statSync(toLocal(resolve(arg)));
                        return reply(stats.isFile() ? `213 ${stats.size}` : '550 Could not get file size.');
                    }
                    case 'MDTM': return reply(`213 ${mdtm(fs.statSync(toLocal(resolve(arg))).mtime)}`);
                    case 'MKD': {
                        const target = resolve(arg);
                        fs.mkdirSync(toLocal(target));
                        return reply(`257 "${target}" created`);
                    }
                    case 'RMD': fs.rmdirSync(toLocal(resolve(arg))); return reply('250 Remove directory operation successful.');
                    case 'DELE':
                        if (options.refuseDelete) return reply('550 Permission denied.');
                        fs.unlinkSync(toLocal(resolve(arg)));
                        return reply('250 Delete operation successful.');
                    case 'RNFR': {
                        if (options.refuseRename) return reply('550 Permission denied.');
                        const from = resolve(arg);
                        fs.statSync(toLocal(from));
                        renameFrom = from;
                        return reply('350 Ready for RNTO.');
                    }
                    case 'RNTO': {
                        if (!renameFrom) return reply('503 RNFR required first.');
                        if (options.refuseRenameOver && fs.existsSync(toLocal(resolve(arg)))) {
                            renameFrom = null;
                            return reply('553 File exists.');
                        }
                        // Like vsftpd (rename(2)): an existing file is replaced.
                        fs.renameSync(toLocal(renameFrom), toLocal(resolve(arg)));
                        renameFrom = null;
                        return reply('250 Rename successful.');
                    }
                    default: return reply('502 Command not implemented.');
                }
            } catch {
                return reply('550 Requested action not taken.');
            }
        };

        socket.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            let newline = buffer.indexOf('\r\n');
            while (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 2);
                busy = busy.then(() => handle(line));
                newline = buffer.indexOf('\r\n');
            }
        });
        reply('220 ShellMind test FTP');
    });

    await new Promise<void>((ready) => control.listen(0, '127.0.0.1', ready));
    const { port } = control.address() as net.AddressInfo;

    return {
        host: '127.0.0.1',
        port,
        log,
        connections: () => connections,
        openConnections: () => open,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            for (const server of dataServers) server.close();
            await new Promise<void>((done) => control.close(() => done()));
        },
    };
}
