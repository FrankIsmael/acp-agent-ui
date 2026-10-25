/** Splits a lathe program into blocks of address words (`G1 X30. Z-12 F0.2` → G1, X30, Z-12, F0.2). */

export type Word = { letter: string; value: number };
export type Block = { line: number; words: Word[]; text: string };
export type ParseIssue = { line: number; message: string };

const WORD = /([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

export function parseGcode(source: string): { blocks: Block[]; issues: ParseIssue[] } {
  const blocks: Block[] = [];
  const issues: ParseIssue[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    // Comments: (…) anywhere and ; to the end of the line. `%` marks the start and end of a tape.
    const text = raw.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').trim().toUpperCase();
    if (!text || text === '%' || text.startsWith('/')) return;
    const words: Word[] = [];
    let rest = text;
    for (const match of text.matchAll(WORD)) {
      rest = rest.replace(match[0], '');
      words.push({ letter: match[1], value: Number(match[2]) });
    }
    if (rest.replace(/\s+/g, '') !== '') issues.push({ line, message: `Could not read "${rest.trim()}"` });
    // Program numbers (O1001) and sequence numbers (N10) carry no motion.
    const motion = words.filter((word) => word.letter !== 'N' && word.letter !== 'O');
    if (motion.length) blocks.push({ line, words: motion, text: raw.trim() });
  });
  return { blocks, issues };
}
