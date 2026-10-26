import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import { APP_VERSION, compareReleases } from '@/lib/version';
import { WHATS_NEW_RELEASE, WelcomeScreen, welcomeServers } from './WelcomeScreen';

const server = (id: number, sort_order: number): ServerSummary => ({ id, name: `s${id}`, ip: `10.0.0.${id}`, type: 'linux', sort_order });
const SERVERS = [server(1, 2), server(2, 0), server(3, 1), server(4, 3)];

describe('welcomeServers', () => {
    it('lists the recently opened servers first, newest first', () => {
        expect(welcomeServers(SERVERS, { 4: 100, 1: 300, 9: 500 })).toEqual({ recent: true, servers: [SERVERS[0], SERVERS[3]] });
    });

    it('falls back to the saved order when nothing was opened on this device', () => {
        expect(welcomeServers(SERVERS, {})).toEqual({ recent: false, servers: [SERVERS[1], SERVERS[2], SERVERS[0], SERVERS[3]] });
    });

    it('shows a handful at most', () => {
        const many = Array.from({ length: 10 }, (_, index) => server(index + 1, index));
        expect(welcomeServers(many, {}).servers).toHaveLength(6);
        expect(welcomeServers(many, Object.fromEntries(many.map((entry) => [entry.id, entry.id]))).servers.map((entry) => entry.id))
            .toEqual([10, 9, 8, 7, 6, 5]);
        expect(welcomeServers(many, {}, 2).servers).toHaveLength(2);
    });
});

describe('What’s new', () => {
    afterEach(() => setLanguage('system'));

    // Its heading names the release the list describes, whatever the build's
    // version says until it is bumped.
    it('names the release its list is about', () => {
        setLanguage('en');
        const noop = () => undefined;
        render(
            <WelcomeScreen servers={[]} loading={false} recent={{}} paletteShortcut="Ctrl+K" onSelectServer={noop} onNewConnection={noop}
                onImportSshConfig={noop} onOpenLocalShell={noop} onOpenPalette={noop} onOpenAppearance={noop} />
        );
        expect(screen.getByRole('heading', { name: `New in ${WHATS_NEW_RELEASE}` })).toBeInTheDocument();
    });

    // A build of a later release with the list still on this one: update the
    // list (and WHATS_NEW_RELEASE) for the release being built.
    it('is not older than the release being built', () => {
        expect(compareReleases(WHATS_NEW_RELEASE, APP_VERSION)).toBeGreaterThanOrEqual(0);
        expect(compareReleases('0.10', '0.9.3')).toBeGreaterThan(0);
        expect(compareReleases('0.4', '0.4.0')).toBe(0);
        expect(compareReleases('0.4', '1.0.0-beta')).toBeLessThan(0);
    });
});
