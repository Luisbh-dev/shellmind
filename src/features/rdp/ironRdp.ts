import type { UserInteraction } from '@devolutions/iron-remote-desktop';

// The IronRDP client (Devolutions): the <iron-remote-desktop> web component
// and its RDP backend compiled to WebAssembly (about 6 MB, inlined in the
// module). Both load on the first connection, never with the app; the build
// puts the backend in its own chunk and the CSP allows its WebAssembly
// ('wasm-unsafe-eval') and the data: URL it is fetched from.

export type IronRdpClient = {
    // The backend module the element's `module` property takes.
    backend: unknown;
    displayControl: (enable: boolean) => unknown;
    enableCredssp: (enable: boolean) => unknown;
};

// The custom element: set its properties before it is connected.
export type RemoteDesktopElement = HTMLElement & {
    module?: unknown;
    scale?: string;
    verbose?: string;
    flexcenter?: string;
};

export type { UserInteraction };

let loading: Promise<IronRdpClient> | null = null;

export function loadIronRdp(): Promise<IronRdpClient> {
    loading ??= (async () => {
        // Defines <iron-remote-desktop>.
        await import('@devolutions/iron-remote-desktop');
        const rdp = await import('@devolutions/iron-remote-desktop-rdp');
        await rdp.init('WARN');
        return { backend: rdp.Backend, displayControl: rdp.displayControl, enableCredssp: rdp.enableCredssp };
    })().catch((error: unknown) => {
        // A failed download can be retried with the next connection.
        loading = null;
        throw error;
    });
    return loading;
}
