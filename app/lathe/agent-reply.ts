/** Pulls the ```lathe-job block out of the agent's reply and checks it. */
import { parseJob, type Job } from './sim/job-schema.ts';
import { profilePolyline } from './sim/profile.ts';

const BLOCK = /```lathe-job[^\n]*\n([\s\S]*?)```/g;

export type ReplyResult = { ok: true; job: Job } | { ok: false; errors: string[] };

export function jobFromReply(text: string): ReplyResult {
  const blocks = [...text.matchAll(BLOCK)].map((match) => match[1]);
  if (blocks.length === 0) return { ok: false, errors: ['The reply has no ```lathe-job block'] };
  if (blocks.length > 1) return { ok: false, errors: ['The reply has more than one ```lathe-job block; send exactly one'] };
  let data: unknown;
  try {
    data = JSON.parse(blocks[0]);
  } catch (error) {
    return { ok: false, errors: [`The lathe-job block is not valid JSON: ${(error as Error).message}`] };
  }
  return fitBar(parseJob(data), data as Record<string, any>);
}

const STANDARD_BARS = [10, 12, 16, 20, 25, 30, 32, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100];
const MAX_OVERSIZE_MM = 6;

/**
 * The agent sometimes keeps a bar far bigger than the part (a Ø12 pin from Ø60), which only adds
 * roughing. For a generated job, switch to the smallest standard bar at least 2 mm over the part.
 * Hand-written G-code is planned for its bar, so it is left alone.
 */
function fitBar(result: ReplyResult, data: Record<string, any>): ReplyResult {
  if (!result.ok || !result.job.generated) return result;
  const { stock, profile } = result.job;
  const part = Math.max(...profilePolyline(profile).map(([, d]) => d));
  const bar = STANDARD_BARS.find((d) => d >= part + 2);
  if (!bar || stock.diameter - part <= MAX_OVERSIZE_MM || bar >= stock.diameter) return result;
  const assumption = `Bar changed from Ø${stock.diameter} to Ø${bar}: the part is only Ø${Number(part.toFixed(2))}`;
  const fitted = parseJob({ ...data, stock: { ...data.stock, diameter: bar }, assumptions: [...(data.assumptions ?? []), assumption] });
  return fitted.ok ? fitted : result;
}

/** The text before and after the block, for the panel. */
export function replyProse(text: string): string {
  return text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}
