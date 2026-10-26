// Helpers for rendering the Markdown text of an answer (the parts between its
// code blocks, see fences.ts).

// Splits Markdown into top-level blocks at blank lines that are followed by a
// line starting in the first column. Indented lines after a blank line (the
// next paragraph of a list item, indented code) stay with the block before.
// A streaming answer renders each block on its own: the blocks it already
// finished keep their text, so only the growing last one is parsed again.
// Finished answers are rendered whole (references, loose lists).
export function splitMarkdownBlocks(text: string): string[] {
    const lines = text.split('\n');
    const blocks: string[] = [];
    let current: string[] = [];
    let blank = false;
    for (const line of lines) {
        if (!line.trim()) {
            if (current.length) {
                blank = true;
                current.push(line);
            }
            continue;
        }
        if (blank && !/^\s/.test(line)) {
            blocks.push(current.join('\n').trimEnd());
            current = [];
        }
        blank = false;
        current.push(line);
    }
    if (current.length) blocks.push(current.join('\n'));
    return blocks;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
// Lines a setext underline cannot turn into a heading (it is a rule or a
// list there).
const NOT_A_PARAGRAPH = /^ {0,3}([-*+>|#]|\d+[.)])/;

// The level of the topmost heading of a Markdown text (1-6), or 0 without
// headings.
export function topHeadingDepth(text: string): number {
    let top = 0;
    const consider = (depth: number) => {
        if (!top || depth < top) top = depth;
    };
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const atx = ATX_HEADING.exec(lines[i]);
        if (atx) {
            consider(atx[1].length);
            continue;
        }
        const underline = SETEXT_UNDERLINE.exec(lines[i]);
        const previous = lines[i - 1];
        if (underline && previous?.trim() && !NOT_A_PARAGRAPH.test(previous)) consider(underline[1][0] === '=' ? 1 : 2);
    }
    return top;
}
