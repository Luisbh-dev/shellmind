// Work in a server's file manager that closing the server would throw away:
// files open in the editor with unsaved changes and transfers still to
// finish. Switching servers keeps it (every open server stays mounted);
// closing one, or the app making room for another, asks first: each report
// below registers an unsaved-work guard (useUnsavedGuard) that the
// open-servers list runs (collectUnsavedWork).
import { t } from '@/i18n';
import { useUnsavedGuard } from '@/store/appStore';

// Reported by the remote editor while `dirty`.
export function useReportUnsavedFile(serverId: number, path: string, dirty: boolean): void {
    useUnsavedGuard(serverId, dirty ? () => t('app.openServers.work.unsavedFile', { path }) : null);
}

// Reported by the file manager: its transfers that are not finished.
export function useReportTransfers(serverId: number, count: number): void {
    useUnsavedGuard(serverId, count
        ? () => (count === 1 ? t('app.openServers.work.transfer') : t('app.openServers.work.transfers', { count }))
        : null);
}
