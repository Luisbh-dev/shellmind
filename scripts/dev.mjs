// Development runner (`npm start`, `npm run electron:dev`).
//
// Runs the backend (tsx watch) and the Vite dev server with one session token
// for this run: the backend requires it and Vite hands it to the page (only
// while serving, see vite.config.ts), so the browser or the Electron window is
// signed in without a prompt. With --electron it also opens the desktop shell
// once both servers answer, and closing the window stops everything.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import concurrently from 'concurrently';

const withElectron = process.argv.includes('--electron');
const port = process.env.PORT?.trim() || '3001';
const webPort = process.env.WEB_PORT?.trim() || '5173';
const devUrl = `http://localhost:${webPort}`;
const token = process.env.SHELLMIND_AUTH_TOKEN?.trim() || randomBytes(32).toString('base64url');

// Child commands run through a shell; put the local bins (wait-on, electron)
// on PATH so this works when started with plain `node`, not only via npm.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
const binDir = path.resolve('node_modules', '.bin');

const env = {
    [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] ?? ''}`,
    HOST: process.env.HOST?.trim() || '127.0.0.1',
    PORT: port,
    SHELLMIND_AUTH_TOKEN: token,
    SHELLMIND_DEV_API_BASE: `http://127.0.0.1:${port}`,
    SHELLMIND_DEV_URL: devUrl,
    WEB_PORT: webPort,
};

// Tailwind loads tailwind.config.ts with require() and only falls back to jiti
// when that throws. Where Node strips types itself (22.18+), a config Node can
// load on its own (one without extensionless relative imports, as on older
// commits) stays cached as an ES module for the life of the process: Tailwind's
// cache purge does not reach it, so after a merge or a branch switch Vite kept
// serving the theme tokens it started with. Without native type stripping the
// config always goes through jiti, which reloads it and palette.ts/model.ts on
// every change.
const webEnv = process.features.typescript
    ? { ...env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-experimental-strip-types'].filter(Boolean).join(' ') }
    : env;

const commands = [
    { name: 'api', command: 'npm run server', prefixColor: 'cyan', env },
    { name: 'web', command: 'npm run dev', prefixColor: 'magenta', env: webEnv },
];
if (withElectron) {
    commands.push({
        name: 'app',
        command: `wait-on -t 120000 http-get://127.0.0.1:${port}/api/health ${devUrl.replace('http://', 'http-get://')} && electron .`,
        prefixColor: 'green',
        env,
    });
}

console.log(`ShellMind dev session: API http://127.0.0.1:${port}, UI ${devUrl}`);
console.log(`Access token for this run (other browsers/tools): ${token}`);

const { result } = concurrently(commands, {
    killOthersOn: withElectron ? ['failure', 'success'] : ['failure'],
});

result.then(
    () => process.exit(0),
    () => process.exit(1),
);
