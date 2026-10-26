// Trimming that stays linear on any input. A regular expression such as
// /\n+$/ tries again from each position of a long run that does not reach the
// end, which takes time that grows with the square of the run's length (a
// command that prints 100 000 blank lines and then one character).

// The text without its trailing line breaks ("\n").
export function trimTrailingNewlines(text: string): string {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
    return end === text.length ? text : text.slice(0, end);
}
