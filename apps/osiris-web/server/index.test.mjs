import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './index.mjs';

test('parseArgs defaults', () => {
  const o = parseArgs([]);
  assert.equal(o.port, 3000);
  assert.equal(o.host, '0.0.0.0');
  assert.equal(o.help, false);
});

test('parseArgs reads flags in both forms', () => {
  assert.equal(parseArgs(['--port', '8080']).port, 8080);
  assert.equal(parseArgs(['--port=8081']).port, 8081);
  assert.equal(parseArgs(['--host=127.0.0.1']).host, '127.0.0.1');
  assert.equal(parseArgs(['--token', 'abc']).token, 'abc');
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs collects unknown args into rest', () => {
  assert.deepEqual(parseArgs(['--server-base-path', '/ide']).rest, ['--server-base-path', '/ide']);
});
