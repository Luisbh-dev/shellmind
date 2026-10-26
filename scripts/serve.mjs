// Production self-hosting (`npm run build`, then `npm run serve`): the compiled
// backend serves the built web UI and the API from one origin.
//
// The backend runs as a child process and is restarted with backoff when it
// stops: it exits on an uncaught exception by design (server/lifecycle.ts),
// like under the desktop app, which supervises it the same way. The session
// token is fixed here so it survives restarts.
//
// .env is loaded first so its settings win over the defaults below. The
// database defaults to the repository root, the same file `npm start` uses,
// never to dist-server/ (which every build wipes).
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { serveEnv } from './serveEnv.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist-server', 'server.js');
const supervisorModule = path.join(root, 'dist-electron', 'backend.js');

for (const required of [entry, supervisorModule, path.join(root, 'dist', 'index.html')]) {
    if (!fs.existsSync(required)) {
        console.error(`Missing ${path.relative(root, required)}: run \`npm run build\` first.`);
        process.exit(1);
    }
}

const { superviseBackend } = createRequire(import.meta.url)(supervisorModule);

const configuredToken = process.env.SHELLMIND_AUTH_TOKEN?.trim();
const token = configuredToken || randomBytes(32).toString('base64url');

const supervisor = superviseBackend({
    entry,
    env: serveEnv(process.env, root, token),
    readyTimeoutMs: 30_000,
    onOutput: (text) => process.stdout.write(text),
    onReady: (_backend, restarts) => {
        // Printed once: the only way in when no token was configured.
        if (restarts === 0 && !configuredToken) console.log(`Access token: ${token}`);
    },
    onCrash: (reason, delayMs) => {
        console.error(`ShellMind backend stopped (${reason}); restarting in ${Math.round(delayMs / 1000)} s.`);
    },
});

supervisor.done.then(
    () => process.exit(0),
    (error) => {
        console.error(`ShellMind backend could not start: ${error.message}`);
        process.exit(1);
    },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void supervisor.stop());
}
