#!/usr/bin/env bash
# Create a date range calculator with 2 bugs.
set -e
PROJECT="${1:-/Users/zliu/IdeaProjects/harness_test}"
mkdir -p "$PROJECT/src/lib" "$PROJECT/src/lib/__tests__"

cat > "$PROJECT/src/lib/dateRange.js" <<'EOF'
// Compute the inclusive number of days between two YYYY-MM-DD dates.
// Returns a positive integer. If end is before start, throws RangeError.
export function daysBetween(startStr, endStr) {
  if (typeof startStr !== 'string' || typeof endStr !== 'string') {
    throw new TypeError('daysBetween expects two YYYY-MM-DD strings');
  }
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new TypeError('invalid date format');
  }
  if (end < start) throw new RangeError('end before start');
  // BUG: missing +1 to be inclusive of both endpoints
  return Math.floor((end - start) / (1000 * 60 * 60 * 24));
}

// Return array of YYYY-MM-DD strings from start to end (inclusive).
export function dateRange(startStr, endStr) {
  const days = daysBetween(startStr, endStr);
  const result = [];
  const current = new Date(startStr);
  // BUG: loop condition uses < instead of <=, excluding final day
  for (let i = 0; i < days; i++) {
    result.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return result;
}
EOF

cat > "$PROJECT/src/lib/__tests__/dateRange.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, dateRange } from '../dateRange.js';

test('daysBetween: same day returns 1', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-01'), 1);
});

test('daysBetween: one day apart returns 2', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-02'), 2);
});

test('daysBetween: one week', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-07'), 7);
});

test('daysBetween: end before start throws RangeError', () => {
  assert.throws(() => daysBetween('2026-01-05', '2026-01-01'), RangeError);
});

test('daysBetween: non-string throws TypeError', () => {
  assert.throws(() => daysBetween(20260101, '2026-01-02'), TypeError);
});

test('dateRange: single day returns array with one date', () => {
  assert.deepEqual(dateRange('2026-01-01', '2026-01-01'), ['2026-01-01']);
});

test('dateRange: three days', () => {
  assert.deepEqual(
    dateRange('2026-01-01', '2026-01-03'),
    ['2026-01-01', '2026-01-02', '2026-01-03']
  );
});

test('dateRange: includes both endpoints', () => {
  const r = dateRange('2026-03-30', '2026-04-02');
  assert.equal(r.length, 4);
  assert.equal(r[0], '2026-03-30');
  assert.equal(r[r.length - 1], '2026-04-02');
});
EOF

echo "Setup complete: created src/lib/dateRange.js (with 2 bugs) and tests that currently fail."
