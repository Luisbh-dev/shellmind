import { Client } from 'ssh2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOpsHost } from './opsHost';
import { startSshServer, type SshHarness } from './sshServer';

// The scripted host when the client gives up on a command before its script
// is in, as the backend does when a run is cancelled while the channel opens
// (server/ssh/exec.ts kills the channel without writing stdin). Closing the
// channel also ends its stdin, which is what starts a script read from stdin:
// an answer written then went to a closed channel, and on stderr threw an
// uncaught "write after end" that failed the whole test run.

const POWERSHELL_STDIN_COMMAND = 'powershell -NoProfile -NonInteractive -Command -';

let harness: SshHarness;
let client: Client;
const host = createOpsHost();
// What failed on the host's side of the channels.
const errors: Error[] = [];

beforeAll(async () => {
    harness = await startSshServer({
        exec: (command, channel) => {
            channel.on('error', (err: Error) => errors.push(err));
            channel.stderr.on('error', (err: Error) => errors.push(err));
            return host.exec(command, channel);
        },
    });
    client = new Client();
    await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve).once('error', reject);
        client.connect({ host: harness.host, port: harness.port, username: 'tester', password: 'secret' });
    });
});

beforeEach(() => {
    errors.length = 0;
});

afterAll(async () => {
    client?.end();
    await harness?.close();
});

// Opens `command` and kills it at once, like exec.ts kill(), then waits until
// the host's side of the channel closed too.
async function giveUp(command: string): Promise<void> {
    const closed = harness.log.filter((entry) => entry === `exec-closed:${command}`).length;
    await new Promise<void>((resolve, reject) => client.exec(command, (err, channel) => {
        if (err) return reject(err);
        channel.signal('KILL');
        channel.close();
        resolve();
    }));
    while (harness.log.filter((entry) => entry === `exec-closed:${command}`).length === closed) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // An error of a write after the close is emitted on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('ops host', () => {
    it('does not answer a command whose client closed the channel before sending the script', async () => {
        // The answer to a script nobody scripted is an error on stderr.
        host.respond(() => undefined);
        await giveUp('sh -s');
        await giveUp(POWERSHELL_STDIN_COMMAND);
        expect(errors).toEqual([]);
    });

    it('does not start a Windows log stream on a channel the client closed', async () => {
        // A stream starts with PowerShell's CLIXML header on stderr.
        host.respond(() => undefined);
        host.stream(() => ({ lines: ['started'], stderr: '#< CLIXML\r\n' }));
        await giveUp(POWERSHELL_STDIN_COMMAND);
        expect(errors).toEqual([]);
    });
});
