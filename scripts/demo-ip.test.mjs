import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeDemoIp, normalizeDemoIp } from '../app/.server/demo-ip.ts';
const request = (ip, headers = {}) => new Request('https://demo.example/', { headers: { 'x-demo-client-ip': ip, ...headers } });
const denied = fn => { try { fn(); assert.fail('expected a limit'); } catch (error) { assert.ok(error instanceof Response); assert.equal(error.status, 429); return error; } };
test('IPv4-mapped and IPv6 privacy addresses cannot change their rate-limit identity', () => {
  assert.equal(normalizeDemoIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeDemoIp('::ffff:c000:201'), '192.0.2.1');
  assert.equal(normalizeDemoIp('2001:db8:1:2::abcd'), normalizeDemoIp('2001:0db8:0001:0002:ffff::1'));
  assert.notEqual(normalizeDemoIp('2001:db8:1:3::1'), normalizeDemoIp('2001:db8:1:2::1'));
  for (const value of ['', 'unknown', '1.2.3.4, 5.6.7.8']) assert.throws(() => normalizeDemoIp(value), error => error.status === 503);
});
test('3 guests per fixed 24-hour window, independent IPs, rejected attempts do not extend expiry', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const req = request('192.0.2.1');
    for (let i = 0; i < 3; i++) consumeDemoIp(db, req, 'guests', 1000);
    const response = denied(() => consumeDemoIp(db, req, 'guests', 2000));
    assert.equal(response.headers.get('retry-after'), '86399');
    assert.equal((await response.json()).code, 'DEMO_IP_LIMIT');
    consumeDemoIp(db, request('192.0.2.2'), 'guests', 2000);
    denied(() => consumeDemoIp(db, req, 'guests', 86400999));
    consumeDemoIp(db, req, 'guests', 86401000);
    assert.ok(db.prepare('SELECT ip_key FROM demo_ip_limits').all().every(row => !row.ip_key.includes('192.0.2')));
  } finally { db.close(); }
});
test('separate chat, API, and pairing windows plus a readable document rejection', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const req = request('192.0.2.3');
    for (let i = 0; i < 10; i++) consumeDemoIp(db, req, 'chat', 0);
    denied(() => consumeDemoIp(db, req, 'chat', 59999));
    consumeDemoIp(db, req, 'chat', 60000);
    for (let i = 0; i < 5; i++) consumeDemoIp(db, req, 'whatsapp', 60000);
    assert.equal(denied(() => consumeDemoIp(db, req, 'whatsapp', 60000)).headers.get('retry-after'), '3600');
    for (let i = 0; i < 120; i++) consumeDemoIp(db, req, 'api', 60000);
    denied(() => consumeDemoIp(db, req, 'api', 60000));
    for (let i = 0; i < 3; i++) consumeDemoIp(db, req, 'guests', 60000);
    const html = denied(() => consumeDemoIp(db, request('192.0.2.3', { accept: 'text/html' }), 'guests', 60000));
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /mailto:ismaelfcom93@gmail.com/);
  } finally { db.close(); }
});
test('rate limits and hashing salt survive separate database connections and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-ip-'));
  const path = join(directory, 'ip.db');
  let db = new DatabaseSync(path);
  try {
    const req = request('192.0.2.5');
    for (let i = 0; i < 3; i++) consumeDemoIp(db, req, 'guests', 1000);
    db.close(); db = new DatabaseSync(path);
    denied(() => consumeDemoIp(db, req, 'guests', 2000));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
