#!/usr/bin/env bash
set -e
PROJECT="${1:-/Users/zliu/IdeaProjects/harness_test}"
cd "$PROJECT/src"

[ -f lib/dateRange.js ] || { echo "FAIL: lib/dateRange.js missing (agent deleted it?)"; exit 1; }
[ -f lib/__tests__/dateRange.test.js ] || { echo "FAIL: test file missing (agent deleted it?)"; exit 1; }

# Run the existing (unmodified) tests
node --test lib/__tests__/dateRange.test.js 2>&1 | tee /tmp/bugfix-test-output.txt
TEST_EXIT=${PIPESTATUS[0]}
[ "$TEST_EXIT" = "0" ] || { echo "FAIL: tests still failing after fix"; exit 1; }

# Extra smoke: verify functions exist and behave
node -e "
import('./lib/dateRange.js').then(m => {
  const assert = require('node:assert/strict');
  assert.equal(m.daysBetween('2026-01-01', '2026-01-01'), 1);
  assert.equal(m.daysBetween('2026-01-01', '2026-01-10'), 10);
  const r = m.dateRange('2026-01-01', '2026-01-05');
  assert.equal(r.length, 5, 'should include both endpoints');
  assert.equal(r[0], '2026-01-01');
  assert.equal(r[4], '2026-01-05');
  console.log('SMOKE_TEST_PASSED');
}).catch(err => { console.error('SMOKE_TEST_FAILED:', err.message); process.exit(1); });
" || { echo "FAIL: smoke test failed"; exit 1; }

echo "PASS"
exit 0
