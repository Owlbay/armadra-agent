# string-kit

Implement every function in `src/index.js`. All functions are pure and take/return strings unless stated.

1. `slugify(text)` — lowercase; every run of characters that are not `a-z` or `0-9` becomes a single `-`; no leading or trailing `-`. `slugify("  Hello, World! 2026 ")` → `"hello-world-2026"`.
2. `camelCase(text)` — split on spaces, `-` and `_` (ignore empty parts); first word lowercase, later words capitalized (rest lowercase). `camelCase("user_ID-value")` → `"userIdValue"`.
3. `truncate(text, max)` — if `text.length <= max` return it unchanged; otherwise return the first `max - 1` characters followed by `…` (U+2026), so the result has length `max`.
4. `wordCount(text)` — number of whitespace-separated words; `0` for an empty or blank string.
5. `padCenter(text, width, fill = " ")` — pad both sides to `width`; when the padding is odd, the extra character goes on the right. Text longer than `width` is returned unchanged.
6. `reverseWords(text)` — reverse the order of space-separated words, collapsing runs of spaces to one and trimming. `reverseWords("  a  b c ")` → `"c b a"`.

Also add a `README.md` section `## API` that lists all six function names, one per line, each as inline code (for example `` `slugify` ``).
