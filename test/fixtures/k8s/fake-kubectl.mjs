// A stand-in for kubectl in the local-runner tests (test/integration/
// k8s-local.test.ts): answers the commands ShellMind sends from the fixtures
// next to it, and appends every invocation (as JSON) to $FAKE_KUBECTL_LOG.
/* global process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (process.env.FAKE_KUBECTL_LOG) fs.appendFileSync(process.env.FAKE_KUBECTL_LOG, `${JSON.stringify(args)}\n`);
const fixture = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const has = (...words) => words.every((word) => args.includes(word));
const value = (flag) => args[args.indexOf(flag) + 1];

if (has('version', '--client')) {
    process.stdout.write('{"clientVersion":{"gitVersion":"v1.31.0-fake"}}\n');
} else if (has('config', 'view')) {
    process.stdout.write(fixture('config-view.json'));
} else if (has('config', 'use-context')) {
    process.stdout.write(`Switched to context "${value('use-context')}".\n`);
} else if (has('get', 'pods')) {
    process.stdout.write(fixture('pods.json'));
} else if (has('get', 'namespaces')) {
    process.stdout.write('{"items":[{"metadata":{"name":"default"}},{"metadata":{"name":"shop"}}]}\n');
} else if (has('logs')) {
    process.stdout.write(`2026-10-24T10:00:00Z log of ${args[args.indexOf('logs') + 1]}/${value('-c')}${has('--previous') ? ' (previous)' : ''}\n`);
} else if (has('scale')) {
    process.stdout.write(`${args[args.indexOf('scale') + 1].replace('/', '.apps/')} scaled\n`);
} else {
    process.stderr.write(`error: unknown command "${args.join(' ')}"\n`);
    process.exit(1);
}
