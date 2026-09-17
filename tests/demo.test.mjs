import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'demo-policy-'));
process.env.PUBLIC_DEMO = 'true';
process.env.DEMO_DB = join(directory, 'demo.db');
process.env.DEMO_TOKEN_LIMIT = '100';
process.env.DEMO_GLOBAL_TOKEN_LIMIT = '500';
process.env.DEMO_TURN_LIMIT = '2';
const policy = await import('../app/.server/demo.ts');
after(() => { policy.demoDb().close(); rmSync(directory, { recursive: true, force: true }); });
const guest = () => policy.identifyDemo(new Request('https://demo.example/'));
test('opaque secure cookie identifies only its persisted guest; tampering fails', () => {
  const a = guest(), b = guest();
  assert.notEqual(a.id, b.id);
  assert.match(a.cookie, /HttpOnly; SameSite=Lax.*Secure/);
  assert.equal(policy.demoUser(new Request('https://demo.example/api/demo', { headers: { cookie: a.cookie.split(';')[0] } })), a.id);
  assert.throws(() => policy.demoUser(new Request('https://demo.example/api/demo', { headers: { cookie: `demo_guest=${'f'.repeat(64)}` } })), error => error.status === 401);
  assert.throws(() => policy.identifyDemo(new Request('https://demo.example/api/demo')), error => error.status === 401);
});
test('concurrent creation is idempotent and ownership rejects another guest', async () => {
  const a = guest(), b = guest(); let creates = 0;
  const create = async () => { creates++; await new Promise(resolve => setTimeout(resolve, 10)); return 'private-conversation'; };
  assert.deepEqual(await Promise.all([policy.demoConversation(a.id, create), policy.demoConversation(a.id, create)]), ['private-conversation', 'private-conversation']);
  assert.equal(creates, 1);
  assert.equal(await policy.demoConversation(a.id, create), 'private-conversation');
  policy.assertDemoOwner(a.id, 'private-conversation');
  assert.throws(() => policy.assertDemoOwner(b.id, 'private-conversation'), error => error.status === 404);
});
test('failed creation releases reservation for a retry', async () => {
  const a = guest();
  await assert.rejects(policy.demoConversation(a.id, async () => { throw new Error('offline'); }));
  assert.equal(await policy.demoConversation(a.id, async () => 'retry-conversation'), 'retry-conversation');
});
test('turn and token reservations never refund on failure and block over budget', () => {
  const a = guest();
  policy.beginDemoTurn(a.id, 40);
  assert.equal(policy.chargeDemoOutput(a.id, 10), false);
  assert.throws(() => policy.beginDemoTurn(a.id, 51), policy.DemoLimitError);
  assert.equal(policy.demoStatus(a.id).turns, 1);
  policy.beginDemoTurn(a.id, 40);
  assert.equal(policy.demoStatus(a.id).exhausted, true);
  assert.throws(() => policy.beginDemoTurn(a.id, 1), policy.DemoLimitError);
  assert.equal(policy.chargeDemoOutput(a.id, 10), true);
});
test('WhatsApp number ownership survives logout and cannot reset with a new guest', () => {
  const a = guest(), b = guest();
  assert.equal(policy.claimDemoNumber(a.id, '5215512345678'), true);
  assert.equal(policy.claimDemoNumber(a.id, '5215512345678'), true);
  assert.equal(policy.claimDemoNumber(b.id, '5215512345678'), false);
});
test('global usage ceiling blocks fresh guests', () => {
  const a = guest();
  process.env.DEMO_GLOBAL_TOKEN_LIMIT = '101';
  assert.throws(() => policy.beginDemoTurn(a.id, 2), policy.DemoLimitError);
  process.env.DEMO_GLOBAL_TOKEN_LIMIT = '500';
});
test('kill switch disables identity and ownership hooks', () => {
  process.env.PUBLIC_DEMO = 'false';
  assert.equal(policy.demoUser(new Request('https://demo.example/')), undefined);
  assert.equal(policy.conversationOwner('private-conversation'), undefined);
  process.env.PUBLIC_DEMO = 'true';
});
