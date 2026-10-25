import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJob } from '../../app/lathe/sim/job-schema.ts';
import { checkJob } from '../../app/lathe/sim/check.ts';

const dumbbell = () => JSON.parse(readFileSync(new URL('../../app/lathe/examples/dumbbell.json', import.meta.url), 'utf8'));
const check = (data) => {
  const parsed = parseJob(data);
  assert.ok(parsed.ok, parsed.errors?.join('\n'));
  return checkJob(parsed.job);
};

test('the examples have no problems', () => {
  assert.deepEqual(check(dumbbell()), []);
  const pulley = JSON.parse(readFileSync(new URL('../../app/lathe/examples/pulley.json', import.meta.url), 'utf8'));
  assert.deepEqual(check(pulley), []);
});

test('a profile outside the bar or into the jaws is reported', () => {
  const job = dumbbell();
  job.profile = [[0, 0], [0, 70], [10, 50], [-150, 50]];
  const problems = check(job).join('\n');
  assert.match(problems, /Z > 0/);
  assert.match(problems, /larger than the bar/);
  assert.match(problems, /never increase/);
  assert.match(problems, /jaws hold the bar/);
});

test('a rapid along the axis after facing to the center is reported with its damage', () => {
  const job = dumbbell();
  job.profile = [[0, 0], [0, 60], [-30, 60]];
  job.operations = [];
  job.gcode = 'G21 G99\nT0101\nG97 S800 M3\nG0 X64 Z0\nG1 X-1 F0.2\nG0 U2\nG0 Z-25\nG0 X80\nM30';
  const problems = check(job).join('\n');
  assert.match(problems, /line 7: A rapid move \(G0\) goes through the material/);
  assert.match(problems, /under the profile's diameter/);
});

// A rear journal: Ø40 to Z-30, then Ø25 to Z-40, a square wall facing the chuck at Z-30.
const rearJournal = (cutStep) => {
  const job = dumbbell();
  job.profile = [[0, 0], [0, 40], [-30, 40], [-30, 25], [-40, 25]];
  job.operations = [];
  job.gcode = [
    'G21 G18 G40 G99', 'G50 S2500', '(Face)', 'T0101', 'G96 S200 M3', 'G0 X64 Z3', 'G0 Z0', 'G1 X-1.6 F0.2', 'G0 Z3',
    '(Rough OD)', ...[54, 48, 42, 40.5].flatMap((x) => [`G0 X${x}`, 'G1 Z-40 F0.25', 'G0 X64', 'G0 Z3']),
    ...cutStep,
    '(Part off)', 'G28 U0 W0', 'T0303', 'G96 S100 M3', 'G0 X64 Z-43', 'G1 X0 F0.06', 'G0 X64', 'M30',
  ].join('\n');
  return job;
};

test('a turning tool taken down a wall facing the chuck is told which wall and what cuts it', () => {
  const problems = check(rearJournal([
    '(Finish profile)', 'G28 U0 W0', 'T0202', 'G96 S260 M3', 'G0 X64 Z3', 'G0 X40 Z1',
    'G1 Z-30 F0.1', 'G1 X25', 'G1 Z-40', 'G0 X64',
  ])).join('\n');
  assert.match(problems, /the wall at Z-30 \(Ø40 → Ø25\) faces the chuck at 90°/);
  assert.match(problems, /T2 \(VNMG 160404\) can only go down walls shallower than 52°/);
  assert.match(problems, /parting tool \(T3\)/);
});

test('a step toward the chuck cut with the parting tool passes', () => {
  assert.deepEqual(check(rearJournal([
    '(Finish profile)', 'G28 U0 W0', 'T0202', 'G96 S260 M3', 'G0 X64 Z3', 'G0 X40 Z1', 'G1 Z-30 F0.1', 'G0 X64',
    '(Rear journal)', 'G28 U0 W0', 'T0303', 'G96 S120 M3',
    ...[-33, -35.5, -38, -40].flatMap((z) => [`G0 X64 Z${z}`, 'G1 X25 F0.06', 'G0 X64']),
  ])), []);
});

test('a program that never touches the bar is reported', () => {
  const job = dumbbell();
  job.gcode = 'G21 G99\nT0101\nG97 S800 M3\nG0 X100 Z10\nG1 X90 F0.2\nM30';
  assert.match(check(job).join('\n'), /removes no material/);
});

test('the setup brief gives the agent the bar, jaws, home and tools as numbers', async () => {
  const { setupBrief } = await import('../../app/lathe/setup-brief.ts');
  const { setupSchema } = await import('../../app/lathe/sim/job-schema.ts');
  const { material, stock, tools } = dumbbell();
  const brief = setupBrief(setupSchema.parse({ material, stock, tools }));
  assert.match(brief, /Ø60 × 160 mm, 120 mm out of the jaws/);
  assert.match(brief, /jaws hold the bar from Z-119: keep every move at Z-114/);
  assert.match(brief, /Longest part with this bar as it sits, parting off included: 111 mm/);
  assert.match(brief, /Home.*X110 Z51/);
  assert.match(brief, /T1 "Rougher" \(T0101\).*shallower than 5°/);
  assert.match(brief, /`G1 X-1.6`/);
  console.log(brief);
});
