import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { setLanguage } from '@/i18n';
import { SessionToolbar } from './SessionToolbar';

function renderToolbar() {
    setLanguage('en');
    const onLeave = vi.fn();
    const noop = () => undefined;
    render(
        <SessionToolbar
            panel={null}
            hasHints={false}
            shortcuts={{ copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', search: 'Ctrl+Shift+F' }}
            onPaste={noop}
            onCopySelection={noop}
            onCopyOutput={noop}
            onAskAi={noop}
            onClear={noop}
            onTogglePanel={noop}
            onLeave={onLeave}
        />
    );
    return { onLeave, toolbar: screen.getByRole('toolbar') };
}

describe('SessionToolbar', () => {
    it('moves between its buttons with the arrow keys and goes back to the terminal on Escape (UX-12)', () => {
        const { onLeave, toolbar } = renderToolbar();
        const buttons = Array.from(toolbar.querySelectorAll('button'));
        buttons[0].focus();
        fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
        expect(buttons[1]).toHaveFocus();
        fireEvent.keyDown(buttons[1], { key: 'Home' });
        expect(buttons[0]).toHaveFocus();

        expect(fireEvent.keyDown(buttons[0], { key: 'Escape' })).toBe(false);
        expect(onLeave).toHaveBeenCalledTimes(1);
    });
});
