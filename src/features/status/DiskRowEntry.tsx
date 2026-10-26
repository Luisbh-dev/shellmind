import { Eraser } from 'lucide-react';
import type { Tone } from '@shared/thresholds';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { openDiskView } from '@/store/diskView';

// The disk toolkit's way in from a filesystem row of the Status page: the
// whole row explores that filesystem (one button stretched over it), and a
// row at warning or critical also offers "Free up space", which opens the
// cleanups. Rendered inside the row (a positioned element).
export function DiskRowEntry({ serverId, mount, tone }: { serverId: number; mount: string; tone: Tone }) {
    const t = useT();
    return (
        <>
            <button
                type="button"
                onClick={() => openDiskView(serverId, mount)}
                aria-label={t('disk.entry.explore', { mount })}
                title={t('disk.entry.explore', { mount })}
                className="absolute -inset-x-2 -inset-y-1 z-10 rounded-lg transition-colors hover:bg-white/[0.04] focus-ring"
            />
            {tone !== 'ok' && (
                <button
                    type="button"
                    onClick={() => openDiskView(serverId, mount, 'cleanup')}
                    aria-label={t('disk.entry.freeUpOn', { mount })}
                    className={cn(
                        'relative z-20 ml-auto inline-flex h-5 shrink-0 items-center gap-1 self-center rounded-md border px-1.5 text-[11px] font-medium leading-none transition-colors focus-ring',
                        tone === 'critical' ? 'border-rose-500/40 text-rose-200 hover:bg-rose-500/15' : 'border-amber-500/40 text-amber-200 hover:bg-amber-500/15'
                    )}
                >
                    <Eraser className="h-3 w-3" aria-hidden="true" />
                    {t('disk.entry.freeUp')}
                </button>
            )}
        </>
    );
}
