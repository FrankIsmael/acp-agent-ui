import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { jobFromReply, replyProse } from '../../app/lathe/agent-reply.ts';

const dumbbell = readFileSync(new URL('../../app/lathe/examples/dumbbell.json', import.meta.url), 'utf8');
const reply = (block) => `Here is the job.\n\n\`\`\`lathe-job\n${block}\n\`\`\`\n\nIt takes about 4 minutes.`;

test('a reply with one valid block gives the job, and the prose without it', () => {
  const result = jobFromReply(reply(dumbbell));
  assert.ok(result.ok);
  assert.equal(result.job.name, 'Dumbbell handle');
  assert.equal(replyProse(reply(dumbbell)), 'Here is the job.\n\nIt takes about 4 minutes.');
});

test('missing, repeated, broken and invalid blocks become errors the agent can fix', () => {
  assert.deepEqual(jobFromReply('No block here').errors, ['The reply has no ```lathe-job block']);
  assert.match(jobFromReply(reply(dumbbell) + reply(dumbbell)).errors[0], /more than one/);
  assert.match(jobFromReply(reply('{ "version": 1, ')).errors[0], /not valid JSON/);
  const job = JSON.parse(dumbbell);
  job.stock.stickout = 200;
  job.operations[0].tool = 9;
  assert.deepEqual(jobFromReply(reply(JSON.stringify(job))).errors, [
    'stock.stickout: stickout (200) is longer than the bar (length 160); make length at least stickout + 30 mm to grip',
    'operations.0.tool: tool 9 is not in tools',
  ]);
  // Cross-field checks only run once the fields themselves are valid.
  delete job.gcode;
  assert.deepEqual(jobFromReply(reply(JSON.stringify(job))).errors, ['gcode: Invalid input: expected string, received undefined']);
});
