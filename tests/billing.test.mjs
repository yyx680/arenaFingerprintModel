import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBalance, formatBalance, createBalanceReader, BALANCE_URL} from '../billing.js';

test('parseBalance accepts the pulse payload and rejects junk', () => {
  assert.deepEqual(
    parseBalance('{"pulse":54.5,"refreshedAt":"2026-10-02T06:00:00.000Z"}', '2026-10-01T17:00:00.000Z'),
    {pulse: 54.5, refreshedAt: '2026-10-02T06:00:00.000Z', receivedAt: '2026-10-01T17:00:00.000Z'});
  assert.equal(parseBalance('{"pulse":-1}'), null);
  assert.equal(parseBalance('{"total":10}'), null);
  assert.equal(parseBalance('not json'), null);
  assert.equal(parseBalance({pulse: 120}).pulse, 120); // 奖励额度允许超过 100
  assert.equal(parseBalance({pulse: 3, refreshedAt: 'x'.repeat(60)}).refreshedAt, null);
});

test('formatBalance keeps the percentage scale and tones', () => {
  assert.equal(formatBalance({pulse: 54.5, refreshedAt: null, receivedAt: null}).value, '54.5%');
  assert.equal(formatBalance({pulse: 54.5}).tone, 'good');
  assert.equal(formatBalance({pulse: 30}).tone, 'warn');
  assert.equal(formatBalance({pulse: 10}).tone, 'low');
  assert.equal(formatBalance(null).value, '未提供');
});

test('createBalanceReader caches for 60 s, honours force, and reports HTTP failures', async () => {
  let calls = 0, now = 0;
  const reader = createBalanceReader({
    now: () => now,
    fetch: async url => { calls++; assert.equal(url, BALANCE_URL); return {ok: true, status: 200, text: async () => '{"pulse":42,"refreshedAt":null}'}; },
  });
  assert.equal((await reader.read()).balance.pulse, 42);
  await reader.read();
  assert.equal(calls, 1);
  now += 61000;
  await reader.read();
  assert.equal(calls, 2);
  await reader.read({force: true});
  assert.equal(calls, 3);
  const denied = createBalanceReader({fetch: async () => ({ok: false, status: 403, text: async () => ''})});
  const result = await denied.read();
  assert.match(result.error, /403/);
  assert.equal(result.balance, null);
});
