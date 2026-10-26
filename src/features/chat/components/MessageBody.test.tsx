import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBody } from './MessageBody';

// The Markdown renderer, counted: what matters is how much text each render
// hands to it. It is memoized by its props, so each render is one parse. (The
// component tests preload the real renderer, so react-markdown itself cannot
// be swapped here.)
const parsed = vi.hoisted(() => [] as string[]);
vi.mock('./LazyMarkdown', async () => {
    const { memo } = await import('react');
    const { Markdown } = await import('./Markdown');
    return {
        LazyMarkdown: memo(function CountedMarkdown(props: { text: string; topHeading?: number }) {
            parsed.push(props.text);
            return <Markdown {...props} />;
        })
    };
});

const TARGET = { scopedBin: null, ftp: false };

describe('MessageBody while streaming', () => {
    it('parses only the block still growing, not the whole answer, on each update', () => {
        const head = '## Disk usage\n\nThe root filesystem is almost full.\n\n- /var/log: 12 GB\n- /home: 3 GB';
        const view = render(<MessageBody content={head} state="streaming" target={TARGET} />);
        expect(parsed).toEqual(['## Disk usage', 'The root filesystem is almost full.', '- /var/log: 12 GB\n- /home: 3 GB']);

        parsed.length = 0;
        view.rerender(<MessageBody content={`${head}\n- /tmp: 1 GB\n\n| mount | use |`} state="streaming" target={TARGET} />);
        expect(parsed).toEqual(['- /var/log: 12 GB\n- /home: 3 GB\n- /tmp: 1 GB', '| mount | use |']);

        parsed.length = 0;
        view.rerender(<MessageBody content={`${head}\n- /tmp: 1 GB\n\n| mount | use |\n|---|---|`} state="streaming" target={TARGET} />);
        expect(parsed).toEqual(['| mount | use |\n|---|---|']);
    });

    it('does not re-parse the finished blocks while a heading line is still arriving', () => {
        const head = '### Step 1\n\nThe unit failed.\n\n';
        const view = render(<MessageBody content={`${head}##`} state="streaming" target={TARGET} />);
        // "##" is the start of "### Step 2", not a shallower heading: the
        // levels (and so the blocks already rendered) stay as they are.
        parsed.length = 0;
        view.rerender(<MessageBody content={`${head}### Step 2`} state="streaming" target={TARGET} />);
        expect(parsed).toEqual(['### Step 2']);
        expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual(['H3', 'H3']);
    });

    it('renders a finished answer in one piece', () => {
        parsed.length = 0;
        render(<MessageBody content={'1. one\n\n2. two\n\nSee [the docs][d].\n\n[d]: https://docs.example.com'} state="complete" target={TARGET} />);
        expect(parsed).toHaveLength(1);
        expect(screen.getByRole('link', { name: 'the docs' })).toHaveAttribute('href', 'https://docs.example.com');
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });
});

describe('Markdown headings', () => {
    const levels = () => screen.getAllByRole('heading').map((heading) => `${heading.tagName}:${heading.textContent}`);

    it('start one level below the chat title (h2) and keep the outline of the answer', () => {
        render(<MessageBody content={'## Diagnosis\n\nNginx is down.\n\n### Cause\n\nPort 80 is taken.\n\n#### Detail\n\n## Fix'} state="complete" target={TARGET} />);
        expect(levels()).toEqual(['H3:Diagnosis', 'H4:Cause', 'H5:Detail', 'H3:Fix']);
    });

    it('make the topmost heading an h3 whatever its Markdown depth, also while streaming', () => {
        render(<MessageBody content={'### Steps\n\nFirst this.\n\n#### Then\n\nThat.'} state="streaming" target={TARGET} />);
        expect(levels()).toEqual(['H3:Steps', 'H4:Then']);
    });

    it('count setext headings and cap the depth at h6', () => {
        render(<MessageBody content={'Title\n=====\n\n###### Deep'} state="complete" target={TARGET} />);
        expect(levels()).toEqual(['H3:Title', 'H6:Deep']);
    });
});

describe('Run button of a shell block', () => {
    it('uses the primary button colours, whose contrast the palette pins in every theme', () => {
        render(<MessageBody content={'```bash\ndf -h\n```'} state="complete" target={TARGET} onRun={() => undefined} serverName="web-1" />);
        const run = screen.getByRole('button', { name: 'Run' });
        expect(run).toHaveClass('bg-brand-500', 'text-on-brand');
        expect(run.className).not.toMatch(/text-brand-\d|bg-brand-500\//);
    });
});
