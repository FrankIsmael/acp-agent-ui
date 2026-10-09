import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'demo-policy-'));
process.env.DEMO = 'true';
process.env.DEMO_DB = join(directory, 'demo.db');
process.env.DEMO_TOKEN_LIMIT = '100';
process.env.DEMO_GLOBAL_TOKEN_LIMIT = '500';
process.env.DEMO_TURN_LIMIT = '2';
const policy = await import('../app/.server/demo.ts');
after(() => {
  policy.demoDb().close();
  rmSync(directory, { recursive: true, force: true });
});
const guest = () => policy.identifyDemo(new Request('https://demo.example/'));
test('opaque secure cookie identifies only its persisted guest; tampering fails', () => {
  const a = guest(),
    b = guest();
  assert.notEqual(a.id, b.id);
  assert.match(a.cookie, /HttpOnly; SameSite=Lax.*Secure/);
  assert.equal(
    policy.demoUser(
      new Request('https://demo.example/api/demo', {
        headers: { cookie: a.cookie.split(';')[0] },
      }),
    ),
    a.id,
  );
  assert.throws(
    () =>
      policy.demoUser(
        new Request('https://demo.example/api/demo', {
          headers: { cookie: `demo_guest=${'f'.repeat(64)}` },
        }),
      ),
    (error) => error.status === 401,
  );
  assert.throws(
    () => policy.identifyDemo(new Request('https://demo.example/api/demo')),
    (error) => error.status === 401,
  );
});
test('concurrent creation is idempotent and ownership rejects another guest', async () => {
  const a = guest(),
    b = guest();
  let creates = 0;
  const create = async () => {
    creates++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'private-conversation';
  };
  assert.deepEqual(
    await Promise.all([
      policy.demoConversation(a.id, create),
      policy.demoConversation(a.id, create),
    ]),
    ['private-conversation', 'private-conversation'],
  );
  assert.equal(creates, 1);
  assert.equal(
    await policy.demoConversation(a.id, create),
    'private-conversation',
  );
  policy.assertDemoOwner(a.id, 'private-conversation');
  assert.throws(
    () => policy.assertDemoOwner(b.id, 'private-conversation'),
    (error) => error.status === 404,
  );
});
test('failed creation releases reservation for a retry', async () => {
  const a = guest();
  await assert.rejects(
    policy.demoConversation(a.id, async () => {
      throw new Error('offline');
    }),
  );
  assert.equal(
    await policy.demoConversation(a.id, async () => 'retry-conversation'),
    'retry-conversation',
  );
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
  const a = guest(),
    b = guest();
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
test('user cap counts started demos, not cookie-only visits', async () => {
  const started = policy
    .demoDb()
    .prepare(
      'SELECT count(*) AS n FROM demo_guests WHERE conversation IS NOT NULL',
    )
    .get().n;
  process.env.DEMO_USER_LIMIT = String(started + 1);
  for (let i = 0; i < started + 3; i++) guest();
  const a = guest(),
    b = guest();
  assert.equal(
    await policy.demoConversation(a.id, async () => 'cap-a'),
    'cap-a',
  );
  assert.equal(policy.demoStatus(b.id).exhausted, true);
  await assert.rejects(
    async () => policy.demoConversation(b.id, async () => 'cap-b'),
    policy.DemoLimitError,
  );
  delete process.env.DEMO_USER_LIMIT;
});
const invite = (...args) => {
  const out = execFileSync(
    process.execPath,
    ['scripts/demo-invite.mjs', 'create', ...args, '--url', 'https://demo.example/c/nuevo'],
    { env: { ...process.env }, encoding: 'utf8' },
  );
  return new URL(out.trim().split('\n').at(-1));
};
const redeem = (url) => {
  const result = policy.redeemInvite(new Request(url));
  if (!result) return { result };
  const cookie = result.cookie.split(';')[0];
  const id = policy.demoUser(
    new Request('https://demo.example/api/demo', { headers: { cookie } }),
  );
  return { result, id };
};
test('invite link becomes the guest cookie and drops the token from the URL', () => {
  const url = invite('Friend', '--days', '1');
  const { result, id } = redeem(url);
  assert.equal(result.location, '/c/nuevo');
  assert.match(result.cookie, /^demo_guest=[a-f0-9]{64}; .*HttpOnly.*Max-Age=8640\d.*Secure/);
  assert.equal(policy.isFullAccess(id), true);
  assert.equal(policy.demoStatus(id).fullAccess, true);
  assert.equal(policy.redeemInvite(new Request('https://demo.example/?invite=' + 'f'.repeat(64))), null);
  assert.equal(policy.redeemInvite(new Request('https://demo.example/?invite=nope')), null);
});
test('full access skips limits, opens many conversations and stays private', async () => {
  const { id } = redeem(invite('Unlimited'));
  for (let i = 0; i < 5; i++) policy.beginDemoTurn(id, 90);
  assert.equal(policy.chargeDemoOutput(id, 1000), false);
  assert.equal(policy.demoStatus(id).exhausted, false);
  // Their usage does not eat the public budget.
  const fresh = guest();
  policy.beginDemoTurn(fresh.id, 50);
  assert.equal(await policy.demoConversation(id, async () => 'full-1'), 'full-1');
  assert.equal(await policy.demoConversation(id, async () => 'full-2'), 'full-2');
  policy.assertDemoOwner(id, 'full-1');
  policy.assertDemoOwner(id, 'full-2');
  assert.throws(() => policy.assertDemoOwner(fresh.id, 'full-2'), (error) => error.status === 404);
});
test('expired or revoked invites fall back to demo limits', () => {
  const url = invite('Later', '--days', '1');
  const { id } = redeem(url);
  execFileSync(process.execPath, ['scripts/demo-invite.mjs', 'revoke', 'Later'], { env: { ...process.env } });
  assert.equal(policy.isFullAccess(id), false);
  assert.equal(policy.redeemInvite(new Request(url)), null);
  policy.beginDemoTurn(id, 10);
  policy.beginDemoTurn(id, 10);
  assert.throws(() => policy.beginDemoTurn(id, 10), policy.DemoLimitError);
  const expired = redeem(invite('Old'));
  policy.demoDb().prepare('UPDATE demo_guests SET expires_at = 1 WHERE id = ?').run(expired.id);
  assert.equal(policy.isFullAccess(expired.id), false);
});
test('kill switch disables identity and ownership hooks', () => {
  process.env.DEMO = 'false';
  assert.equal(
    policy.demoUser(new Request('https://demo.example/')),
    undefined,
  );
  assert.equal(policy.conversationOwner('private-conversation'), undefined);
  process.env.DEMO = 'true';
});
