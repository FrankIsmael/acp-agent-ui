import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseJob } from '../../app/lathe/sim/job-schema.ts';
import { checkJob } from '../../app/lathe/sim/check.ts';
import { arcProblems, profileRangeAt } from '../../app/lathe/sim/profile.ts';

const example = (name) => JSON.parse(readFileSync(new URL(`../../app/lathe/examples/${name}.json`, import.meta.url), 'utf8'));
const withoutGcode = ({ gcode, operations, ...job }) => job;
const generated = (data) => {
  const parsed = parseJob(data);
  assert.ok(parsed.ok, parsed.errors?.join('\n'));
  assert.equal(parsed.job.generated, true);
  return parsed.job;
};

test('the G-code generated from each example profile passes the simulator', () => {
  for (const name of ['dumbbell', 'pulley', 'pawn', 'queen', 'bearing-housing']) {
    const job = generated(withoutGcode(example(name)));
    assert.deepEqual(checkJob(job), [], name);
    assert.deepEqual(job.operations.map((op) => op.name).slice(0, 2), ['Face', 'Rough OD'], name);
    assert.equal(job.operations.at(-1).name, 'Part off', name);
  }
});

const rook = {
  ...withoutGcode(example('dumbbell')),
  name: 'Rook',
  material: { name: '6061 aluminum', density: 2.7 },
  stock: { diameter: 45, length: 150, stickout: 118, faceStock: 1 },
  profile: [[0, 0], [0, 32], [-1, 34], [-14, 34], [-15, 32], [-17, 28], [-22, 24, -20], [-75, 24], [-85, 32, -12], [-88, 38], [-92, 40, 4], [-100, 40], [-103, 38]],
};

test('arcs in the profile come out as G2/G3 moves and the part matches them', () => {
  const job = generated(rook);
  assert.deepEqual(checkJob(job), []);
  assert.ok(job.gcode.split('\n').some((line) => /^G2 .*R/.test(line)), 'a concave arc (G2)');
  assert.ok(job.gcode.split('\n').some((line) => /^G3 .*R/.test(line)), 'a convex arc (G3)');
  assert.match(job.gcode, /G96 S300 M3/); // aluminum cutting data
});

test('cam settings change the program', () => {
  const job = generated({ ...rook, cam: { depthOfCut: 1, finishFeed: 0.05 } });
  assert.deepEqual(checkJob(job), []);
  assert.match(job.gcode, /F0.05/);
  const passes = (gcode) => gcode.split('(Rest rough)')[0].split('\n').filter((l) => /^G1 Z/.test(l)).length;
  assert.ok(passes(job.gcode) > passes(generated(rook).gcode));
});

test('profile arcs: geometry and the problems the agent is told about', () => {
  // A quarter dome from the center to Ø20 at Z-5.
  const dome = [[0, 0], [-5, 10, 5]];
  assert.ok(Math.abs(profileRangeAt(dome, -1).hi - Math.sqrt(25 - 16)) < 1e-9);
  assert.ok(Math.abs(profileRangeAt([[0, 10], [-10, 10, -5]], -5).hi - 0) < 1e-9); // a cove down to the axis
  assert.match(arcProblems([[0, 10], [-10, 10, 2]])[0], /too tight for its chord; use \|R\| ≥ 5/);
  assert.match(arcProblems([[0, 10], [-2, 20, 3]])[0], /curl back in Z/);
  const parsed = parseJob({ ...rook, profile: [[0, 0], [0, 30], [-10, 30, 2]] });
  assert.ok(!parsed.ok);
  assert.match(parsed.errors[0], /use \|R\| ≥/);
  // A dome from the axis: the message names the radius of a smooth spherical top.
  assert.match(arcProblems([[0, 0], [-8, 25, 13]])[0], /use \|R\| ≥ 13\.77; R 13\.77 gives a smooth round top/);
  assert.deepEqual(arcProblems([[0, 0], [-8, 25, 13.77]]), []);
});

test('a bore is drilled, bored and its internal groove cut with the grooving tool', async () => {
  const { buildTimeline } = await import('../../app/lathe/sim/timeline.ts');
  const { partWeight } = await import('../../app/lathe/sim/stock.ts');
  const job = generated(withoutGcode(example('bearing-housing')));
  assert.deepEqual(checkJob(job), []);
  assert.deepEqual(job.operations.map((op) => op.name), ['Face', 'Rough OD', 'Rest rough', 'Finish profile', 'Drill', 'Rough bore', 'Finish bore', 'Internal grooves', 'Part off']);
  const groove = job.gcode.split('(Internal grooves)')[1].split('(Part off)')[0];
  assert.match(groove, /T0606/);
  assert.match(groove, /G1 X37\b/); // out to the groove's diameter
  assert.match(job.gcode.split('(Drill)')[1], /G97 S\d+ M3\nG0 X0\nG0 Z1\nG1 Z-18 /); // pecks at the center, fixed rpm
  const timeline = buildTimeline(job);
  assert.ok(timeline.hollow);
  // Ø50 × 30 less the bore's volume, about 0.35 kg instead of 0.46 solid.
  const grams = partWeight(timeline.final, timeline.shape, job.profile, 7.85, timeline.finalBore);
  assert.ok(grams > 300 && grams < 380, `part weight ${grams}`);
});

test('a groove in a plain drilled hole needs no boring bar', () => {
  const data = withoutGcode(example('bearing-housing'));
  data.tools = data.tools.filter((tool) => tool.type !== 'boring');
  data.tools.find((tool) => tool.type === 'drill').diameter = 20;
  data.tools.find((tool) => tool.type === 'internal-grooving').minBore = 18;
  data.bore = [[0, 20], [-8, 20], [-8, 22], [-9.6, 22], [-9.6, 20], [-30, 20]];
  const job = generated(data);
  assert.deepEqual(checkJob(job), []);
  assert.deepEqual(job.operations.map((op) => op.name).slice(4), ['Drill', 'Internal grooves', 'Part off']);
});

test('bore problems are worded for the agent', () => {
  const base = withoutGcode(example('bearing-housing'));
  const noDrill = parseJob({ ...base, tools: base.tools.filter((tool) => tool.type !== 'drill') });
  assert.ok(!noDrill.ok);
  assert.match(noDrill.errors[0], /add a drill to make the bore, at most Ø20/);
  const blind = parseJob({ ...base, bore: [[0, 20], [-28, 20]] });
  assert.ok(!blind.ok);
  assert.match(blind.errors[0], /drill's point goes 5\.41 mm past the end of the bore/);
  // A groove 4 mm deep per side, past what the grooving tool reaches (3 mm).
  const deep = generated({ ...base, bore: [[0, 36], [-0.5, 35], [-2, 35], [-2, 43], [-3.6, 43], [-3.6, 35], [-14.6, 35], [-14.6, 20], [-30, 20]] });
  assert.match(checkJob(deep).join('\n'), /cuts a groove 4 mm deep per side .* reaches only 3 mm/);
  const thin = generated({ ...base, bore: [[0, 47], [-30, 47]], tools: [...base.tools, { id: 7, name: 'Big drill', type: 'drill', diameter: 40 }] });
  assert.match(checkJob(thin).join('\n'), /a wall of 0\.5 mm; keep at least 1 mm/);
});
