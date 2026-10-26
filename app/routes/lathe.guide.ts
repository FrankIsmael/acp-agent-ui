/**
 * GET /lathe/guide.md — the lathe-job instructions as plain Markdown, for people without the lathe
 * agent to paste into any AI. The source is docs/lathe/lathe-job-guide.md.
 */
import guide from '../../docs/lathe/lathe-job-guide.md?raw';

export function loader() {
  return new Response(guide, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
