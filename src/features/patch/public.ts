// What the rest of the app uses of the patch center, kept light (the global
// action and the Operations tab load with the app): the action's id and the
// hand-off that opens the patch center on a server or on a run to start. It
// also tells multi-exec's job history how to show patch jobs (their output in
// the user's language) and how to run them again: from the patch center,
// which plans them, reboots and records them as patch runs. The views
// themselves load when first shown.
import { PackageCheck, RotateCcw } from 'lucide-react';
import { isPatchJob, patchJobMode, type PatchMode } from '@shared/patch';
import { registerJobKind } from '@/lib/jobKinds';
import { useAppStore } from '@/store/appStore';
import { localizePatchRuns } from './output';

export const PATCH_ACTION_ID = 'patch-center';

// A run to plan in the patch center (its apply dialog, on these servers).
export type PatchRunHandoff = { serverIds: number[]; mode: PatchMode | null };

let focusServerId: number | null = null;
let runHandoff: PatchRunHandoff | null = null;

// Opens the patch center with this server's updates beside the table.
export function openPatchCenter(serverId: number | null = null): void {
    focusServerId = serverId;
    useAppStore.getState().openAction(PATCH_ACTION_ID);
}

// Opens the patch center on a new run for these servers (planned again,
// previewed and confirmed there), e.g. where a patch job failed.
export function openPatchRun(run: PatchRunHandoff): void {
    runHandoff = run.serverIds.length ? run : null;
    openPatchCenter();
}

// The server and the run the patch center was opened on. The patch center
// reads them while it mounts (StrictMode runs state initializers twice and
// keeps one result, so reading must not clear them) and clears them once it
// is on screen.
export function pendingFocusServer(): number | null {
    return focusServerId;
}

export function pendingRunHandoff(): PatchRunHandoff | null {
    return runHandoff;
}

export function clearPatchHandoff(): void {
    focusServerId = null;
    runHandoff = null;
}

registerJobKind({
    matches: isPatchJob,
    present: localizePatchRuns,
    actions: (info, unfinished, t) => [
        ...(unfinished.length
            ? [{
                id: 'patch-retry',
                label: t('patch.history.retry', { count: unfinished.length }),
                title: t('patch.history.retryHint'),
                icon: RotateCcw,
                run: () => openPatchRun({ serverIds: unfinished.map((server) => server.serverId), mode: patchJobMode(info) })
            }]
            : []),
        { id: 'patch-open', label: t('patch.history.open'), icon: PackageCheck, primary: true, run: () => openPatchCenter() }
    ]
});
