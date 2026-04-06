# Task: Add Pagination to User List

The file `src/api/users.js` currently has a `listUsers()` function that returns all users. Add pagination support.

## Requirements

Replace `listUsers()` (or add a new function) with a paginated version:

```
listUsers({ page = 1, pageSize = 20 } = {})
```

**Return format**:
```js
{
  items: [...],       // users on the current page
  total: 127,         // total number of users
  page: 1,            // current page (1-indexed)
  pageSize: 20,       // page size (after validation)
  totalPages: 7,      // Math.ceil(total / pageSize)
  hasNext: true,      // true if more pages exist
  hasPrev: false      // true if page > 1
}
```

## Validation Rules

- `page` must be integer ≥ 1. If invalid (not a number, < 1, NaN, float), throw `RangeError`.
- `pageSize` must be integer in [1, 100]. If invalid, throw `RangeError`.
- If `page` exceeds available pages, return empty `items` array but still return correct `total`, `page`, `pageSize`, `totalPages`, `hasNext: false`, `hasPrev: true`.

## Test File

Also create `src/api/users.test.js` using `node:test` and `node:assert/strict` covering:
- Default params return page 1 with 20 items
- Page 2 returns items 21-40
- Last page (page 7) returns items 121-127
- Page 8 returns empty items but correct metadata
- Custom pageSize (e.g., 50)
- Invalid page (0, -1, 'abc', 1.5, NaN) throws RangeError
- Invalid pageSize (0, 101, 'abc', 1.5) throws RangeError

## Constraints

- Keep ES module syntax
- No external deps
- Preserve the existing USERS array
- Tests must pass via: `cd src && node --test api/users.test.js`
