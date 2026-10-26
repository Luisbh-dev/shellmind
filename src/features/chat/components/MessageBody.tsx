import { memo, useMemo } from 'react';
import { parseSegments, type RunTarget } from '../lib/fences';
import { splitMarkdownBlocks, topHeadingDepth } from '../lib/markdownBlocks';
import { CodeBlock } from './CodeBlock';
import { LazyMarkdown as Markdown } from './LazyMarkdown';

type MessageBodyProps = {
    content: string;
    // streaming: still arriving; complete: finished (a block left open at
    // its end is closed); partial: stopped or cut off (it stays open).
    state: 'streaming' | 'complete' | 'partial';
    target: RunTarget;
    onRun?: (command: string) => void;
    serverName?: string;
};

// The Markdown text of an answer, for its heading levels. While it streams,
// the line still arriving is left out: "##" may be the start of "### Step 2",
// and counting it as a shallower heading would change the levels of every
// block, re-rendering (and re-parsing) the whole answer for one frame.
function headingText(segments: ReturnType<typeof parseSegments>, streaming: boolean): string {
    const texts = segments.map((segment) => (segment.type === 'text' ? segment.text : ''));
    const last = segments.length - 1;
    if (streaming && segments[last]?.type === 'text') texts[last] = texts[last].slice(0, texts[last].lastIndexOf('\n') + 1);
    return texts.join('\n');
}

// An answer split into Markdown and code blocks. Segments and Markdown blocks
// are memoized by their text: while an answer streams, its text is rendered
// block by block (markdownBlocks.ts), so each frame parses only the block
// still growing instead of the whole answer.
export const MessageBody = memo(function MessageBody({ content, state, target, onRun, serverName }: MessageBodyProps) {
    const streaming = state === 'streaming';
    const segments = useMemo(() => parseSegments(content, { complete: state === 'complete' }), [content, state]);
    const topHeading = useMemo(() => topHeadingDepth(headingText(segments, streaming)), [segments, streaming]);
    return (
        <>
            {segments.map((segment, index) => {
                if (segment.type === 'code') {
                    return <CodeBlock key={index} lang={segment.lang} code={segment.code} closed={segment.closed} streaming={streaming} target={target} onRun={onRun} serverName={serverName} />;
                }
                if (!streaming) return <Markdown key={index} text={segment.text} topHeading={topHeading} />;
                return (
                    // Each block trims its own outer margins: the gap of a
                    // paragraph break comes from here.
                    <div key={index} className="space-y-1.5">
                        {splitMarkdownBlocks(segment.text).map((block, blockIndex) => <Markdown key={blockIndex} text={block} topHeading={topHeading} />)}
                    </div>
                );
            })}
        </>
    );
});
