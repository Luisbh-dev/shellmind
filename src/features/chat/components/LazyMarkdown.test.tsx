import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('LazyMarkdown', () => {
    it('shows the text as it is until the renderer has loaded, then renders it', async () => {
        // A fresh copy: the test setup preloads the renderer into the shared one.
        vi.resetModules();
        const { LazyMarkdown } = await import('./LazyMarkdown');
        render(<LazyMarkdown text={'## Disks\n\nRun `df -h`'} />);

        expect(screen.getByText(/## Disks/)).toBeInTheDocument();
        expect(screen.queryByRole('heading')).toBeNull();

        expect(await screen.findByRole('heading', { name: 'Disks' })).toBeInTheDocument();
        expect(screen.getByText('df -h').tagName).toBe('CODE');
    });
});
