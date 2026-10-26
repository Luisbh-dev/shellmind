// W8-T3: jobs that other features start through multi-exec (the patch
// center's runs) show in multi-exec's job history like any other, but they
// are run again from where they came from, and their output may need
// wording. Such a feature registers its kind of job here, so the two
// features never import each other (and the registry stays out of
// multi-exec's own modules, which load on demand).
import type { LucideIcon } from 'lucide-react';
import type { MultiExecJobInfo, MultiExecServerRun } from '@shared/multiexec';
import type { TranslateFn } from '@/i18n';

export type JobKindAction = {
    id: string;
    label: string;
    // A longer explanation (the button's tooltip).
    title?: string;
    icon: LucideIcon;
    primary?: boolean;
    run: () => void;
};

export type JobKind = {
    matches: (info: Pick<MultiExecJobInfo, 'command'>) => boolean;
    // The servers' runs as the job view shows them (e.g. what the feature
    // itself wrote in the output, in the user's language).
    present?: (servers: readonly MultiExecServerRun[], t: TranslateFn) => MultiExecServerRun[];
    // What a finished or running job of this kind offers instead of "run
    // again" and "new job" (`unfinished`: its servers that did not succeed).
    actions: (info: MultiExecJobInfo, unfinished: readonly MultiExecServerRun[], t: TranslateFn) => JobKindAction[];
};

const kinds: JobKind[] = [];

// Registers a kind of job; the returned function removes it.
export function registerJobKind(kind: JobKind): () => void {
    kinds.push(kind);
    return () => {
        const index = kinds.indexOf(kind);
        if (index !== -1) kinds.splice(index, 1);
    };
}

export function jobKindOf(info: Pick<MultiExecJobInfo, 'command'>): JobKind | null {
    return kinds.find((kind) => kind.matches(info)) ?? null;
}
