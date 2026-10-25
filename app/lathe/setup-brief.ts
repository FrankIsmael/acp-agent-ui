/**
 * The machine as it is before the agent starts: the loaded bar, the jaws, home and the turret, with
 * the numbers already worked out so the agent plans from them instead of guessing.
 */
import { MACHINE } from './sim/gcode/plan.ts';
import type { Setup } from './sim/job-schema.ts';
import { endEdgeAngle, toolReach } from './sim/tool-shapes.ts';

const JAW_CLEARANCE_MM = 5;
const n = (value: number) => String(Number(value.toFixed(2)));

export function setupBrief({ material, stock, tools }: Setup): string {
  const jawZ = stock.faceStock - stock.stickout;
  const lastZ = jawZ + JAW_CLEARANCE_MM;
  const parting = tools.find((tool) => tool.type === 'parting');
  const longest = stock.stickout - stock.faceStock - JAW_CLEARANCE_MM - (parting?.type === 'parting' ? parting.width : 0);
  const clearX = stock.diameter + 4;
  const clearZ = stock.faceStock + 2;
  const facer = tools.find((tool) => tool.type === 'turning');
  const toolLines = tools.map((tool) => {
    const code = `T${String(tool.id).padStart(2, '0')}${String(tool.id).padStart(2, '0')}`;
    const head = `  - T${tool.id} "${tool.name}" (${code}):`;
    if (tool.type === 'parting') return `${head} parting blade ${n(tool.width)} mm wide; the programmed point is its chuck-side corner.`;
    if (tool.type === 'drill') return `${head} drill Ø${n(tool.diameter)}, ${n(tool.pointAngle)}° point, ${n(toolReach(tool))} mm deep at most.`;
    if (tool.type === 'internal-grooving')
      return `${head} internal grooving tool ${n(tool.width)} mm wide, for bores of Ø${n(tool.minBore)} or more, grooves up to ${n(tool.depth)} mm deep per side and ${n(toolReach(tool))} mm into the part.`;
    if (tool.type === 'boring')
      return `${head} boring bar${tool.insert ? `, ${tool.insert}` : ''}, nose radius ${n(tool.noseRadius)}, for bores of Ø${n(tool.minBore)} or more, ${n(toolReach(tool))} mm deep at most; inside it can go out along walls where the bore grows toward the chuck only if they are shallower than ${n(endEdgeAngle(tool))}°.`;
    return `${head} turning${tool.insert ? `, ${tool.insert}` : ''}, nose radius ${n(tool.noseRadius)}, ${n(tool.angle)}° insert, ${n(tool.approach)}° approach; it can go down walls facing the chuck only if they are shallower than ${n(endEdgeAngle(tool))}°.`;
  });

  return [
    '## The lathe right now',
    'This is what is on the machine. Keep these tools unless the part needs another one. Keep this bar when the part fits it and its largest diameter is at most 6 mm under the bar; otherwise pick a standard bar 2–5 mm over the part. Say so in the reply if you change either.',
    `- Bar: ${material.name} (${n(material.density)} g/cm³), Ø${n(stock.diameter)} × ${n(stock.length)} mm, ${n(stock.stickout)} mm out of the jaws.`,
    `- Raw front face at Z${n(stock.faceStock)}; finished front face at Z0. The jaws hold the bar from Z${n(jawZ)}: keep every move at Z${n(lastZ)} or in front of it.`,
    `- Longest part with this bar as it sits${parting ? ', parting off included' : ''}: ${n(Math.max(0, longest))} mm. A longer part needs more stickout (this bar pulled out further, or a new bar), not a smaller part.`,
    `- Home, where the program starts and \`G28 U0 W0\` returns: X${n(stock.diameter + 50)} Z${n(stock.faceStock + 50)}.`,
    '- Tools in the turret:',
    ...toolLines,
    `- Machine: up to ${MACHINE.maxRpm} rpm (\`G50 S\` lowers it), rapids at ${MACHINE.rapid} mm/min, ${MACHINE.toolChangeS} s per tool change.`,
    `- Bars it takes: up to Ø${MACHINE.maxBarDiameter} (the chuck) and ${MACHINE.maxStickout} mm out of the jaws (the carriage), with at least ${MACHINE.minGrip} mm in the jaws. ` +
      `Up to Ø${MACHINE.spindleBore} the bar goes through the spindle and can be up to ${MACHINE.maxBarLength} mm long; a thicker one only fits ${MACHINE.chuckDepth} mm into the chuck (length at most stickout + ${MACHINE.chuckDepth}).`,
    `- Clear of this bar: X${n(clearX)} or more, Z${n(clearZ)} or more.` +
      (facer?.type === 'turning'
        ? ` A safe face with T${facer.id}: \`G0 X${n(clearX)} Z${n(clearZ)}\`, \`G0 Z0\`, \`G1 X${n(-2 * facer.noseRadius)}\` (−2 × nose radius cleans the center), then leave with \`G0 Z${n(clearZ)}\` before any X move.`
        : ''),
  ].join('\n');
}
