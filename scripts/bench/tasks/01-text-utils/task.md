# Task: Text Utility Module

Add a text utility module to the project.

## Requirements

1. Create a new file `src/utils/text.js` in the harness_test project.
2. Export two functions:
   - `capitalize(word)`: Returns the word with its first character uppercased. If input is not a string or is empty, throw a `TypeError`.
   - `reverseWords(sentence)`: Returns the sentence with the order of words reversed. Words are separated by one or more whitespace characters. Leading/trailing whitespace should be trimmed. If input is not a string, throw a `TypeError`. An empty string returns an empty string.

3. Create a test file `src/utils/text.test.js` using Node.js built-in `node:test` and `node:assert/strict`. Tests should cover:
   - `capitalize`: normal words, single characters, unicode words
   - `capitalize`: throws on empty string, null, undefined, numbers
   - `reverseWords`: basic sentences, multiple spaces, leading/trailing spaces
   - `reverseWords`: empty string, single word
   - `reverseWords`: throws on non-string inputs

4. The tests must pass when running: `cd src && node --test utils/text.test.js`

## Constraints

- Use ES module syntax (`export`, `import`). The project's package.json already has `"type": "module"`.
- No external dependencies — use only Node built-ins.
- Keep functions pure (no side effects).
- Use `strict` mode assertions (`node:assert/strict`).
