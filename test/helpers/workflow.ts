import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GitHub workflow files read as text (there is no YAML parser among the
// dependencies): the tests check a few plain lines of them.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export function readWorkflow(file: string) {
    const text = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', file), 'utf8').replace(/\r\n/g, '\n');

    // The lines under `name:` at the given indentation, up to the next key at that level.
    const block = (name: string, indent: number): string => {
        const lines = text.split('\n');
        const start = lines.findIndex((line) => line === `${' '.repeat(indent)}${name}:`);
        if (start < 0) throw new Error(`no ${name} in ${file}`);
        const end = lines.findIndex((line, index) => index > start && new RegExp(`^ {0,${indent}}\\S`).test(line));
        return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
    };

    return { text, block };
}

// The value of the first `key: value` line in `text`.
export function setting(text: string, key: string): string {
    const match = new RegExp(`^\\s*-? ?${key}: (.+)$`, 'm').exec(text);
    if (!match) throw new Error(`no ${key}`);
    return match[1].trim();
}

// The steps of a job block, each as its text from `- name:` on.
export function steps(job: string): { name: string; text: string }[] {
    return job.split(/\n(?= {6}- name: )/).filter((part) => /^ {6}- name: /.test(part)).map((text) => ({ name: setting(text, 'name'), text }));
}
