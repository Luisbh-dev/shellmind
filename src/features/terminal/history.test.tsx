import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { setLanguage } from '@/i18n';
import { HISTORY_LIMIT, loadFavorites, loadHistory, useCommandHistory } from './history';
import { HistoryPanel } from './HistoryPanel';

// jsdom (a .tsx test): localStorage is real.

const SERVER = 7;
const historyKey = `shellmind-terminal-history:${SERVER}`;
const favoritesKey = `shellmind-favorite-commands:${SERVER}`;
const legacyKey = `shellmind-command-history:${SERVER}`;

beforeEach(() => {
    setLanguage('en');
    localStorage.clear();
    useCommandHistory.setState({ history: {}, favorites: {} });
});

afterEach(() => {
    setLanguage('system');
});

describe('stored history and favorites', () => {
    it('loads favorites even when there is no history (terminal-favorites-not-loaded)', () => {
        localStorage.setItem(favoritesKey, JSON.stringify([{ id: 'f1', command: 'df -h', addedAt: 1 }]));
        expect(loadHistory(SERVER)).toEqual([]);
        expect(loadFavorites(SERVER)).toEqual([{ id: 'f1', command: 'df -h', addedAt: 1 }]);
    });

    it('drops malformed entries and survives broken JSON', () => {
        localStorage.setItem(historyKey, JSON.stringify([{ id: 'a', command: 'ls', timestamp: 1, source: 'hint' }, { id: 'b' }, 'x', null]));
        localStorage.setItem(favoritesKey, '{not json');
        expect(loadHistory(SERVER).map((entry) => entry.id)).toEqual(['a']);
        expect(loadFavorites(SERVER)).toEqual([]);
    });

    it('migrates the pre-1.0 history without its typed entries, which may hold passwords', () => {
        localStorage.setItem(legacyKey, JSON.stringify([
            { id: '1', command: 'hunter2', timestamp: 1, source: 'typed' },
            { id: '2', command: 'df -h', timestamp: 2, source: 'hint' },
            { id: '3', command: 'apt update', timestamp: 3, source: 'ai' }
        ]));
        expect(loadHistory(SERVER).map((entry) => entry.command)).toEqual(['df -h', 'apt update']);
        expect(localStorage.getItem(legacyKey)).toBeNull();
        expect(localStorage.getItem(historyKey)).not.toContain('hunter2');
    });
});

describe('useCommandHistory', () => {
    const state = () => useCommandHistory.getState();

    it('records newest first, without duplicates, up to the limit', () => {
        state().record(SERVER, 'ls', 'typed');
        state().record(SERVER, 'pwd', 'hint');
        state().record(SERVER, 'ls', 'ai');
        expect(state().history[SERVER].map((entry) => [entry.command, entry.source])).toEqual([['ls', 'ai'], ['pwd', 'hint']]);

        for (let i = 0; i < HISTORY_LIMIT + 5; i++) state().record(SERVER, `echo ${i}`, 'typed');
        expect(state().history[SERVER]).toHaveLength(HISTORY_LIMIT);
        expect(JSON.parse(localStorage.getItem(historyKey) ?? '[]')).toHaveLength(HISTORY_LIMIT);
    });

    it('keeps multi-line commands as they were run', () => {
        state().record(SERVER, 'cd /srv\r\nls\n', 'ai');
        expect(state().history[SERVER][0].command).toBe('cd /srv\nls');
    });

    it('deletes single entries and clears the list, keeping favorites', () => {
        state().record(SERVER, 'ls', 'typed');
        state().record(SERVER, 'pwd', 'typed');
        state().toggleFavorite(SERVER, 'ls');
        state().remove(SERVER, state().history[SERVER][0].id);
        expect(state().history[SERVER].map((entry) => entry.command)).toEqual(['ls']);
        state().clear(SERVER);
        expect(state().history[SERVER]).toEqual([]);
        expect(JSON.parse(localStorage.getItem(historyKey) ?? 'null')).toEqual([]);
        expect(state().favorites[SERVER].map((entry) => entry.command)).toEqual(['ls']);
    });

    it('toggles favorites and persists them', () => {
        state().toggleFavorite(SERVER, 'df -h');
        expect(JSON.parse(localStorage.getItem(favoritesKey) ?? '[]')).toEqual([expect.objectContaining({ command: 'df -h' })]);
        state().toggleFavorite(SERVER, 'df -h');
        expect(state().favorites[SERVER]).toEqual([]);
    });

    it('names the command each history button acts on, for screen readers', () => {
        state().record(SERVER, 'systemctl status nginx', 'typed');
        state().record(SERVER, `echo ${'x'.repeat(100)}`, 'typed');
        state().toggleFavorite(SERVER, 'systemctl status nginx');
        render(
            <ConfirmProvider>
                <HistoryPanel serverId={SERVER} serverName="web" onRun={vi.fn()} onRunFavorite={vi.fn()} onNotice={vi.fn()} onClose={vi.fn()} />
            </ConfirmProvider>
        );
        // The favorite's star, and its row in the recent list.
        expect(screen.getAllByRole('button', { name: 'Remove “systemctl status nginx” from favorites' })).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Delete “systemctl status nginx” from history' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: `Save “echo ${'x'.repeat(55)}…” as favorite` })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Delete “systemctl status nginx” from history' }));
        expect(state().history[SERVER].map((entry) => entry.command)).toEqual([`echo ${'x'.repeat(100)}`]);
    });

    it('loads a server once', () => {
        localStorage.setItem(historyKey, JSON.stringify([{ id: 'a', command: 'ls', timestamp: 1, source: 'hint' }]));
        state().load(SERVER);
        localStorage.setItem(historyKey, '[]');
        state().load(SERVER);
        expect(state().history[SERVER].map((entry) => entry.id)).toEqual(['a']);
    });
});
