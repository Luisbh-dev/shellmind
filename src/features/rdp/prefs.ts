// How this device shows each Windows server's remote desktop (localStorage):
// never a credential, only choices. "Ask for the password each time" is not
// one of them: the backend keeps and enforces it (GET/PUT /api/rdp/options).

export const RESOLUTIONS = ['auto', '1280x720', '1600x900', '1920x1080'] as const;
export type Resolution = typeof RESOLUTIONS[number];

export type RdpPrefs = {
    // "auto" follows the size of the panel (and resizes the remote desktop with it).
    resolution: Resolution;
    // Scale the remote desktop down to fit when it is larger than the panel.
    fit: boolean;
    clipboard: boolean;
    // "unicode" types characters (right with any remote keyboard layout);
    // "scancode" sends key positions, read with the remote layout.
    keyboard: 'unicode' | 'scancode';
};

export const DEFAULT_PREFS: RdpPrefs = { resolution: 'auto', fit: true, clipboard: true, keyboard: 'unicode' };

const key = (serverId: number) => `shellmind.rdp.prefs.${serverId}`;

function storage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

export function readPrefs(serverId: number): RdpPrefs {
    try {
        const raw = storage()?.getItem(key(serverId));
        if (!raw) return DEFAULT_PREFS;
        const parsed = JSON.parse(raw) as Partial<Record<keyof RdpPrefs, unknown>>;
        return {
            resolution: RESOLUTIONS.includes(parsed.resolution as Resolution) ? parsed.resolution as Resolution : DEFAULT_PREFS.resolution,
            fit: typeof parsed.fit === 'boolean' ? parsed.fit : DEFAULT_PREFS.fit,
            clipboard: typeof parsed.clipboard === 'boolean' ? parsed.clipboard : DEFAULT_PREFS.clipboard,
            keyboard: parsed.keyboard === 'scancode' || parsed.keyboard === 'unicode' ? parsed.keyboard : DEFAULT_PREFS.keyboard
        };
    } catch {
        return DEFAULT_PREFS;
    }
}

export function writePrefs(serverId: number, prefs: RdpPrefs): void {
    try {
        storage()?.setItem(key(serverId), JSON.stringify(prefs));
    } catch {
        // Not remembered on this device; it still applies to this session.
    }
}

export function fixedSize(resolution: Resolution): { width: number; height: number } | null {
    if (resolution === 'auto') return null;
    const [width, height] = resolution.split('x').map(Number);
    return { width, height };
}
