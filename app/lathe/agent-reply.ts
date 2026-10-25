/** Pulls the ```lathe-job block out of the agent's reply and checks it. */
import { parseJob, type Job } from './sim/job-schema.ts';

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
  return parseJob(data);
}

/** The text before and after the block, for the panel. */
export function replyProse(text: string): string {
  return text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}
