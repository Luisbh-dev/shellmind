import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLanguage } from '@/i18n';
import { Field } from './Field';
import { TagInput } from './TagInput';

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('system'));

function Harness({ initial = [] as string[], suggestions = ['web', 'prod', 'worker'] }) {
    const [tags, setTags] = useState(initial);
    return (
        <>
            <Field label="Tags"><TagInput value={tags} onChange={setTags} suggestions={suggestions} /></Field>
            <output data-testid="tags">{tags.join('|')}</output>
        </>
    );
}

const tags = () => screen.getByTestId('tags').textContent;

describe('TagInput suggestions', () => {
    it('offers the existing tags in a themed list, not a native datalist', async () => {
        const user = userEvent.setup();
        const { container } = render(<Harness initial={['web']} />);
        await user.click(screen.getByRole('combobox', { name: 'Tags' }));

        expect(container.querySelector('datalist')).toBeNull();
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['prod', 'worker']);
    });

    it('adds the clicked suggestion and keeps typing in the input', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const input = screen.getByRole('combobox', { name: 'Tags' });
        await user.type(input, 'wo');
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['worker']);

        await user.click(screen.getByRole('option', { name: 'worker' }));

        expect(tags()).toBe('worker');
        expect(input).toHaveValue('');
        expect(input).toHaveFocus();
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('picks with the arrow keys and Enter, and Escape closes the list', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const input = screen.getByRole('combobox', { name: 'Tags' });
        await user.click(input);
        await user.keyboard('{ArrowDown}{ArrowDown}');
        expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'prod' }).id);
        await user.keyboard('{Enter}');
        expect(tags()).toBe('prod');

        await user.click(input);
        expect(screen.getByRole('listbox')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('still adds what was typed with Enter when no suggestion is highlighted', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'staging{Enter}');
        expect(tags()).toBe('staging');
    });
});
