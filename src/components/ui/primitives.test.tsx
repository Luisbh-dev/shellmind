import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, useState } from 'react';
import { setLanguage } from '@/i18n';
import { ConfirmProvider, useConfirm } from './Confirm';
import { ContextMenu } from './ContextMenu';
import { ErrorBoundary } from './ErrorBoundary';
import { Field, Input, PasswordInput } from './Field';
import { IconButton } from './IconButton';
import { Menu } from './Menu';
import { Modal } from './Modal';
import { popoverStyle } from './popover';
import { ResizeHandle } from './ResizeHandle';
import { SegmentedControl } from './SegmentedControl';
import { LazyDialog } from './Skeleton';
import { Select } from './Select';
import { Tabs } from './Tabs';
import { TOAST_DURATION_MS, ToastProvider, useToast } from './Toast';
import { rovingIndex } from './focus';

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('system'));

const escape = () => act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
});

function ModalHarness({ children, onClose = () => undefined }: { children?: React.ReactNode; onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button onClick={() => setOpen(true)}>open dialog</button>
            <Modal open={open} onClose={() => { setOpen(false); onClose(); }} title="Rename file" description="Inside /srv">
                <Field label="New name"><Input /></Field>
                {children}
                <button>last button</button>
            </Modal>
        </>
    );
}

describe('Modal', () => {
    it('is a labelled modal dialog that takes focus, keeps Tab inside and gives focus back', async () => {
        const user = userEvent.setup();
        render(<ModalHarness />);
        const opener = screen.getByRole('button', { name: 'open dialog' });
        await user.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Rename file' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription('Inside /srv');
        expect(screen.getByLabelText('New name')).toHaveFocus();

        await user.tab();
        expect(screen.getByRole('button', { name: 'last button' })).toHaveFocus();
        await user.tab();
        // Wraps to the close button in the header, never to the page behind.
        expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
        await user.tab({ shift: true });
        expect(screen.getByRole('button', { name: 'last button' })).toHaveFocus();

        escape();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(opener).toHaveFocus();
    });

    it('closes only the topmost overlay on Escape (a Select inside a dialog)', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        function WithSelect() {
            const [value, setValue] = useState('aws');
            return (
                <Field label="Provider">
                    <Select value={value} onChange={setValue} options={[{ value: 'aws', label: 'AWS S3' }, { value: 'other', label: 'Other' }]} />
                </Field>
            );
        }
        render(<ModalHarness onClose={onClose}><WithSelect /></ModalHarness>);
        await user.click(screen.getByRole('button', { name: 'open dialog' }));

        const combobox = screen.getByRole('combobox', { name: /Provider/ });
        await user.click(combobox);
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        escape();
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(combobox).toHaveFocus();

        escape();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    // W8-T3: the patch center closes a pane of its own on Escape first.
    it('lets the dialog handle an Escape itself (onEscape), and stays open', () => {
        const onClose = vi.fn();
        let handled = true;
        const onEscape = vi.fn(() => handled);
        render(<Modal open onClose={onClose} onEscape={onEscape} title="Patch center"><button>inside</button></Modal>);
        escape();
        expect(onEscape).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        handled = false;
        escape();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('Confirm', () => {
    function Asker({ tone, onAnswer }: { tone?: 'danger'; onAnswer: (value: boolean) => void }) {
        const confirm = useConfirm();
        return <button onClick={async () => onAnswer(await confirm({ title: 'Delete it?', message: 'For real', tone }))}>ask</button>;
    }

    it('focuses Cancel for destructive confirmations, so Enter does not delete', async () => {
        const user = userEvent.setup();
        const onAnswer = vi.fn();
        render(<ConfirmProvider><Asker tone="danger" onAnswer={onAnswer} /></ConfirmProvider>);
        await user.click(screen.getByRole('button', { name: 'ask' }));

        const dialog = screen.getByRole('alertdialog', { name: 'Delete it?' });
        expect(dialog).toHaveAccessibleDescription('For real');
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
        await user.keyboard('{Enter}');
        expect(onAnswer).toHaveBeenCalledWith(false);
    });

    it('queues a second request instead of dropping the first one', async () => {
        const answers: string[] = [];
        function Twice() {
            const confirm = useConfirm();
            return (
                <button onClick={() => {
                    void confirm({ title: 'First' }).then((ok) => answers.push(`first:${ok}`));
                    void confirm({ title: 'Second' }).then((ok) => answers.push(`second:${ok}`));
                }}>ask twice</button>
            );
        }
        const user = userEvent.setup();
        render(<ConfirmProvider><Twice /></ConfirmProvider>);
        await user.click(screen.getByRole('button', { name: 'ask twice' }));

        expect(screen.getByRole('alertdialog', { name: 'First' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(screen.getByRole('alertdialog', { name: 'Second' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(answers).toEqual(['first:true', 'second:false']);
    });
});

describe('Select', () => {
    const OPTIONS = [
        { value: 'aws', label: 'AWS S3' },
        { value: 'gcs', label: 'Google Cloud', disabled: true },
        { value: 'minio', label: 'MinIO' },
        { value: 'r2', label: 'Cloudflare R2' },
    ];

    function Controlled({ onChange = () => undefined }: { onChange?: (value: string) => void }) {
        const [value, setValue] = useState('aws');
        return (
            <Field label="Provider" hint="Where the bucket lives">
                <Select value={value} onChange={(next) => { setValue(next); onChange(next); }} options={OPTIONS} />
            </Field>
        );
    }

    it('is a labelled combobox driven by the keyboard (arrows skip disabled options)', async () => {
        const user = userEvent.setup();
        render(<Controlled />);
        const combobox = screen.getByRole('combobox', { name: 'Provider AWS S3' });
        expect(combobox).toHaveAccessibleDescription('Where the bucket lives');

        combobox.focus();
        await user.keyboard('{ArrowDown}');
        const listbox = screen.getByRole('listbox');
        expect(combobox).toHaveAttribute('aria-expanded', 'true');
        expect(combobox.getAttribute('aria-activedescendant')).toBe(within(listbox).getByRole('option', { name: 'AWS S3' }).id);

        await user.keyboard('{ArrowDown}');
        expect(combobox.getAttribute('aria-activedescendant')).toBe(within(listbox).getByRole('option', { name: 'MinIO' }).id);
        await user.keyboard('{End}');
        expect(combobox.getAttribute('aria-activedescendant')).toBe(within(listbox).getByRole('option', { name: 'Cloudflare R2' }).id);
        await user.keyboard('{Enter}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(combobox).toHaveTextContent('Cloudflare R2');
        expect(combobox).toHaveFocus();
    });

    it('selects by typing, also while closed', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Controlled onChange={onChange} />);
        screen.getByRole('combobox').focus();
        await user.keyboard('m');
        expect(onChange).toHaveBeenLastCalledWith('minio');
        await user.keyboard('{ArrowDown}');
        await user.keyboard('c');
        await user.keyboard('{Enter}');
        expect(onChange).toHaveBeenLastCalledWith('r2');
    });

    it('opens upwards when there is no room below', () => {
        const viewport = { width: 1024, height: 700 };
        expect(popoverStyle({ top: 100, bottom: 130, left: 10, right: 210, width: 200 }, viewport)).toMatchObject({ top: 136, left: 10, width: 200 });
        const above = popoverStyle({ top: 620, bottom: 650, left: 900, right: 1000, width: 100 }, viewport, { minWidth: 224 });
        expect(above).toMatchObject({ bottom: 86, width: 224, left: 1024 - 224 - 8 });
        expect(above.top).toBeUndefined();
    });

    it('grows to fit its content, never past the viewport', () => {
        const viewport = { width: 400, height: 700 };
        const anchor = { top: 10, bottom: 40, left: 300, right: 330, width: 30 };
        expect(popoverStyle(anchor, viewport, { minWidth: 200, align: 'end', contentWidth: 120 })).toMatchObject({ width: 200, left: 130 });
        expect(popoverStyle(anchor, viewport, { minWidth: 200, align: 'end', contentWidth: 295.4 })).toMatchObject({ width: 296, left: 34 });
        expect(popoverStyle(anchor, viewport, { minWidth: 200, align: 'end', contentWidth: 900 })).toMatchObject({ width: 384, left: 8 });
    });
});

describe('Field and PasswordInput', () => {
    it('associates the label, the hint and the error with the control', () => {
        render(<Field label="Port" hint="1-65535" error="Use a valid port"><Input /></Field>);
        const input = screen.getByLabelText('Port');
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(input).toHaveAccessibleDescription('Use a valid port 1-65535');
    });

    it('has a keyboard-reachable show/hide toggle', async () => {
        const user = userEvent.setup();
        render(<Field label="Password"><PasswordInput defaultValue="s3cret" /></Field>);
        const input = screen.getByLabelText('Password');
        expect(input).toHaveAttribute('type', 'password');
        input.focus();
        await user.tab();
        const toggle = screen.getByRole('button', { name: 'Show password' });
        expect(toggle).toHaveFocus();
        await user.keyboard(' ');
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
        expect(input).toHaveAttribute('type', 'text');
    });
});

describe('Toast', () => {
    function Notifier() {
        const toast = useToast();
        return (
            <>
                <button onClick={() => toast.success('Saved')}>ok</button>
                <button onClick={() => toast.error('Upload failed', 'Permission denied')}>fail</button>
            </>
        );
    }

    it('announces toasts (errors assertively) and pauses while hovered', () => {
        vi.useFakeTimers();
        try {
            render(<ToastProvider><Notifier /></ToastProvider>);
            const region = screen.getByRole('region', { name: 'Notifications' });

            fireEvent.click(screen.getByRole('button', { name: 'ok' }));
            fireEvent.click(screen.getByRole('button', { name: 'fail' }));
            expect(within(region).getByRole('status')).toHaveTextContent('Saved');
            const alert = within(region).getByRole('alert');
            expect(alert).toHaveTextContent('Upload failed');

            act(() => vi.advanceTimersByTime(TOAST_DURATION_MS.success + 100));
            expect(within(region).queryByRole('status')).toBeNull();

            fireEvent.mouseEnter(alert);
            act(() => vi.advanceTimersByTime(TOAST_DURATION_MS.error * 2));
            expect(within(region).getByRole('alert')).toBeInTheDocument();
            fireEvent.mouseLeave(alert);
            act(() => vi.advanceTimersByTime(TOAST_DURATION_MS.error));
            expect(within(region).queryByRole('alert')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    // UX-10: next to the chat the toasts sit in the middle of the screen,
    // over a dialog's header (the fleet board's filters).
    it('moves to the bottom-right corner while a dialog is open', () => {
        function WithDialog() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <Notifier />
                    <button onClick={() => setOpen(true)}>open</button>
                    <Modal open={open} onClose={() => setOpen(false)} title="Fleet health">board</Modal>
                </>
            );
        }
        render(<ToastProvider><WithDialog /></ToastProvider>);
        const region = screen.getByRole('region', { name: 'Notifications' });
        expect(region.style.top).toBe('var(--shellmind-toast-top, 3.25rem)');
        fireEvent.click(screen.getByRole('button', { name: 'open' }));
        expect(region.style.bottom).toBe('1rem');
        expect(region.style.right).toBe('1rem');
        expect(region.style.top).toBe('');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(region.style.top).toBe('var(--shellmind-toast-top, 3.25rem)');
    });
});

describe('Menu', () => {
    it('moves focus into the menu, navigates with arrows and returns focus on Escape', async () => {
        const user = userEvent.setup();
        const onDelete = vi.fn();
        render(
            <Menu label="More actions for web-1" items={[
                { id: 'up', label: 'Move up', onSelect: () => undefined, disabled: true },
                { id: 'down', label: 'Move down', onSelect: () => undefined },
                { id: 'delete', label: 'Delete', onSelect: onDelete, danger: true },
            ]}>…</Menu>
        );
        const trigger = screen.getByRole('button', { name: 'More actions for web-1' });
        trigger.focus();
        await user.keyboard('{ArrowDown}');

        const menu = screen.getByRole('menu', { name: 'More actions for web-1' });
        expect(within(menu).getByRole('menuitem', { name: 'Move down' })).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(within(menu).getByRole('menuitem', { name: 'Move down' })).toHaveFocus();

        escape();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger).toHaveFocus();

        await user.click(trigger);
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes on Tab and moves on from its button, not from the end of the page', async () => {
        const user = userEvent.setup();
        render(
            <>
                <button>before</button>
                <Menu label="Row actions" items={[{ id: 'a', label: 'Rename', onSelect: () => undefined }]}>…</Menu>
                <button>next row</button>
                <button>far away</button>
            </>
        );
        const trigger = screen.getByRole('button', { name: 'Row actions' });
        await user.click(trigger);
        expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
        await user.tab();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.getByRole('button', { name: 'next row' })).toHaveFocus();

        await user.click(trigger);
        await user.tab({ shift: true });
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.getByRole('button', { name: 'before' })).toHaveFocus();
    });
});

describe('roving groups', () => {
    it('Tabs: one Tab stop, arrows select and focus the next tab', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [value, setValue] = useState('a');
            return <Tabs idPrefix="t" aria-label="Sections" value={value} onChange={setValue} items={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]} />;
        }
        render(<Harness />);
        const alpha = screen.getByRole('tab', { name: 'Alpha' });
        expect(alpha).toHaveAttribute('tabindex', '0');
        expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
        alpha.focus();
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Beta', selected: true })).toHaveFocus();
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Alpha', selected: true })).toHaveFocus();
    });

    it('SegmentedControl: a radio group whose arrows change the choice', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [value, setValue] = useState<'password' | 'key'>('password');
            return <SegmentedControl aria-label="Authentication" value={value} onChange={setValue} options={[{ value: 'password', label: 'Password' }, { value: 'key', label: 'Key' }]} />;
        }
        render(<Harness />);
        const group = screen.getByRole('radiogroup', { name: 'Authentication' });
        within(group).getByRole('radio', { name: 'Password' }).focus();
        await user.keyboard('{ArrowRight}');
        expect(within(group).getByRole('radio', { name: 'Key', checked: true })).toHaveFocus();
    });

    // UX-05: brand-300 on the selected tint was 4.42:1 in the light theme
    // (palette.test.ts checks brand-200 there). UX-07: a long translation
    // wraps inside its pill instead of being cut off by the border.
    it('SegmentedControl: the selected option reads at AA and long labels wrap', () => {
        render(<SegmentedControl aria-label="Keyboard" value="scancode" onChange={() => undefined} options={[{ value: 'unicode', label: 'Caracteres' }, { value: 'scancode', label: 'Posición de tecla' }]} />);
        const selected = screen.getByRole('radio', { name: 'Posición de tecla', checked: true });
        expect(selected.className).toContain('text-brand-200');
        expect(selected.className).not.toContain('text-brand-300');
        expect(selected.className).toContain('min-w-0');
        expect(within(selected).getByText('Posición de tecla').className).toContain('break-words');
    });

    it('computes wrapping arrow navigation', () => {
        expect(rovingIndex('ArrowRight', 2, 3)).toBe(0);
        expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2);
        expect(rovingIndex('ArrowDown', 0, 3, 'horizontal')).toBeNull();
        expect(rovingIndex('End', 0, 3)).toBe(2);
        expect(rovingIndex('x', 0, 3)).toBeNull();
    });
});

describe('ResizeHandle', () => {
    it('is a focusable splitter resized with the arrow keys within its bounds', () => {
        const onChange = vi.fn();
        const onReset = vi.fn();
        render(<ResizeHandle value={300} min={200} max={400} onChange={onChange} onReset={onReset} panel="after" label="Resize the chat panel" />);
        const handle = screen.getByRole('separator', { name: 'Resize the chat panel' });
        expect(handle).toHaveAttribute('aria-valuenow', '300');

        // The panel is after the handle: moving left makes it wider.
        fireEvent.keyDown(handle, { key: 'ArrowLeft' });
        expect(onChange).toHaveBeenLastCalledWith(316);
        fireEvent.keyDown(handle, { key: 'End' });
        expect(onChange).toHaveBeenLastCalledWith(400);
        fireEvent.keyDown(handle, { key: 'Enter' });
        expect(onReset).toHaveBeenCalled();
    });
});

describe('ErrorBoundary', () => {
    it('shows a recovery screen and remounts the children on retry', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const silence = (event: ErrorEvent) => event.preventDefault();
        window.addEventListener('error', silence);
        const state = { broken: true };
        function Fragile() {
            if (state.broken) throw new Error('bad render');
            return <p>all good</p>;
        }
        try {
            const user = userEvent.setup();
            render(<ErrorBoundary scope="app"><Fragile /></ErrorBoundary>);
            expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
            expect(screen.getByRole('alert')).toHaveTextContent('bad render');

            state.broken = false;
            await user.click(screen.getByRole('button', { name: 'Try again' }));
            expect(screen.getByText('all good')).toBeInTheDocument();
        } finally {
            window.removeEventListener('error', silence);
            vi.mocked(console.error).mockRestore();
        }
    });
});

describe('LazyDialog', () => {
    it('shows a placeholder while the dialog loads, then the dialog', async () => {
        let resolve: (module: { default: () => JSX.Element }) => void = () => undefined;
        const Dialog = lazy(() => new Promise<{ default: () => JSX.Element }>((done) => { resolve = done; }));
        render(<LazyDialog onClose={() => undefined}><Dialog /></LazyDialog>);
        expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();

        await act(async () => resolve({ default: () => <Modal open onClose={() => undefined} title="Snippets">body</Modal> }));
        expect(screen.getByRole('dialog', { name: 'Snippets' })).toBeInTheDocument();
        expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    });

    it('reports a dialog whose code cannot be loaded, and closes it', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const silence = (event: ErrorEvent) => event.preventDefault();
        window.addEventListener('error', silence);
        try {
            const onClose = vi.fn();
            const Broken = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
            render(<LazyDialog onClose={onClose}><Broken /></LazyDialog>);
            const dialog = await screen.findByRole('dialog', { name: 'This window could not be opened' });
            expect(dialog).toHaveTextContent('Its code could not be downloaded');
            fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);
            expect(onClose).toHaveBeenCalled();
        } finally {
            window.removeEventListener('error', silence);
            vi.mocked(console.error).mockRestore();
        }
    });
});

describe('ContextMenu', () => {
    it('moves focus to its first item once it is placed, so arrow keys act on the menu', async () => {
        // Focusing a visibility:hidden element does nothing in a browser
        // (jsdom does focus it), so every focus call into the menu is checked.
        const calls: Array<{ item: string; visibility: string }> = [];
        const original = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
            const menu = this.closest<HTMLElement>('[role="menu"]');
            if (menu) calls.push({ item: this.textContent ?? '', visibility: menu.style.visibility });
            original.call(this, options);
        };
        try {
            const onSelect = vi.fn();
            render(
                <>
                    <button type="button">row</button>
                    <ContextMenu
                        x={10}
                        y={10}
                        label="Actions"
                        onClose={() => undefined}
                        items={[{ id: 'open', label: 'Open', onSelect: () => undefined }, { id: 'edit', label: 'Edit', onSelect }]}
                    />
                </>
            );
            const menu = screen.getByRole('menu', { name: 'Actions' });
            expect(menu.style.visibility).toBe('visible');
            expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
            expect(calls.filter((call) => call.visibility !== 'visible')).toEqual([]);

            await userEvent.keyboard('{ArrowDown}{Enter}');
            expect(onSelect).toHaveBeenCalledTimes(1);
        } finally {
            HTMLElement.prototype.focus = original;
        }
    });
});

describe('IconButton', () => {
    it('explains why it is unavailable: focusable, with the reason as tooltip and description', async () => {
        const onClick = vi.fn();
        render(<IconButton label="AI chat" disabledReason="Not available for S3" onClick={onClick}>x</IconButton>);
        const button = screen.getByRole('button', { name: 'AI chat' });

        expect(button).toBeEnabled();
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).toHaveAttribute('title', 'Not available for S3');
        expect(button).toHaveAccessibleDescription('Not available for S3');
        await userEvent.tab();
        expect(button).toHaveFocus();
        await userEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });
});
