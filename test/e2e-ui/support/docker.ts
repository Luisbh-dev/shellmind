import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';

// The Docker side of the suite: images built from test/fixtures, throwaway
// containers named shellmind-test-e2eui-* published on random loopback ports.

export const CONTAINER_PREFIX = 'shellmind-test-e2eui-';

export function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function dockerAvailable(): boolean {
    return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;
}

// A shell script run as root inside a container.
export function inside(container: string, script: string): string {
    return execFileSync('docker', ['exec', '-i', container, 'sh', '-s'], {
        input: script,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
    }).trim();
}

export function buildImage(tag: string, context: string): void {
    docker('build', '-q', '-t', tag, context);
}

// Starts a detached container with its port 22 published on a random
// loopback port, and returns that port.
export function runSshContainer(name: string, image: string, extra: string[] = []): number {
    spawnSync('docker', ['rm', '-f', name]);
    docker('run', '-d', '--name', name, '--hostname', name.slice(CONTAINER_PREFIX.length), '-p', '127.0.0.1::22', ...extra, image);
    return Number(docker('port', name, '22').split('\n')[0].split(':').pop());
}

export function removeContainer(name: string): void {
    spawnSync('docker', ['rm', '-f', name]);
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

// Containers of this suite that a crashed run left behind: their names end
// with the pid of the run that started them, which is gone. Those of a run
// still going are left alone.
export function leftoverContainers(): string[] {
    const listed = spawnSync('docker', ['ps', '-a', '--filter', `name=^${CONTAINER_PREFIX}`, '--format', '{{.Names}}'], { encoding: 'utf8' });
    if (listed.status !== 0) return [];
    return listed.stdout.split('\n').map((line) => line.trim()).filter((name) => {
        const pid = Number(/-(\d+)$/.exec(name)?.[1]);
        return name && !(pid && processAlive(pid));
    });
}

export function sshBanner(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(port, host);
        socket.once('data', (data) => {
            socket.destroy();
            resolve(data.toString().startsWith('SSH-'));
        });
        socket.once('error', () => resolve(false));
        socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
