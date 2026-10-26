import { Server, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OsKind } from './osKind';

// Small brand-coloured marks for operating systems, cloud CLIs and storage
// protocols (16×16, simplified so they read at sidebar size). Decorative:
// the row's text names the server.

type Glyph = () => JSX.Element;

const GLYPHS: Partial<Record<OsKind, Glyph>> = {
    ubuntu: () => (
        <>
            <circle cx="8" cy="8" r="7.5" fill="#E95420" />
            <circle cx="8" cy="8" r="3.4" fill="none" stroke="#fff" strokeWidth="1.3" />
            <g fill="#fff" stroke="#E95420" strokeWidth="0.9">
                <circle cx="12.6" cy="8" r="1.45" />
                <circle cx="5.7" cy="12" r="1.45" />
                <circle cx="5.7" cy="4" r="1.45" />
            </g>
        </>
    ),
    debian: () => (
        <path
            d="M10.9 3.4A5.4 5.4 0 1 0 13.2 9.8M13.2 9.8a3.3 3.3 0 0 1-6.3-.4 2.4 2.4 0 0 1 2.6-2.8 1.6 1.6 0 0 1 1.3 2.2"
            fill="none" stroke="#D70A53" strokeWidth="1.7" strokeLinecap="round"
        />
    ),
    alpine: () => (
        <>
            <path d="M4.3 1.5h7.4L15.4 8l-3.7 6.5H4.3L.6 8z" fill="#1673B0" />
            <path d="M3.6 10.8 6.6 6.6l1.9 2.6 1.2-1.5 2.7 3.1z" fill="#fff" />
        </>
    ),
    rhel: () => (
        <path
            d="M10.6 9.1c.9.2 1.4.6 1.4 1 0 .7-1.5.8-3.3.4C6.4 9.9 3.6 8.6 3.6 7.8c0-.1 0-.2.1-.3-1 .2-1.7.6-1.7 1.1 0 1 3 2.6 6.3 3.4 3.5.8 6.2.5 6.2-.7 0-.8-1.3-1.7-3.4-2.4zM6.8 3.6c.9 0 2 .5 2.8.4.6 0 .9-.2 1.2.4l.9 3.9c-1.3 1-6.2-.5-7.6-1.9l1.1-1.6c.3-.6.9-1.2 1.6-1.2z"
            fill="#EE0000"
        />
    ),
    centos: () => (
        <g transform="rotate(45 8 8)">
            <rect x="2.6" y="2.6" width="4.9" height="4.9" rx="0.6" fill="#9CCD2A" />
            <rect x="8.5" y="2.6" width="4.9" height="4.9" rx="0.6" fill="#932279" />
            <rect x="8.5" y="8.5" width="4.9" height="4.9" rx="0.6" fill="#EFA724" />
            <rect x="2.6" y="8.5" width="4.9" height="4.9" rx="0.6" fill="#262577" />
        </g>
    ),
    rocky: () => (
        <>
            <circle cx="8" cy="8" r="7.5" fill="#10B981" />
            <path d="M2.4 12.2 6.6 7.6l2.3 2.4 1.5-1.5 3.3 3.6A7.5 7.5 0 0 1 2.4 12.2z" fill="#fff" />
        </>
    ),
    alma: () => (
        <>
            <circle cx="8" cy="3.2" r="2.3" fill="#FF4649" />
            <circle cx="12.6" cy="6.6" r="2.3" fill="#FFCB12" />
            <circle cx="10.8" cy="12.2" r="2.3" fill="#86DA2F" />
            <circle cx="5.2" cy="12.2" r="2.3" fill="#24C2FF" />
            <circle cx="3.4" cy="6.6" r="2.3" fill="#0069DA" />
        </>
    ),
    fedora: () => (
        <>
            <path d="M8 .6a7.4 7.4 0 1 1 0 14.8H2.2A1.6 1.6 0 0 1 .6 13.8V8A7.4 7.4 0 0 1 8 .6z" fill="#51A2DA" />
            <path d="M10.6 4.3c-1.6-.6-3.3.2-3.3 2v5.1c0 1.3-1 2-2.2 1.8M5.4 8.3h4.4" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </>
    ),
    arch: () => (
        <path
            d="M8 .8c-.6 1.5-1 2.5-1.6 3.8.4.4.9.8 1.8 1.4-.9-.4-1.5-.8-2.1-1.2C5 7 3.4 10.1 1 14.6c1.8-1 3.3-1.7 4.7-2.1l-.1-.6c0-1.5 1.1-2.7 2.4-2.7s2.4 1.3 2.4 2.7l-.1.6c1.4.4 2.9 1.1 4.7 2.1-.4-.7-.7-1.3-1.1-1.9-.7-.6-1.5-1.1-2.6-1.6.8.2 1.5.4 2.1.7C11.7 8.6 10.1 5.7 8 .8z"
            fill="#1793D1"
        />
    ),
    suse: () => (
        <>
            <rect x="0.5" y="1.5" width="15" height="13" rx="3.5" fill="#73BA25" />
            <path d="M4.4 10.6a3 3 0 1 1 4.6-3.4c.2.7.9 1 1.5.7" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="11.3" cy="5.3" r="1.2" fill="#fff" />
        </>
    ),
    windows: () => (
        <g fill="#0078D4">
            <rect x="1.2" y="1.2" width="6.4" height="6.4" rx="0.4" />
            <rect x="8.4" y="1.2" width="6.4" height="6.4" rx="0.4" />
            <rect x="1.2" y="8.4" width="6.4" height="6.4" rx="0.4" />
            <rect x="8.4" y="8.4" width="6.4" height="6.4" rx="0.4" />
        </g>
    ),
    macos: () => (
        <path
            d="M12.2 8.5c0-1.5 1.2-2.2 1.3-2.3-.7-1-1.8-1.2-2.2-1.2-.9-.1-1.8.6-2.3.6-.5 0-1.2-.5-2-.5-1 0-2 .6-2.5 1.6-1.1 1.9-.3 4.7.8 6.2.5.8 1.1 1.6 1.9 1.6s1.1-.5 2-.5c1 0 1.2.5 2.1.5.8 0 1.4-.8 1.9-1.5.6-.9.8-1.7.8-1.7s-1.8-.7-1.8-2.8zM10.6 3.7c.4-.5.7-1.3.6-2-.6 0-1.4.4-1.8 1-.4.4-.8 1.2-.7 1.9.7 0 1.4-.4 1.9-.9z"
            fill="currentColor"
        />
    ),
    freebsd: () => (
        <>
            <circle cx="8" cy="9" r="5.8" fill="#AB2B28" />
            <path d="M1.4 1.6c1.6-.4 3.4.3 4.3 1.3-1.5.5-2.6 1.6-3.2 2.9C1.6 4.7 1.1 3 1.4 1.6zM14.6 1.6c-1.6-.4-3.4.3-4.3 1.3 1.5.5 2.6 1.6 3.2 2.9.9-1.1 1.4-2.8 1.1-4.2z" fill="#AB2B28" />
            <ellipse cx="6.3" cy="7.6" rx="1.6" ry="1" fill="#fff" fillOpacity="0.35" transform="rotate(-30 6.3 7.6)" />
        </>
    ),
    linux: () => (
        <>
            <path d="M8 1c-1.8 0-2.7 1.4-2.7 3.2 0 1.3-.4 2-1.2 3.2C3 8.8 2.5 10.2 2.9 11.6h10.2c.4-1.4-.1-2.8-1.2-4.2-.8-1.2-1.2-1.9-1.2-3.2C10.7 2.4 9.8 1 8 1z" fill="currentColor" />
            <path d="M8 6.3c-1.5 0-2.7 1.9-2.7 4.1 0 .6.1 1 .2 1.4h5c.1-.4.2-.8.2-1.4 0-2.2-1.2-4.1-2.7-4.1z" fill="#fff" />
            <circle cx="6.9" cy="3.9" r="0.55" fill="#fff" />
            <circle cx="9.1" cy="3.9" r="0.55" fill="#fff" />
            <path d="M7 4.9h2l-1 .9z" fill="#F5B800" />
            <path d="M2.6 13.4c0-1 .9-1.8 2-1.8s2.1 1.2 2.1 2.2c0 .7-.6 1.1-1.5 1.1-1.3 0-2.6-.6-2.6-1.5zM13.4 13.4c0-1-.9-1.8-2-1.8s-2.1 1.2-2.1 2.2c0 .7.6 1.1 1.5 1.1 1.3 0 2.6-.6 2.6-1.5z" fill="#F5B800" />
        </>
    ),
    docker: () => (
        <>
            <path d="M.9 8.4h12.3c.6 0 1.5-.3 1.9-1.1.4.3.8.4 1 .4-.3 1-1.2 1.7-2.2 1.8C13.1 12.3 10.6 14 6.8 14 3 14 1.2 11.7.9 8.4z" fill="#2496ED" />
            <g fill="#2496ED">
                <rect x="2.2" y="5.9" width="1.9" height="1.8" rx="0.2" />
                <rect x="4.4" y="5.9" width="1.9" height="1.8" rx="0.2" />
                <rect x="6.6" y="5.9" width="1.9" height="1.8" rx="0.2" />
                <rect x="8.8" y="5.9" width="1.9" height="1.8" rx="0.2" />
                <rect x="4.4" y="3.8" width="1.9" height="1.8" rx="0.2" />
                <rect x="6.6" y="3.8" width="1.9" height="1.8" rx="0.2" />
                <rect x="6.6" y="1.7" width="1.9" height="1.8" rx="0.2" />
            </g>
        </>
    ),
    kubernetes: () => (
        <>
            <path d="M8 .6l5.9 2.9 1.5 6.4-4.1 5.2H4.7L.6 9.9l1.5-6.4z" fill="#326CE5" />
            <circle cx="8" cy="8.2" r="2.6" fill="none" stroke="#fff" strokeWidth="1.1" />
            <path d="M8 3.4v2.2M8 10.8v2.2M3.3 6.6l2.2.7M10.5 9.1l2.2.7M4.5 12.2l1.6-1.8M9.9 6l1.6-1.8M12.7 6.6l-2.2.7M5.5 9.1l-2.2.7" stroke="#fff" strokeWidth="1" strokeLinecap="round" />
        </>
    ),
    aws: () => (
        <>
            <rect x="0.5" y="1.5" width="15" height="13" rx="3" fill="#232F3E" />
            <path d="M3.4 9.3c2.8 1.8 6.6 1.9 9.2.2" fill="none" stroke="#FF9900" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M11.2 8.7l1.6.7-.4 1.7" fill="none" stroke="#FF9900" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4.2 6.6l.9-2.4.9 2.4M4.5 5.8h1.2M7 4.2l.6 2.4.7-1.8.7 1.8.6-2.4M12 4.5c-.3-.4-1.6-.5-1.6.3 0 .8 1.7.4 1.7 1.2 0 .8-1.3.8-1.8.3" fill="none" stroke="#fff" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round" />
        </>
    ),
    azure: () => (
        <>
            <path d="M6.1 1.6h3.6L4.6 14.4H1.1a.5.5 0 0 1-.5-.7z" fill="#0A5BC4" />
            <path d="M10.1 4.9l5.2 8.8a.5.5 0 0 1-.4.7H6.4l4.6-1.1-2.4-4.3z" fill="#2EA3F2" />
        </>
    ),
    gcp: () => (
        <>
            <path d="M10.2 4.7l1.3-1.3.1-.6A5.7 5.7 0 0 0 2.4 5.6l.4-.1 2.6-.4.2-.2a3.6 3.6 0 0 1 4.6-.2z" fill="#EA4335" />
            <path d="M13.8 5.7a5.8 5.8 0 0 0-1.7-2.8l-1.9 1.9a3.4 3.4 0 0 1 1.2 2.6v.3a1.7 1.7 0 1 1 0 3.4H8.1l-.3.4v2l.3.3h3.3a4.3 4.3 0 0 0 2.4-8.1z" fill="#4285F4" />
            <path d="M4.7 13.8h3.4v-2.7H4.7c-.2 0-.5-.1-.7-.2l-.5.2-1.4 1.3-.1.5c.7.6 1.7.9 2.7.9z" fill="#34A853" />
            <path d="M4.7 5.2A4.3 4.3 0 0 0 2 12.9l2-2a1.7 1.7 0 1 1 2.3-2.3l2-2a4.3 4.3 0 0 0-3.6-1.4z" fill="#FBBC05" />
        </>
    ),
    ftp: () => (
        <>
            <path d="M1 3.6c0-.7.5-1.2 1.2-1.2h3.6l1.5 1.5h6.5c.7 0 1.2.5 1.2 1.2v7.6c0 .7-.5 1.2-1.2 1.2H2.2c-.7 0-1.2-.5-1.2-1.2z" fill="#F59E0B" />
            <path d="M6 12V7.4M4.4 9 6 7.3 7.6 9M10 7.2v4.6M8.4 10.1 10 11.8l1.6-1.7" fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </>
    ),
    s3: () => (
        <>
            <path d="M1.8 3.6 3.6 13.2c.2 1 2.2 1.6 4.4 1.6s4.2-.6 4.4-1.6l1.8-9.6z" fill="#E05243" />
            <ellipse cx="8" cy="3.6" rx="6.2" ry="1.9" fill="#F58536" />
            <path d="M3 7.6c1.6.6 3.3.9 5 .9s3.4-.3 5-.9" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="0.9" />
        </>
    )
};

// Colour of the lucide fallbacks.
const FALLBACK_CLASS: Partial<Record<OsKind, string>> = {
    local: 'text-brand-400',
    server: 'text-zinc-400'
};

export function OsIcon({ kind, className }: { kind: OsKind; className?: string }) {
    const glyph = GLYPHS[kind];
    if (!glyph) {
        const Icon = kind === 'local' ? TerminalSquare : Server;
        return <Icon className={cn('h-4 w-4 shrink-0', FALLBACK_CLASS[kind], className)} aria-hidden="true" />;
    }
    return (
        <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            className={cn('h-4 w-4 shrink-0', (kind === 'macos' || kind === 'linux') && 'text-zinc-300', className)}
        >
            {glyph()}
        </svg>
    );
}
