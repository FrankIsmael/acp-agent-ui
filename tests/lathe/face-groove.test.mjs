import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJob } from '../../app/lathe/sim/job-schema.ts';
import { checkJob } from '../../app/lathe/sim/check.ts';
import { buildTimeline } from '../../app/lathe/sim/timeline.ts';
import { floorAt, gapAt, sampleFloor } from '../../app/lathe/sim/face-groove.ts';
import { freshGap, partWeight } from '../../app/lathe/sim/stock.ts';

// A queen's head: a dome standing in a cup, the bowl between them a face groove.
const head = {
  version: 1,
  name: 'Queen head',
  material: { name: '6061 aluminum', density: 2.7 },
  stock: { diameter: 32, length: 100, stickout: 60, faceStock: 1 },
  profile: [[0, 0], [-3, 6, 3], [-4, 6], [-5, 4], [-6, 4], [-10, 12, 5], [-10, 28], [-11, 28], [-24, 18, -30], [-26, 18], [-26, 22], [-28, 22], [-29, 16], [-40, 16]],
  faceGroove: [[-10, 12], [-13.5, 19, -3.5], [-13.5, 20], [-10, 24.5, -4]],
  tools: [
    { id: 1, name: 'Rougher', type: 'turning', insert: 'CNMG 120408', noseRadius: 0.8, angle: 80, approach: 95 },
    { id: 2, name: 'Profiler', type: 'turning', insert: 'VNMG 160404', noseRadius: 0.4, angle: 35, approach: 93 },
    { id: 3, name: 'Parting', type: 'parting', width: 3 },
    { id: 4, name: 'Face groover', type: 'face-grooving', width: 2, depth: 8, minDiameter: 10 },
  ],
};

const parse = (data) => {
  const parsed = parseJob(data);
  assert.ok(parsed.ok, parsed.errors?.join('\n'));
  return parsed.job;
};
const errors = (data) => {
  const parsed = parseJob(data);
  assert.ok(!parsed.ok, 'expected the job to be rejected');
  return parsed.errors.join('\n');
};

test('face groove geometry: the bottom by radius and the ring at each z', () => {
  // A quarter circle from the inner wall's top (Ø12, Z-10) down to a flat at Z-13.5.
  assert.ok(Math.abs(floorAt(head.faceGroove, 6) + 10) < 1e-9);
  assert.ok(Math.abs(floorAt(head.faceGroove, 9.5) + 13.5) < 1e-9);
  assert.ok(Math.abs(floorAt(head.faceGroove, 6 + 3.5 - 3.5 * Math.SQRT1_2) - (-10 - 3.5 * Math.SQRT1_2)) < 1e-6);
  const floor = sampleFloor(head.faceGroove, 0.05);
  assert.equal(gapAt(floor, -13.6), undefined);
  const ring = gapAt(floor, -10);
  assert.ok(Math.abs(ring.lo - 6) < 0.06 && Math.abs(ring.hi - 12.25) < 0.06);
});

test('a generated face groove is cut to its shape and passes the simulator', () => {
  const job = parse(head);
  assert.deepEqual(checkJob(job), []);
  assert.ok(job.operations.some((op) => op.name === 'Face groove' && op.tool === 4));
  const timeline = buildTimeline(job);
  assert.ok(timeline.grooved);
  // The groove's volume comes off the part's weight.
  const solid = partWeight(timeline.final, timeline.shape, job.profile, 2.7, timeline.finalBore);
  const part = partWeight(timeline.final, timeline.shape, job.profile, 2.7, timeline.finalBore, timeline.finalGap);
  assert.ok(solid - part > 0.5, `${solid} vs ${part}`);
});

test('scrubbing replays the face groove the same as playing it', () => {
  const timeline = buildTimeline(parse(head));
  const { n } = timeline.shape;
  const out = new Float32Array(n), inner = new Float32Array(n), gap = freshGap(timeline.shape);
  timeline.profileAt(timeline.duration, out, inner, gap);
  assert.deepEqual(out, timeline.final);
  assert.deepEqual(gap.lo, timeline.finalGap.lo);
  assert.deepEqual(gap.hi, timeline.finalGap.hi);
  // Halfway through a plunge the groove is partly cut.
  const plunge = timeline.segments.findIndex((s) => s.tool === 4 && s.kind === 'feed');
  const s = timeline.segments[plunge];
  timeline.profileAt(s.t0 + s.dt / 2, out, inner, gap);
  const open = (g) => g.hi.reduce((sum, hi, i) => sum + Math.max(0, hi - g.lo[i]), 0);
  assert.ok(open(gap) > 0 && open(gap) < open(timeline.finalGap));
});

test('the problems the agent is told about a face groove', () => {
  const noTool = { ...head, tools: head.tools.filter((t) => t.type !== 'face-grooving') };
  assert.match(errors(noTool), /add a face grooving tool/);
  assert.match(errors({ ...head, faceGroove: [[-10, 24], [-12, 20], [-10, 12]] }), /never fall/);
  assert.match(errors({ ...head, faceGroove: [[-10, 12], [-13, 15], [-11, 17], [-13, 19], [-10, 23]] }), /ridge between two grooves/);
  assert.match(errors({ ...head, faceGroove: [[-10, 12], [-13, 14], [-13, 26], [-10, 27]] }), /keep at least 1 mm/);
  assert.match(errors({ ...head, faceGroove: [[-10, 12], [-13, 13], [-13, 14], [-10, 15]] }), /at least as wide as the blade/);
  const small = { ...head, tools: head.tools.map((t) => (t.type === 'face-grooving' ? { ...t, minDiameter: 16 } : t)) };
  assert.match(errors(small), /fits inner walls of Ø16 or more/);
  const short = { ...head, tools: head.tools.map((t) => (t.type === 'face-grooving' ? { ...t, depth: 2 } : t)) };
  assert.match(errors(short), /reaches 2 mm/);
  assert.match(errors({ ...head, faceGroove: [[-10, 12], [-13.5, 19, -2]] }), /too tight for its chord; use \|R\| ≥ 2.48/);
  assert.match(errors({ ...head, faceGroove: [[-10, 12], [-13.5, 19, -2.6], [-10, 24.5]] }), /curl back over itself/);
});

test('a V bottom narrower than the blade is reported as material left', () => {
  const job = parse({ ...head, faceGroove: [[-10, 12], [-13.5, 18], [-10, 24]] });
  assert.match(checkJob(job).join('\n'), /face groove has .* mm of material left.*flat or a round/);
});
