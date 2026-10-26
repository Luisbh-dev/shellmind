import type { SnippetInput } from '@shared/snippets';
import type { TranslateFn } from '@/i18n';

// Built-in snippets offered on an empty library. Names and descriptions are
// translated when they are imported (they become the user's own snippets).
export type StarterSnippet = {
    key: string;
    command: string;
    tags: string[];
};

export const STARTER_SNIPPETS: readonly StarterSnippet[] = [
    { key: 'diskUsage', command: 'df -hT -x tmpfs -x devtmpfs -x squashfs', tags: ['disk', 'linux'] },
    { key: 'topMemory', command: 'ps aux --sort=-%mem | head -n {{count:15}}', tags: ['memory', 'linux'] },
    { key: 'failedUnits', command: 'systemctl --failed --no-pager', tags: ['systemd', 'linux'] },
    { key: 'dockerPs', command: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'", tags: ['docker'] },
    { key: 'tailSyslog', command: 'tail -n {{lines:200}} {{file:/var/log/syslog}}', tags: ['logs', 'linux'] },
    { key: 'openPorts', command: 'ss -tulpn', tags: ['network', 'linux'] }
];

export function starterInput(starter: StarterSnippet, t: TranslateFn): SnippetInput {
    return {
        name: t(`snippets.starters.${starter.key}.name`),
        description: t(`snippets.starters.${starter.key}.description`),
        command: starter.command,
        tags: starter.tags,
        server_id: null
    };
}
