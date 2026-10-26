import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks, topHeadingDepth } from './markdownBlocks';

describe('splitMarkdownBlocks', () => {
    it('splits at blank lines followed by a line in the first column', () => {
        expect(splitMarkdownBlocks('# Title\n\nOne.\nStill one.\n\n\n- a\n- b')).toEqual(['# Title', 'One.\nStill one.', '- a\n- b']);
    });

    it('keeps indented continuations (list paragraphs, indented code) with their block', () => {
        expect(splitMarkdownBlocks('1. Install it\n\n   Then restart.\n\n2. Check it\n\n        code')).toEqual([
            '1. Install it\n\n   Then restart.',
            '2. Check it\n\n        code'
        ]);
    });

    it('never changes a block once the next one started, whatever arrives later', () => {
        const text = 'Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nOutro';
        const blocks = splitMarkdownBlocks(text);
        for (let end = text.indexOf('Outro') + 1; end <= text.length; end++) {
            expect(splitMarkdownBlocks(text.slice(0, end)).slice(0, -1)).toEqual(blocks.slice(0, -1));
        }
    });

    it('ignores leading and trailing blank lines', () => {
        expect(splitMarkdownBlocks('\n\nText\n\n')).toEqual(['Text\n\n']);
        expect(splitMarkdownBlocks('   \n')).toEqual([]);
    });
});

describe('topHeadingDepth', () => {
    it('finds the topmost ATX or setext heading', () => {
        expect(topHeadingDepth('### a\n\n## b\n\n#### c')).toBe(2);
        expect(topHeadingDepth('Title\n---\n\n### a')).toBe(2);
        expect(topHeadingDepth('Title\n===')).toBe(1);
        expect(topHeadingDepth('no heading\n\n- item\n---')).toBe(0);
        expect(topHeadingDepth('#hashtag is not a heading')).toBe(0);
    });
});
