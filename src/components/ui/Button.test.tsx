import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button } from './Button';

describe('Button', () => {
    it('renders its label and handles clicks', async () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick}>Save</Button>);

        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('stays focusable while loading, marked busy, and ignores clicks', async () => {
        const onClick = vi.fn();
        render(<Button loading onClick={onClick}>Save</Button>);
        const button = screen.getByRole('button', { name: 'Save' });

        // A disabled button would drop keyboard focus to <body> mid-save.
        expect(button).toBeEnabled();
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).toHaveAttribute('aria-busy', 'true');
        button.focus();
        expect(button).toHaveFocus();

        await userEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('keeps focus when it starts loading after a keyboard submit', async () => {
        function Form() {
            const [saving, setSaving] = useState(false);
            return (
                <form onSubmit={(event) => { event.preventDefault(); setSaving(true); }}>
                    <Button type="submit" loading={saving}>Save</Button>
                </form>
            );
        }
        render(<Form />);
        const button = screen.getByRole('button', { name: 'Save' });
        button.focus();

        await userEvent.keyboard('{Enter}');

        expect(button).toHaveAttribute('aria-busy', 'true');
        expect(button).toHaveFocus();
    });

    it('drops submits of its form while busy (Enter in a field), and only then', () => {
        const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
        const { rerender } = render(
            <form onSubmit={onSubmit}>
                <input aria-label="Name" />
                <Button type="submit" loading>Save</Button>
            </form>
        );

        fireEvent.submit(screen.getByRole('textbox', { name: 'Name' }).closest('form')!);
        expect(onSubmit).not.toHaveBeenCalled();

        rerender(
            <form onSubmit={onSubmit}>
                <input aria-label="Name" />
                <Button type="submit">Save</Button>
            </form>
        );
        fireEvent.submit(screen.getByRole('textbox', { name: 'Name' }).closest('form')!);
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('is disabled only when asked to be', () => {
        render(<Button disabled loading>Save</Button>);

        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
});
