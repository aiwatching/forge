# Task: Fix Bugs in dateRange Module

The file `src/lib/dateRange.js` has 2 bugs. The existing test file `src/lib/__tests__/dateRange.test.js` describes the expected behavior.

## Your job

1. Run the existing tests — several will fail. Identify what's wrong.
2. Fix both bugs in `src/lib/dateRange.js`.
3. Do NOT modify the test file. The tests correctly express the expected behavior.
4. Do NOT change the function signatures or add new functions.
5. After fixing, all tests must pass.

## Verify

```bash
cd src && node --test lib/__tests__/dateRange.test.js
```

All tests should pass.

## Hints

- `daysBetween('2026-01-01', '2026-01-01')` should return `1` (inclusive count)
- `dateRange('2026-01-01', '2026-01-03')` should return all 3 days including both endpoints

## Constraints

- Minimal diff — fix only what's broken
- Keep the functions pure
- No new dependencies
