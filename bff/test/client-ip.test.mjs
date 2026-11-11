import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parseTrustedProxies, resolveClientIp } from '../dist/client-ip.js';

test('unsafe proxy configuration fails startup before listening', () => {
  for (const raw of ['0.0.0.0/0', '::/0', 'not-an-address']) {
    const child = spawnSync(process.execPath, ['dist/server.js'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, BFF_TRUSTED_PROXIES: raw, BFF_PORT: '0' },
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /invalid_configuration:BFF_TRUSTED_PROXIES/);
    assert.ok(!child.stdout.includes('listening'));
  }
});

test('trusted proxies default empty and reject invalid or unrestricted networks', () => {
  assert.deepEqual(parseTrustedProxies(), []);
  assert.deepEqual(parseTrustedProxies(' 127.0.0.1, ,127.0.0.1 '), ['127.0.0.1']);
  for (const raw of ['*', '0.0.0.0/0', '::/0', '10.0.0.1/33', 'invalid', '1.2.3.4/']) {
    assert.throws(() => parseTrustedProxies(raw), /BFF_TRUSTED_PROXIES/);
  }
});

test('direct clients cannot spoof forwarded IPs and preserve the socket rate-limit key', () => {
  assert.deepEqual(resolveClientIp('::ffff:127.0.0.1', '203.0.113.99', []), {
    clientIp: '::ffff:127.0.0.1', forwardingStatus: 'peer',
  });
});

test('trusted proxy chain is walked right to left, including IPv6 and mapped peers', () => {
  const proxies = parseTrustedProxies('127.0.0.1,10.0.0.0/8,2001:db8:1::/48');
  assert.equal(resolveClientIp('::ffff:127.0.0.1', '192.0.2.9,203.0.113.8,10.0.0.2', proxies).clientIp, '203.0.113.8');
  assert.equal(resolveClientIp('2001:db8:1::1', '2001:db8:2::2,2001:db8:1::3', proxies).clientIp, '2001:db8:2::2');
});

test('malformed chains fail back to peer; all-trusted chains select the leftmost hop', () => {
  const proxies = parseTrustedProxies('10.0.0.0/8');
  for (const header of ['invalid,10.0.0.2', '203.0.113.4,,10.0.0.2', ['10.0.0.2']]) {
    assert.deepEqual(resolveClientIp('10.0.0.1', header, proxies), {
      clientIp: '10.0.0.1', forwardingStatus: 'invalid',
    });
  }
  assert.deepEqual(resolveClientIp('10.0.0.1', '10.0.0.3,10.0.0.2', proxies), {
    clientIp: '10.0.0.3', forwardingStatus: 'all_trusted',
  });
});
