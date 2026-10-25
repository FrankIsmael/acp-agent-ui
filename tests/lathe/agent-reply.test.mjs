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
  // Without gcode the job is still checked; the program is generated from the profile.
  delete job.gcode;
  job.tools[0].noseRadius = -1;
  assert.equal(jobFromReply(reply(JSON.stringify(job))).errors[0], 'tools.0.noseRadius: Too small: expected number to be >=0');
});

test('a generated job on a bar far bigger than the part gets a standard bar 2–5 mm over it', () => {
  const tools = [
    { id: 1, name: 'Rougher', type: 'turning', insert: 'CNMG 120408', noseRadius: 0.8, angle: 80, approach: 95 },
    { id: 3, name: 'Parting', type: 'parting', width: 3 },
  ];
  const pin = { version: 1, name: 'Pin', units: 'mm', material: { name: 'steel', density: 7.85 }, stock: { diameter: 60, length: 84, stickout: 54, faceStock: 1 }, profile: [[0, 0], [0, 11], [-1, 12], [-39, 12], [-40, 11]], tools };
  const block = (job) => '```lathe-job\n' + JSON.stringify(job) + '\n```';
  const result = jobFromReply(block(pin));
  assert.ok(result.ok);
  assert.equal(result.job.stock.diameter, 16);
  assert.match(result.job.assumptions.at(-1), /Bar changed from Ø60 to Ø16/);
  // Within 6 mm of the part, or with hand-written G-code, the bar stays.
  const close = jobFromReply(block({ ...pin, stock: { ...pin.stock, diameter: 16 } }));
  assert.ok(close.ok && close.job.stock.diameter === 16 && close.job.assumptions.length === 0);
});

test('bars over Ø100 come in standard sizes up to the chuck limit', () => {
  const tools = [
    { id: 1, name: 'Rougher', type: 'turning', insert: 'CNMG 120408', noseRadius: 0.8, angle: 80, approach: 95 },
    { id: 3, name: 'Parting', type: 'parting', width: 3 },
  ];
  // A Ø105 flange on a Ø150 bar is swapped to Ø110; the bar is too thick for the spindle, so it stays short.
  const flange = { version: 1, name: 'Flange', units: 'mm', material: { name: 'steel', density: 7.85 }, stock: { diameter: 150, length: 64, stickout: 34, faceStock: 1 }, profile: [[0, 0], [0, 103], [-1, 105], [-19, 105], [-20, 103]], tools };
  const result = jobFromReply('```lathe-job\n' + JSON.stringify(flange) + '\n```');
  assert.ok(result.ok);
  assert.equal(result.job.stock.diameter, 110);
});
