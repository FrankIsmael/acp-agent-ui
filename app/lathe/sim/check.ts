/**
 * Runs a job through the simulator and lists what's wrong with it, worded for the agent that
 * wrote it: the geometry against the bar and the jaws, the simulator's warnings, and where the
 * cut part differs from the target profile.
 */
import { MACHINE, type Segment } from './gcode/plan.ts';
import type { Job, Tool } from './job-schema.ts';
import { arcProblems, profileRangeAt } from './profile.ts';
import { buildTimeline } from './timeline.ts';
import { compareToBore, compareToProfile } from './stock.ts';
import { compareToFaceGroove, faceGrooveProblems } from './face-groove.ts';
import { endEdgeAngle, INSERT_EDGE_MM, isInside, toolReach } from './tool-shapes.ts';

const LEFTOVER_MM = 0.3; // radius; more than this left over the profile is a missed cut
const GOUGE_MM = 0.1;
const JAW_CLEARANCE_MM = 2;
const MIN_WALL_MM = 1; // per side, between the bore and the outside

const mm = (value: number) => Number(value.toFixed(2));

export function checkJob(job: Job): string[] {
  const problems: string[] = [];
  const { stock, profile } = job;
  const jawZ = stock.faceStock - stock.stickout; // where the jaws start holding the bar

  problems.push(...machineProblems(job));

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

  problems.push(...boreProblems(job));
  problems.push(...faceGrooveProblems(job.faceGroove, profile, job.bore));

  const timeline = buildTimeline(job);
  for (const warning of timeline.warnings) problems.push(`line ${warning.line}: ${warning.message}`);
  problems.push(...insideToolProblems(job, timeline.segments));
  problems.push(...faceToolProblems(job, timeline.segments));

  // Moves that hit the chuck: below the bar's surface and behind the start of the jaws. An inside
  // tool in the hole is inside the bar, not against the jaws; its reach is checked instead.
  const inside = new Set(job.tools.filter(isInside).map((tool) => tool.id));
  const hit = timeline.segments.find((s) => s.kind !== 'dwell' && !inside.has(s.tool) && Math.min(s.from.z, s.to.z) < jawZ + JAW_CLEARANCE_MM && Math.min(s.from.x, s.to.x) < stock.diameter + 10);
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
    if (job.bore.length >= 2) {
      const bore = compareToBore(timeline.finalBore, timeline.shape, job.bore, profile);
      if (bore.leftover > LEFTOVER_MM)
        problems.push(
          `the bore is ${mm(bore.leftover * 2)} mm under its diameter at Z${mm(bore.leftoverZ)}: ` +
            (job.generated ? boreHint(job) : 'a pass is missing there, or the tool can\'t reach that wall'),
        );
      if (bore.gouge > GOUGE_MM)
        problems.push(`the bore is cut ${mm(bore.gouge * 2)} mm over its diameter at Z${mm(bore.gougeZ)}: a move inside goes too far out (the tool's width, nose or angle)`);
    }
    if (job.faceGroove.length >= 2) {
      const groove = compareToFaceGroove(timeline.final, timeline.finalBore, timeline.finalGap, timeline.shape, job.faceGroove, profile);
      if (groove.leftover > LEFTOVER_MM)
        problems.push(
          `the face groove has ${mm(groove.leftover)} mm of material left at Ø${mm(groove.leftoverD)} Z${mm(groove.leftoverZ)}: ` +
            (job.generated ? faceGrooveHint(job) : 'a pass is missing there, or the blade is too wide for that corner'),
        );
      if (groove.gouge > GOUGE_MM)
        problems.push(`the face groove is cut ${mm(groove.gouge)} mm past its shape at Ø${mm(groove.gougeD)} Z${mm(groove.gougeZ)}: a move goes too deep or too far to the side (the blade's width)`);
    }
  }
  return problems;
}

/** The bar against the machine's limits (MACHINE): the chuck, the spindle bore and the carriage. */
function machineProblems({ stock }: Job): string[] {
  const problems: string[] = [];
  const grip = stock.length - stock.stickout;
  if (stock.diameter > MACHINE.maxBarDiameter)
    problems.push(`stock: a Ø${mm(stock.diameter)} bar is too big for the chuck, which grips up to Ø${MACHINE.maxBarDiameter}; make the part smaller or split it`);
  if (stock.stickout > MACHINE.maxStickout)
    problems.push(`stock: ${mm(stock.stickout)} mm out of the jaws is past the carriage's travel (${MACHINE.maxStickout} mm); shorten the part`);
  if (stock.length > MACHINE.maxBarLength)
    problems.push(`stock: a ${mm(stock.length)} mm bar is longer than the machine takes (${MACHINE.maxBarLength} mm); a shorter bar does, with the same stickout`);
  if (grip < MACHINE.minGrip)
    problems.push(`stock: only ${mm(grip)} mm of the bar is in the jaws; make length at least stickout + ${MACHINE.minGrip}`);
  else if (stock.diameter > MACHINE.spindleBore && grip > MACHINE.chuckDepth)
    problems.push(
      `stock: a Ø${mm(stock.diameter)} bar doesn't go through the spindle (Ø${MACHINE.spindleBore} bore), so only ${MACHINE.chuckDepth} mm of it fits in the chuck; ` +
        `make length at most stickout + ${MACHINE.chuckDepth} (${mm(stock.stickout + MACHINE.chuckDepth)})`,
    );
  return problems;
}

/** The bore against itself and the outside of the part. */
function boreProblems({ bore, profile }: Job): string[] {
  if (!bore.length) return [];
  if (bore.length < 2) return ['bore: needs at least two [z, diameter] points, or leave it out for a solid part'];
  const problems: string[] = [];
  if (bore[0][0] !== 0) problems.push(`bore: must start at the finished front face, Z0 (it starts at Z${bore[0][0]}); a hole is drilled from the front`);
  if (bore.some(([z], i) => i > 0 && z > bore[i - 1][0])) problems.push('bore: Z must never increase from one point to the next (front face first, toward the chuck)');
  if (bore.some(([, d]) => d <= 0)) problems.push('bore: every diameter must be over 0; it ends at its last point (a blind bore ends in the drill\'s point)');
  if (problems.length || profile.length < 2) return problems;
  // The wall between the bore and the outside, every 0.5 mm along the bore.
  const zEnd = Math.max(bore[bore.length - 1][0], Math.min(...profile.map(([z]) => z)));
  for (let z = 0; z >= zEnd; z -= 0.5) {
    const hole = profileRangeAt(bore, z).lo, outer = profileRangeAt(profile, z).hi;
    if (Number.isNaN(hole) || Number.isNaN(outer) || outer - hole >= MIN_WALL_MM - 1e-6) continue;
    problems.push(
      `bore: at Z${mm(z)} it is Ø${mm(2 * hole)} inside Ø${mm(2 * outer)}, a wall of ${mm(outer - hole)} mm; ` +
        `keep at least ${MIN_WALL_MM} mm of wall (a smaller bore or a larger outside there)`,
    );
    break;
  }
  return problems;
}

/** Inside tools: how deep they go, whether they fit the hole they go into, and groove depths. */
function insideToolProblems({ tools, bore }: Job, segments: Segment[]): string[] {
  const problems: string[] = [];
  const narrowest = (from: number, to: number) => {
    let d = Infinity;
    for (let z = from; z >= to; z -= 0.25) {
      const lo = profileRangeAt(bore, z).lo;
      if (!Number.isNaN(lo)) d = Math.min(d, 2 * lo);
    }
    return d;
  };
  for (const tool of tools.filter(isInside)) {
    const own = segments.filter((s) => s.tool === tool.id && s.kind !== 'dwell');
    if (!own.length) continue;
    const deepest = Math.min(...own.map((s) => Math.min(s.from.z, s.to.z)));
    if (-deepest > toolReach(tool) + 1e-6)
      problems.push(`T${tool.id} (${tool.name}) goes to Z${mm(deepest)}, but it only reaches ${mm(toolReach(tool))} mm into the part; make the bore shallower or give the tool a longer reach`);
    if (tool.type === 'drill' || bore.length < 2) continue;
    const hole = narrowest(0, Math.max(deepest, bore[bore.length - 1][0]));
    if (hole < tool.minBore - 1e-6)
      problems.push(`T${tool.id} (${tool.name}) needs a hole of at least Ø${mm(tool.minBore)}, and the bore is Ø${mm(hole)} where it goes in; make the bore larger there or use a smaller tool`);
    if (tool.type === 'internal-grooving') {
      // The tool reaches `depth` past the hole it comes in through: the narrowest one in front of the groove.
      for (const s of own.filter((s) => s.kind === 'feed')) {
        const z = Math.min(s.from.z, s.to.z), r = Math.max(s.from.x, s.to.x) / 2;
        const entry = narrowest(0, z + tool.width) / 2;
        if (r - entry > tool.depth + 0.05) {
          problems.push(
            `T${tool.id} (${tool.name}) cuts a groove ${mm(r - entry)} mm deep per side at Z${mm(z)}, past the Ø${mm(2 * entry)} bore it goes in through, and reaches only ${mm(tool.depth)} mm; ` +
              'make the groove shallower or the bore in front of it larger',
          );
          break;
        }
      }
    }
  }
  return problems;
}

/** Face grooving tools: the smallest inner wall their blade fits. */
function faceToolProblems({ tools }: Job, segments: Segment[]): string[] {
  const problems: string[] = [];
  for (const tool of tools) {
    if (tool.type !== 'face-grooving') continue;
    const cuts = segments.filter((s) => s.tool === tool.id && s.kind === 'feed');
    if (!cuts.length) continue;
    const smallest = Math.min(...cuts.map((s) => Math.min(s.from.x, s.to.x)));
    if (smallest < tool.minDiameter - 1e-6)
      problems.push(`T${tool.id} (${tool.name}) cuts at Ø${mm(smallest)}, but its blade only fits inner walls of Ø${mm(tool.minDiameter)} or more; make the groove's inner wall larger or use a blade for smaller diameters`);
  }
  return problems;
}

/** What the generated program leaves in a face groove. */
function faceGrooveHint({ tools }: Job): string {
  const blade = tools.find((tool) => tool.type === 'face-grooving');
  if (!blade) return 'add a face grooving tool to cut it';
  return `the ${mm(blade.width)} mm blade can't reach into that corner; give the groove's bottom a flat or a round at least ${mm(blade.width)} mm wide instead of a sharp V`;
}

/** What the generated program leaves inside the bore, and which tool cuts it. */
function boreHint({ tools }: Job): string {
  const borer = tools.find((tool) => tool.type === 'boring');
  const groover = tools.find((tool) => tool.type === 'internal-grooving');
  if (!borer && !groover) return 'the drill only makes a straight hole of its own diameter; add a boring bar (and an internal grooving tool for grooves)';
  if (!groover)
    return `the boring bar (T${borer!.id}) can't reach that wall: a wall where the bore grows toward the chuck (the front of an internal groove) needs an internal grooving tool, or a slope under ${mm(endEdgeAngle(borer as Extract<Tool, { type: 'boring' }>))}°`;
  return `no inside tool reaches into that corner; give a groove at least the grooving tool's width (${mm((groover as Extract<Tool, { type: 'internal-grooving' }>).width)} mm), or a square bottom instead of a V`;
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
