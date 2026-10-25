/**
 * Lathe job format, v1 (docs/lathe/plan.md, section 5). The agent writes it, the user can paste it,
 * and the examples use it. Units are millimeters, X is a diameter, Z0 is the finished front face
 * and negative Z goes toward the chuck.
 */
import { z } from 'zod';
import { GenerateError, generateGcode } from './gcode/generate.ts';
import { arcProblems } from './profile.ts';

// [z, diameter], or [z, diameter, R] when the segment ending there is an arc (sim/profile.ts).
const point = z.union([z.tuple([z.number(), z.number().nonnegative()]), z.tuple([z.number(), z.number().nonnegative(), z.number()])]);

const turning = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.literal('turning'),
  insert: z.string().optional(),
  noseRadius: z.number().nonnegative().default(0.4),
  angle: z.number().min(20).max(90).default(80), // insert included angle, degrees
  approach: z.number().min(45).max(110).default(95), // ISO lead angle (kr), degrees
});

const parting = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.literal('parting'),
  width: z.number().positive().default(3), // the programmed point is the chuck-side corner
});

// Tools for the inside of the part. `reach` is how deep from the front face they go (the drill's
// flutes, the bar's overhang); left out it comes from their size (sim/tool-shapes.ts, toolReach).
const drill = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.literal('drill'),
  diameter: z.number().positive(),
  pointAngle: z.number().min(60).max(180).default(118), // included angle of the point, degrees
  reach: z.number().positive().optional(),
});

const boring = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.literal('boring'),
  insert: z.string().optional(),
  noseRadius: z.number().nonnegative().default(0.4),
  angle: z.number().min(20).max(90).default(55),
  approach: z.number().min(45).max(110).default(93),
  minBore: z.number().positive().default(16), // smallest hole the bar fits in
  reach: z.number().positive().optional(),
});

const internalGrooving = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.literal('internal-grooving'),
  width: z.number().positive().default(2), // the programmed point is the chuck-side corner
  depth: z.number().positive().default(3), // deepest groove per side, from the bore it goes in through
  minBore: z.number().positive().default(20),
  reach: z.number().positive().optional(),
});

export const toolSchema = z.discriminatedUnion('type', [turning, parting, drill, boring, internalGrooving]);

const materialSchema = z.object({ name: z.string(), density: z.number().positive() }); // g/cm³

const stockSchema = z.object({
  diameter: z.number().positive(),
  length: z.number().positive(),
  stickout: z.number().positive(), // length out of the chuck jaws
  faceStock: z.number().nonnegative().default(1), // raw front face sits at Z+faceStock
});

/** What is on the machine before a job: the bar and the turret. The page sends it to the agent. */
export const setupSchema = z
  .object({ material: materialSchema, stock: stockSchema, tools: z.array(toolSchema).min(1).max(12) })
  .refine((setup) => setup.stock.stickout <= setup.stock.length);
// The machine's limits on the bar (MACHINE) are checked in sim/check.ts, worded for the agent.
export type Setup = z.output<typeof setupSchema>;

// Settings for the generated program; anything left out comes from the material (gcode/generate.ts).
const camSchema = z.object({
  depthOfCut: z.number().positive().max(10).optional(), // mm per side, roughing
  finishAllowance: z.number().nonnegative().max(2).optional(), // mm per side
  roughSpeed: z.number().positive().optional(), // m/min
  finishSpeed: z.number().positive().optional(),
  partSpeed: z.number().positive().optional(),
  roughFeed: z.number().positive().optional(), // mm/rev
  finishFeed: z.number().positive().optional(),
  partFeed: z.number().positive().optional(),
  maxRpm: z.number().positive().optional(),
  roughTool: z.number().int().optional(),
  finishTool: z.number().int().optional(),
  partTool: z.number().int().optional(),
  drillSpeed: z.number().positive().optional(), // m/min
  drillFeed: z.number().positive().optional(), // mm/rev
  boreSpeed: z.number().positive().optional(),
  boreFeed: z.number().positive().optional(),
  drillTool: z.number().int().optional(),
  boreTool: z.number().int().optional(),
  grooveTool: z.number().int().optional(),
});

export const jobSchema = z
  .object({
    version: z.literal(1),
    name: z.string(),
    units: z.literal('mm').default('mm'),
    material: materialSchema,
    stock: stockSchema,
    profile: z.array(point).default([]), // finished part: [z, diameter]
    bore: z.array(point).default([]), // the hole in it, the same way from the front face; none when empty
    tools: z.array(toolSchema).min(1),
    operations: z
      .array(
        z.object({
          name: z.string(),
          tool: z.number().int(),
          lines: z.tuple([z.number().int(), z.number().int()]),
          depthOfCut: z.number().optional(),
        }),
      )
      .default([]),
    gcode: z.string().min(1).optional(), // left out: generated from the profile
    cam: camSchema.optional(),
    assumptions: z.array(z.string()).default([]),
  })
  .superRefine((job, ctx) => {
    if (job.stock.stickout > job.stock.length)
      ctx.addIssue({ code: 'custom', path: ['stock', 'stickout'], message: `stickout (${job.stock.stickout}) is longer than the bar (length ${job.stock.length}); make length at least stickout + 30 mm to grip` });
    const ids = new Set(job.tools.map((tool) => tool.id));
    job.operations.forEach((op, i) => {
      if (!ids.has(op.tool))
        ctx.addIssue({ code: 'custom', path: ['operations', i, 'tool'], message: `tool ${op.tool} is not in tools` });
    });
  });

export type Job = Omit<z.output<typeof jobSchema>, 'gcode'> & {
  gcode: string;
  generated?: boolean; // the G-code was written from the profile, not by the author
};
export type Tool = z.output<typeof toolSchema>;

/** Parses unknown JSON into a job, or returns readable errors (`path: message`). */
export function parseJob(input: unknown): { ok: true; job: Job } | { ok: false; errors: string[] } {
  const result = jobSchema.safeParse(input);
  if (result.success) {
    const { gcode, ...data } = result.data;
    let job: Job;
    if (gcode) job = { ...data, gcode };
    else {
      const problems = [...arcProblems(data.profile), ...arcProblems(data.bore, 'bore')];
      if (problems.length) return { ok: false, errors: problems };
      try {
        job = { ...data, gcode: generateGcode(data), generated: true };
      } catch (error) {
        if (error instanceof GenerateError) return { ok: false, errors: [error.message] };
        throw error;
      }
    }
    if (!job.operations.length) job.operations = operationsFromGcode(job.gcode, job.tools);
    return { ok: true, job };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join('.') || '(job)'}: ${issue.message}`),
  };
}

const CUT = /\bG0?[123](?!\d)/; // G1, G2, G3, G01…: a move that can cut

/**
 * The operations of a job that lists none, read from the program: a line that is only a comment,
 * `(Rough OD)`, starts one; so does a tool change after the current operation has cut, named after
 * the tool. A tool change before the first cut belongs to the operation it is in.
 */
export function operationsFromGcode(gcode: string, tools: Tool[]): Job['operations'] {
  const ops: Job['operations'] = [];
  let current: Job['operations'][number] | undefined;
  let cut = false;
  let tool = 0;
  const start = (name: string, line: number) => {
    current = { name, tool, lines: [line, line] };
    ops.push(current);
    cut = false;
  };
  gcode.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const label = /^\(([^)]*)\)$/.exec(raw.trim())?.[1].trim();
    if (label) return start(label, line);
    const code = raw.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').trim().toUpperCase();
    if (!code || code === '%') return;
    const t = /T\s*(\d+)/.exec(code);
    if (t) {
      const value = Number(t[1]);
      tool = value >= 100 ? Math.floor(value / 100) : value;
      if (!current || (cut && current.tool !== tool)) start(tools.find((x) => x.id === tool)?.name ?? `T${tool}`, line);
      else current.tool = tool;
    }
    if (CUT.test(code)) cut = true;
    if (current) current.lines[1] = line;
  });
  return ops.filter((op) => op.tool !== 0);
}
