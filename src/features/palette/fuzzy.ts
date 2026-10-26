// Fuzzy matching for the command palette: every character of each query word
// must appear in order. Matches at word starts and runs of consecutive
// characters score higher, so "pd" ranks "prod-db" above "upload".

export type FuzzyMatch = { score: number; positions: number[] };

const WORD_SEPARATOR = /[\s\-_./@:()[\]]/;

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function isWordStart(text: string, index: number): boolean {
    if (index === 0) return true;
    const previous = text[index - 1];
    if (WORD_SEPARATOR.test(previous)) return true;
    // camelCase boundary
    return previous === previous.toLowerCase() && text[index] !== text[index].toLowerCase();
}

function matchWord(word: string, original: string, text: string): FuzzyMatch | null {
    // A contiguous match is the best case: score it as one run.
    const at = text.indexOf(word);
    if (at !== -1) {
        const positions = Array.from({ length: word.length }, (_, offset) => at + offset);
        const score = 10 * word.length + (isWordStart(original, at) ? 15 : 0) + (at === 0 ? 10 : 0);
        return { score, positions };
    }

    const positions: number[] = [];
    let score = 0;
    let from = 0;
    for (const char of word) {
        // Prefer the next occurrence that starts a word.
        let index = -1;
        for (let i = text.indexOf(char, from); i !== -1; i = text.indexOf(char, i + 1)) {
            if (index === -1) index = i;
            if (isWordStart(original, i)) {
                index = i;
                break;
            }
        }
        if (index === -1) return null;
        const previous = positions[positions.length - 1];
        score += 1;
        if (previous !== undefined && index === previous + 1) score += 5;
        if (isWordStart(original, index)) score += 8;
        if (previous !== undefined) score -= Math.min(3, index - previous - 1);
        positions.push(index);
        from = index + 1;
    }
    // Characters scattered mid-word ("db" in "Edit web") are noise, not a match.
    return score > 0 ? { score, positions } : null;
}

// null when the query does not match. An empty query matches everything with score 0.
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return { score: 0, positions: [] };
    // fold() keeps one character per character for the scripts used here, so
    // positions in the folded text are positions in `text`.
    const folded = fold(text);
    const original = folded.length === text.length ? text : folded;
    let score = 0;
    const positions = new Set<number>();
    for (const word of words) {
        const match = matchWord(word, original, folded);
        if (!match) return null;
        score += match.score;
        match.positions.forEach((position) => positions.add(position));
    }
    // Shorter texts are a closer match for the same characters.
    score -= Math.floor(text.length / 20);
    return { score, positions: [...positions].sort((a, b) => a - b) };
}
