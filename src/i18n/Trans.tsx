import { Fragment, type ReactNode } from 'react';
import { useT } from './index';

// Translates `k` and fills its {placeholders} with React nodes, for messages
// that embed markup (e.g. a highlighted name).
export function Trans({ k, values }: { k: string; values: Record<string, ReactNode> }) {
    const t = useT();
    // split() with a capture group puts placeholder names at the odd indexes.
    const parts = t(k).split(/\{(\w+)\}/);
    return (
        <>
            {parts.map((part, index) => (
                <Fragment key={index}>
                    {index % 2 === 1 ? (part in values ? values[part] : `{${part}}`) : part}
                </Fragment>
            ))}
        </>
    );
}
