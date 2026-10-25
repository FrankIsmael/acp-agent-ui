/**
 * Runs a job through the simulator and lists what's wrong with it, worded for the agent that
 * wrote it: the geometry against the bar and the jaws, the simulator's warnings, and where the
 * cut part differs from the target profile.
 */
import type { Segment } from './gcode/plan.ts';
import type { Job, Tool } from './job-schema.ts';
import { arcProblems } from './profile.ts';
import { buildTimeline } from './timeline.ts';
import { compareToProfile } from './stock.ts';
import { endEdgeAngle, INSERT_EDGE_MM } from './tool-shapes.ts';

const LEFTOVER_MM = 0.3; // radius; more than this left over the profile is a missed cut
const GOUGE_MM = 0.1;
const JAW_CLEARANCE_MM = 2;

const mm = (value: number) => Number(value.toFixed(2));

export function checkJob(job: Job): string[] {
  const problems: string[] = [];
  const { stock, profile } = job;
  const jawZ = stock.faceStock - stock.stickout; // where the jaws start holding the bar

  // The target profile, against the bar.
  if (profile.length < 2) problems.push('profile: needs at least two [z, diameter] points');
  else {
    if (profile[0][0] !== 0) problems.push(`profile: must start at the finished front face, Z0 (it starts at Z${profile[0][0]})`);
    const ahead = profile.filter(([z]) => z > 0);
    if (ahead.length) problems.push(`profile: Z is negative toward the chuck; ${ahead.length} point(s) have Z > 0, in front of the bar (e.g. [${ahead[0].join(', ')}])`);
    const fat = profile.filter(([, d]) => d > stock.diameter + 1e-6);
    if (fat.length) problems.push(`profile: diameter ${fat[0][1]} is larger than the bar (Ø${stock.diameter}); a lathe only removes material`);
    if (profile.some(([, d]) => d < 0)) problems.push('profile: diameters must be ≥ 0');
    if (profile.some(([z], i) => i > 0 && z > profile[i - 1][0])) problems.push('profile: Z must never increase from one point to the next (front face first, toward the chuck)');
    problems.push(...arcProblems(profile));
    const back = Math.min(...profile.map(([z]) => z));
    if (back < jawZ + JAW_CLEARANCE_MM)
      problems.push(`profile: it reaches Z${mm(back)}, but the jaws hold the bar from Z${mm(jawZ)}; increase stock.stickout (and stock.length) or shorten the part`);
  }

  const timeline = buildTimeline(job);
  for (const warning of timeline.warnings) problems.push(`line ${warning.line}: ${warning.message}`);

  // Moves that hit the chuck: below the bar's surface and behind the start of the jaws.
  const hit = timeline.segments.find((s) => s.kind !== 'dwell' && Math.min(s.from.z, s.to.z) < jawZ + JAW_CLEARANCE_MM && Math.min(s.from.x, s.to.x) < stock.diameter + 10);
  if (hit) problems.push(`line ${hit.line}: the tool goes to Z${mm(Math.min(hit.from.z, hit.to.z))}, into the chuck jaws (they start at Z${mm(jawZ)})`);

  if (timeline.startWeight - timeline.endWeight < 1e-3) problems.push('the program removes no material: check the X and Z values against the bar');
  else if (profile.length >= 2) {
    const { leftover, leftoverZ, gouge, gougeZ } = compareToProfile(timeline.final, timeline.shape, profile);
    if (leftover > LEFTOVER_MM)
      problems.push(
        `the cut part is ${mm(leftover * 2)} mm over the profile's diameter at Z${mm(leftoverZ)}: ` +
          (job.generated
            ? `no tool in the turret reaches into that corner. ${unreachableHint(job)}`
            : "a pass is missing there, or the tool's insert can't reach that wall"),
      );
    if (gouge > GOUGE_MM)
      problems.push(
        `the cut part is ${mm(gouge * 2)} mm under the profile's diameter at Z${mm(gougeZ)}: ` +
          (wallTooSteep(job, timeline.segments, gougeZ) ?? "a move cuts too deep (nose radius not compensated, or the tool's width or angle)"),
      );
  }
  return problems;
}

/** How to open up a corner that the generated program can't reach, with the turret's numbers. */
function unreachableHint({ tools }: Job): string {
  const nose = Math.min(...tools.flatMap((tool) => (tool.type === 'turning' ? [tool.noseRadius] : [])));
  const reach = Math.max(0, ...tools.flatMap((tool) => (tool.type === 'turning' ? [endEdgeAngle(tool)] : [])));
  const blade = tools.find((tool) => tool.type === 'parting');
  return (
    `Where a wall falling toward the chuck meets one rising again, leave room: a flat bottom at least ${mm(Math.max(1, nose * 4))} mm long ` +
    `(${blade ? `${mm(blade.width)} mm if the falling wall is steeper than ${mm(reach)}°` : `with the falling wall under ${mm(reach)}°`}), ` +
    `or a cove (negative R) of at least ${mm(Math.max(1, nose * 2.5))} mm, instead of a sharp V. Change the profile; the G-code is generated from it.`
  );
}

/**
 * The usual cause of a gouge just in front of a step down toward the chuck: a turning tool went
 * into the recess behind it, and its insert trails into the wall because the wall is steeper
 * than its end cutting edge angle. Says which wall and which tools, and what can cut it instead.
 * Undefined when the gouge has another cause.
 */
function wallTooSteep(job: Job, segments: Segment[], gougeZ: number): string | undefined {
  const { profile, tools } = job;
  for (let i = 1; i < profile.length; i++) {
    const [z0, d0] = profile[i - 1], [z1, d1] = profile[i];
    if (d1 >= d0) continue; // only walls whose diameter falls toward the chuck face it
    // The insert's trailing edge reaches INSERT_EDGE_MM in front of the point it is programmed at.
    if (gougeZ > z0 + INSERT_EDGE_MM || gougeZ < z1 - 0.5) continue;
    const wall = (Math.atan2((d0 - d1) / 2, z0 - z1) * 180) / Math.PI; // from the axis; 90 = square
    const offenders = tools.filter(
      (tool): tool is Extract<Tool, { type: 'turning' }> =>
        tool.type === 'turning' &&
        endEdgeAngle(tool) < wall - 0.5 &&
        segments.some((s) => s.tool === tool.id && s.kind !== 'dwell' && Math.min(s.from.z, s.to.z) < z0 - 0.05 && Math.min(s.from.x, s.to.x) < d0 - 0.05),
    );
    if (!offenders.length) continue;
    const steepest = Math.max(0, ...tools.flatMap((tool) => (tool.type === 'turning' ? [endEdgeAngle(tool)] : [])));
    const parting = tools.find((tool) => tool.type === 'parting');
    const fixes = [
      parting && `cut the step behind it with the parting tool (T${parting.id}), plunging side by side in Z`,
      steepest > 1 && `make the wall a chamfer shallower than ${mm(steepest)}° and use the tool that allows it`,
    ].filter(Boolean);
    return (
      `the wall at Z${mm(z0)}${z1 !== z0 ? `…Z${mm(z1)}` : ''} (Ø${mm(d0)} → Ø${mm(d1)}) faces the chuck at ${mm(wall)}° from the axis, ` +
      `and ${offenders.map((tool) => `T${tool.id} (${tool.insert}) can only go down walls shallower than ${mm(endEdgeAngle(tool))}°`).join(', ')}, so ${offenders.length > 1 ? 'their inserts cut' : 'its insert cuts'} into that wall. ` +
      (fixes.length ? `Don't take a turning tool down it: ${fixes.join(', or ')}.` : 'No tool in the job can cut it: add a parting or grooving tool.')
    );
  }
}
