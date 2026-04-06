#!/usr/bin/env bash
set -e
PROJECT="${1:-/Users/zliu/IdeaProjects/harness_test}"
cd "$PROJECT/src"

[ -f api/users.js ] || { echo "FAIL: api/users.js missing"; exit 1; }
[ -f api/users.test.js ] || { echo "FAIL: api/users.test.js missing"; exit 1; }
grep -q "export function listUsers\|export const listUsers\|export { listUsers" api/users.js || { echo "FAIL: listUsers not exported"; exit 1; }

# Run agent's tests
node --test api/users.test.js 2>&1 | tee /tmp/paginate-test-output.txt
TEST_EXIT=${PIPESTATUS[0]}
[ "$TEST_EXIT" = "0" ] || { echo "FAIL: agent tests failed"; exit 1; }

# Independent smoke test
node -e "
import('./api/users.js').then(m => {
  const assert = require('node:assert/strict');
  // Default: page 1, 20 items
  let r = m.listUsers();
  assert.equal(r.items.length, 20, 'default pageSize 20');
  assert.equal(r.items[0].id, 1);
  assert.equal(r.total, 127);
  assert.equal(r.page, 1);
  assert.equal(r.pageSize, 20);
  assert.equal(r.totalPages, 7);
  assert.equal(r.hasNext, true);
  assert.equal(r.hasPrev, false);

  // Page 2
  r = m.listUsers({ page: 2 });
  assert.equal(r.items[0].id, 21);
  assert.equal(r.items.length, 20);
  assert.equal(r.hasPrev, true);

  // Last page (127 / 20 = 6.35 → 7 pages; page 7 has 7 items)
  r = m.listUsers({ page: 7 });
  assert.equal(r.items.length, 7, 'last page has 7 items');
  assert.equal(r.items[0].id, 121);
  assert.equal(r.hasNext, false);

  // Page 8 (beyond) — empty but correct metadata
  r = m.listUsers({ page: 8 });
  assert.equal(r.items.length, 0, 'page beyond: empty items');
  assert.equal(r.total, 127);
  assert.equal(r.totalPages, 7);
  assert.equal(r.hasNext, false);

  // Custom pageSize
  r = m.listUsers({ page: 1, pageSize: 50 });
  assert.equal(r.items.length, 50);
  assert.equal(r.totalPages, 3);

  // Invalid page
  for (const p of [0, -1, 'abc', 1.5, NaN]) {
    try { m.listUsers({ page: p }); assert.fail('expected RangeError for page=' + p); }
    catch (e) { assert.ok(e instanceof RangeError, 'page=' + p + ' should throw RangeError, got: ' + e.constructor.name); }
  }
  // Invalid pageSize
  for (const ps of [0, 101, 'abc', 1.5]) {
    try { m.listUsers({ page: 1, pageSize: ps }); assert.fail('expected RangeError for pageSize=' + ps); }
    catch (e) { assert.ok(e instanceof RangeError, 'pageSize=' + ps + ' should throw RangeError'); }
  }
  console.log('SMOKE_TEST_PASSED');
}).catch(err => { console.error('SMOKE_TEST_FAILED:', err.message); process.exit(1); });
" || { echo "FAIL: smoke test failed"; exit 1; }

echo "PASS"
exit 0
