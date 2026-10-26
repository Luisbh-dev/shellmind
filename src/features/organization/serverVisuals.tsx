import { AppWindow, Database, Folder, Server, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { ServerSummary, ServerType } from '@shared/types';
import { t } from '@/i18n';
import { OsIcon } from './OsIcon';
import { osKindOf } from './osKind';

// Icon of a server type (type pickers).
export const TYPE_ICONS: Record<ServerType, LucideIcon> = {
    linux: Server,
    windows: AppWindow,
    ftp: Folder,
    s3: Database,
    local: TerminalSquare
};

// The row icon: the OS a session detected, the protocol or the CLI preset.
export function ServerIcon({ server, className }: { server: ServerSummary; className?: string }) {
    return <OsIcon kind={osKindOf(server)} className={className} />;
}

// Short badge next to the name: protocol for FTP/S3, preset for local CLIs,
// the first word of the detected OS otherwise.
export function serverBadge(server: ServerSummary): string | null {
    if (server.type === 'ftp') return server.ftp_secure ? 'FTPS' : 'FTP';
    if (server.type === 's3') return 'S3';
    if (server.type === 'local') return server.cli_preset && server.cli_preset !== 'shell' ? server.cli_preset : 'CLI';
    return server.os_detail?.split(' ')[0] || null;
}

// The second line of a row: address (with user), bucket, or local command.
export function serverSubtitle(server: ServerSummary): string {
    if (server.type === 'local') {
        if (server.cli_preset && !['shell', 'custom'].includes(server.cli_preset)) return t('sidebar.cliConsole', { preset: server.cli_preset });
        return server.command || t('sidebar.systemShell');
    }
    if (server.type === 's3') return server.s3_bucket || server.s3_endpoint || '';
    return server.username ? `${server.username}@${server.ip}` : server.ip;
}
