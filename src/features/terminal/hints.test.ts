import { describe, expect, it } from 'vitest';
import type { ServerType } from '@shared/types';
import { catalog } from '@/i18n/catalog';
import { hintGroupsFor } from './hints';

const SERVERS: Array<{ type: ServerType; cli_preset?: string }> = [
    { type: 'linux' }, { type: 'windows' }, { type: 'ftp' }, { type: 's3' },
    ...['docker', 'kubectl', 'aws', 'azure', 'gcloud', 'shell', 'custom'].map((preset) => ({ type: 'local' as const, cli_preset: preset }))
];

describe('quick commands', () => {
    it('are offered per kind of server', () => {
        expect(hintGroupsFor({ type: 'linux' }).map((group) => group.id)).toEqual(['health', 'services']);
        expect(hintGroupsFor({ type: 'windows' }).map((group) => group.id)).toEqual(['windowsHealth', 'windowsTroubleshooting']);
        expect(hintGroupsFor({ type: 'local', cli_preset: 'docker' }).map((group) => group.id)).toEqual(['docker']);
        expect(hintGroupsFor({ type: 'local', cli_preset: 'shell' })).toEqual([]);
        expect(hintGroupsFor({ type: 's3' })).toEqual([]);
    });

    it('never run a placeholder: commands that need a name are typed for editing (hints-run-placeholders)', () => {
        const all = SERVERS.flatMap((server) => hintGroupsFor(server).flatMap((group) => group.items));
        for (const hint of all) expect(/my-service|new-folder|<|>/.test(hint.cmd) && !hint.editable).toBe(false);
        expect(all.filter((hint) => hint.editable).map((hint) => hint.id)).toEqual(['restartService', 'createFolder']);
    });

    it('have their texts in every language', () => {
        const keys = SERVERS.flatMap((server) => hintGroupsFor(server).flatMap((group) => [
            `terminal.hints.groups.${group.id}.title`,
            `terminal.hints.groups.${group.id}.subtitle`,
            ...group.items.flatMap((hint) => [`terminal.hints.items.${hint.id}.title`, `terminal.hints.items.${hint.id}.description`])
        ]));
        for (const language of ['en', 'es'] as const) {
            expect(keys.filter((key) => !(key in catalog[language]))).toEqual([]);
        }
    });
});
