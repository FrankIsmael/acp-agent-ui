import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoxConfigs } from '../app/.server/box-config.ts';

test('without ACP_BOXES, one box from the single-box variables', () => {
  assert.deepEqual(
    readBoxConfigs({ ACP_WS_URL: 'wss://a/acp', ACP_SECRET: 's', AGENT_BOX_ID: 'sb_1', ACP_MAX_SESSIONS: '6' }),
    [{ name: 'main', url: 'wss://a/acp', token: 's', boxId: 'sb_1', snapshotId: '', maxSessions: 6 }],
  );
  assert.equal(readBoxConfigs({}).at(0).maxSessions, 4);
});

test('ACP_BOXES reads each box from its own prefix, without falling back', () => {
  const boxes = readBoxConfigs({
    ACP_BOXES: 'chat, Easy',
    ACP_WS_URL: 'wss://legacy/acp',
    ACP_CHAT_WS_URL: 'wss://chat/acp',
    ACP_CHAT_TOKEN: 't',
    ACP_CHAT_BOX_ID: 'm_1',
    ACP_EASY_WS_URL: 'wss://easy/acp',
    ACP_EASY_MAX_SESSIONS: '2',
  });
  assert.deepEqual(boxes.map((b) => [b.name, b.url, b.token, b.boxId, b.maxSessions]), [
    ['chat', 'wss://chat/acp', 't', 'm_1', 4],
    ['easy', 'wss://easy/acp', '', '', 2],
  ]);
});

test('box names must be distinct letters and digits', () => {
  assert.throws(() => readBoxConfigs({ ACP_BOXES: 'a-b' }), /not a valid box name/);
  assert.throws(() => readBoxConfigs({ ACP_BOXES: 'a,A' }), /repeated/);
});
