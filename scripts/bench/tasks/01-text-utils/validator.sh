#!/usr/bin/env bash
# Validator for text utility task.
# Runs in harness_test project root. Exits 0 = pass, non-zero = fail.
set -e

PROJECT_ROOT="${1:-/Users/zliu/IdeaProjects/harness_test}"
cd "$PROJECT_ROOT/src" || { echo "FAIL: src/ directory not found"; exit 1; }

# 1. Check files exist
[ -f utils/text.js ] || { echo "FAIL: utils/text.js missing"; exit 1; }
[ -f utils/text.test.js ] || { echo "FAIL: utils/text.test.js missing"; exit 1; }

# 2. Check exports
grep -q "export.*capitalize" utils/text.js || { echo "FAIL: capitalize not exported"; exit 1; }
grep -q "export.*reverseWords" utils/text.js || { echo "FAIL: reverseWords not exported"; exit 1; }

# 3. Run tests
node --test utils/text.test.js 2>&1 | tee /tmp/text-test-output.txt
TEST_EXIT=${PIPESTATUS[0]}
if [ "$TEST_EXIT" != "0" ]; then
  echo "FAIL: tests failed (exit=$TEST_EXIT)"
  exit 1
fi

# 4. Additional smoke test — behavior verification independent of agent's tests
node -e "
import('./utils/text.js').then(m => {
  const assert = require('node:assert/strict');
  // capitalize
  assert.equal(m.capitalize('hello'), 'Hello', 'capitalize basic');
  assert.equal(m.capitalize('a'), 'A', 'capitalize single char');
  try { m.capitalize(''); assert.fail('expected throw on empty'); } catch (e) { assert.ok(e instanceof TypeError); }
  try { m.capitalize(null); assert.fail('expected throw on null'); } catch (e) { assert.ok(e instanceof TypeError); }
  try { m.capitalize(123); assert.fail('expected throw on number'); } catch (e) { assert.ok(e instanceof TypeError); }
  // reverseWords
  assert.equal(m.reverseWords('hello world'), 'world hello');
  assert.equal(m.reverseWords('  a  b  c  '), 'c b a');
  assert.equal(m.reverseWords(''), '');
  assert.equal(m.reverseWords('single'), 'single');
  try { m.reverseWords(null); assert.fail('expected throw'); } catch (e) { assert.ok(e instanceof TypeError); }
  console.log('SMOKE_TEST_PASSED');
}).catch(err => { console.error('SMOKE_TEST_FAILED:', err.message); process.exit(1); });
" || { echo "FAIL: smoke test failed"; exit 1; }

echo "PASS"
exit 0
