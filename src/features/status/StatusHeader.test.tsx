import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { StatusAiActions } from './StatusHeader';

beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ activeServerId: 7, chatOpen: false });
    setLanguage('en');
});

afterEach(() => {
    setLanguage('system');
});

describe('StatusAiActions', () => {
    it('asks the AI about the status, or attaches the triage pack', () => {
        render(<StatusAiActions serverId={7} />);
        expect(screen.getByRole('group', { name: 'AI help' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Ask AI about this status' }));
        expect(useAppStore.getState()).toMatchObject({
            chatOpen: true,
            chatRequest: { serverId: 7, kind: 'context', attachment: { kind: 'status' }, prompt: 'Is anything wrong with this server, and what should I do about it?' }
        });

        const triage = screen.getByRole('button', { name: 'Triage' });
        expect(triage).toHaveAccessibleDescription(/Collect a triage pack \(failed units, errors of the last hour, disk, memory, processes, listening ports\)/);
        fireEvent.click(triage);
        expect(useAppStore.getState().chatRequest).toMatchObject({ serverId: 7, attachment: { kind: 'triage' } });
        // The server is on screen: no tab switch.
        expect(useAppStore.getState().serverTabRequest).toBeNull();
    });

    it('is translated', () => {
        act(() => setLanguage('es'));
        render(<StatusAiActions serverId={7} />);
        expect(screen.getByRole('button', { name: 'Preguntar a la IA por este estado' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Triaje' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ prompt: 'Revisa este servidor en busca de problemas: servicios con fallos, errores recientes, disco, memoria y los procesos que más consumen.' });
    });
});
