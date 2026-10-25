import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseGcode } from '../../app/lathe/sim/gcode/parse.ts';
import { planProgram } from '../../app/lathe/sim/gcode/plan.ts';
import { parseJob } from '../../app/lathe/sim/job-schema.ts';
import { STEP_MM, compareToProfile, partWeight, profileRadiusAt, weight } from '../../app/lathe/sim/stock.ts';
import { buildTimeline } from '../../app/lathe/sim/timeline.ts';

const plan = (gcode, home = { x: 100, z: 50 }) => planProgram(parseGcode(gcode).blocks, { home });
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? ''} ${actual} is not within ${tolerance} of ${expected}`);
const dumbbell = JSON.parse(readFileSync(new URL('../../app/lathe/examples/dumbbell.json', import.meta.url), 'utf8'));

const job = (gcode, extra = {}) => {
  const result = parseJob({
    version: 1, name: 'test', material: { name: 'steel', density: 7.85 },
    stock: { diameter: 60, length: 100, stickout: 80, faceStock: 0 },
    tools: [{ id: 1, name: 'Rougher', type: 'turning', noseRadius: 0 }],
    gcode, ...extra,
  });
  assert.ok(result.ok, JSON.stringify(result.errors));
  return result.job;
};

test('the parser reads words, skips comments, sequence and program numbers', () => {
  const { blocks, issues } = parseGcode('%\nO1001 (MAIN)\nN10 G1 X30. Z-12.5 F.2 ; finish\n\n(only a comment)\nM30\n%');
  assert.deepEqual(issues, []);
  assert.deepEqual(blocks.map((b) => b.line), [3, 6]);
  assert.deepEqual(blocks[0].words, [
    { letter: 'G', value: 1 }, { letter: 'X', value: 30 }, { letter: 'Z', value: -12.5 }, { letter: 'F', value: 0.2 },
  ]);
});

test('feed per minute, feed per revolution and rapids take the right time', () => {
  const perMin = plan('G98 G1 X100 Z-10 F600\nM30');
  near(perMin.duration, 6, 1e-9, 'Z60 at 600 mm/min');
  const perRev = plan('G97 S1000 M3\nG99 G1 Z30 F0.2\nM30');
  near(perRev.duration, 6, 1e-9, 'Z20 at 0.2 mm/rev, 1000 rpm');
  const rapid = plan('G0 X40 Z-10\nM30');
  near(rapid.duration, 0.6, 1e-9, '60 mm of Z at 6000 mm/min');
  assert.deepEqual(perMin.warnings, []);
});

test('constant surface speed follows the diameter and stops at the G50 limit', () => {
  const { segments } = plan('G50 S2000\nG96 S200 M3\nG0 X60 Z0\nG1 X0 F0.1\nM30');
  const feeds = segments.filter((s) => s.kind === 'feed');
  near(feeds[0].rpm, (1000 * 200) / (Math.PI * 59), 1, 'rpm at Ø59');
  assert.equal(feeds.at(-1).rpm, 2000);
  assert.ok(feeds.every((s, i) => i === 0 || s.rpm >= feeds[i - 1].rpm));
});

test('arcs end where programmed and stay on their circle', () => {
  // Quarter circle, radius 10, from the front face corner down to Ø20 at Z-10 (concave, so G3 with X up and Z to the right).
  for (const gcode of ['G0 X40 Z0\nG98 G3 X20 Z-10 R10 F100\nM30', 'G0 X40 Z0\nG98 G3 X20 Z-10 I-10 K0 F100\nM30']) {
    const { segments } = plan(gcode);
    const arc = segments.filter((s) => s.kind === 'feed');
    assert.deepEqual(arc.at(-1).to, { x: 20, z: -10 });
    for (const s of arc) near(Math.hypot(s.to.x / 2 - 10, s.to.z - 0), 10, 1e-6, gcode);
  }
});

test('unknown codes are warnings, not errors', () => {
  const { warnings } = plan('G71 U2 R1\nM99\nG0 X20');
  assert.deepEqual(warnings.map((w) => w.message), ['G71 is not supported yet; skipped', 'M99 is not supported yet; skipped', 'The program has no M30']);
});

test('turning a bar removes the expected weight', () => {
  const timeline = buildTimeline(job('T0101\nG97 S1000 M3\nG0 X50 Z2\nG99 G1 Z-50 F0.2\nG0 X70\nM30'));
  const start = (Math.PI * 30 ** 2 * 100 * 7.85) / 1000;
  const removed = (Math.PI * (30 ** 2 - 25 ** 2) * 50 * 7.85) / 1000;
  near(timeline.startWeight, start, start * 0.001, 'start weight');
  near(timeline.endWeight, start - removed, removed * 0.01, 'end weight');
  assert.deepEqual(timeline.warnings, []);
});

test('a rapid through the material is reported', () => {
  const timeline = buildTimeline(job('T0101\nG97 S1000 M3\nG0 X50 Z2\nG0 Z-20\nM30'));
  assert.deepEqual(timeline.warnings.map((w) => w.message), ['A rapid move (G0) goes through the material']);
});

test('scrubbing gives the same profile as playing, and weight only goes down', () => {
  const timeline = buildTimeline(parseJob(dumbbell).job);
  const out = new Float32Array(timeline.shape.n);
  let last = Infinity;
  for (let t = 0; t <= timeline.duration; t += timeline.duration / 97) {
    const w = weight(timeline.profileAt(t, out), timeline.shape.step, 7.85);
    assert.ok(w <= last + 1e-6, `weight went up at t=${t}`);
    last = w;
  }
  timeline.profileAt(timeline.duration, out);
  assert.deepEqual(out, timeline.final);
});

test('the dumbbell example cuts to its profile and weighs what it should (within 1 %)', () => {
  const result = parseJob(dumbbell);
  assert.ok(result.ok);
  const timeline = buildTimeline(result.job);
  assert.deepEqual(timeline.warnings, []);
  // Finished part from the profile, plus the bar left in the chuck behind the parting cut (Z-113 to Z-159).
  let part = 0;
  for (let z = -110; z < 0; z += 0.01) part += Math.PI * profileRadiusAt(dumbbell.profile, z + 0.005) ** 2 * 0.01;
  const expected = ((part + Math.PI * 30 ** 2 * 46) * 7.85) / 1000;
  near(timeline.endWeight, expected, expected * 0.01, 'final weight');
  // Every point of the part is within the finishing tolerance of the profile, and nothing is cut under it.
  const { shape, final } = timeline;
  for (let i = 0; i < shape.n; i++) {
    const z = shape.zFront - i * shape.step;
    if (z > -0.5 || z < -109.5 || Math.abs(z + 12) < 1 || Math.abs(z + 98) < 1) continue; // edges and inside corners
    const target = profileRadiusAt(dumbbell.profile, z);
    assert.ok(final[i] - target < 0.3, `left ${final[i] - target} at Z${z}`);
    assert.ok(target - final[i] < 0.02, `gouged ${target - final[i]} at Z${z}`);
  }
});

test('results compare only inside the profile ends and weigh just the part', () => {
  const timeline = buildTimeline(parseJob(dumbbell).job);
  const { leftover, gouge } = compareToProfile(timeline.final, timeline.shape, dumbbell.profile);
  assert.ok(leftover > 0 && leftover < 0.1, `leftover ${leftover}`);
  assert.ok(gouge < STEP_MM, `gouge ${gouge}`); // below the grid, on the 45° walls
  let part = 0;
  for (let z = -110; z < 0; z += 0.01) part += Math.PI * profileRadiusAt(dumbbell.profile, z + 0.005) ** 2 * 0.01;
  const expected = (part * 7.85) / 1000;
  near(partWeight(timeline.final, timeline.shape, dumbbell.profile, 7.85), expected, expected * 0.01, 'part weight');
});

test('a job without operations gets them from its comment lines and tool changes', () => {
  const gcode = ['%', 'G21 G18 G40 G99', '(Face)', 'T0101', 'G0 X64 Z0', 'G1 X-1.6 F0.2', '(Rough OD)', 'G0 X56 Z2', 'G1 Z-50',
    'G28 U0 W0', 'T0202', 'G1 X50 Z-60', 'G28 U0 W0', '(Part off)', 'T0303', 'G1 X0', 'M30', '%'].join('\n');
  const result = parseJob({ ...dumbbell, operations: undefined, gcode });
  assert.ok(result.ok);
  assert.deepEqual(result.job.operations, [
    { name: 'Face', tool: 1, lines: [3, 6] },
    { name: 'Rough OD', tool: 1, lines: [7, 10] },
    { name: 'Profiler', tool: 2, lines: [11, 13] }, // a tool change after a cut, with no comment
    { name: 'Part off', tool: 3, lines: [14, 17] },
  ]);
  // Listed operations are kept as they are.
  assert.deepEqual(parseJob(dumbbell).job.operations, dumbbell.operations);
});
