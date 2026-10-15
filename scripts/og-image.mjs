/**
 * Renders the link-preview card (Open Graph / Twitter / WhatsApp) to public/og.png.
 *
 *   node scripts/og-image.mjs
 *
 * 1200×630 is the size every network crops to. The robot is public/favicon.png redrawn as
 * vectors (same coordinates, 1162×1062 box) so it stays crisp at any scale.
 */
import sharp from 'sharp';

const W = 1200;
const H = 630;
// The `robbie` theme (app/theme/theme-tokens.ts): gunmetal, safety orange, cream eye glow.
const BG = '#111214';
const ORANGE = '#ff6b1a';
const GLOW = '#ffe9c7';
const STEEL = '#8fa3b8';
const TEXT = '#f3eee7';
const MUTED = '#9a948c';
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

const head =
  'M258 225H908V285H984V350H1054V915H984V985H908V1052H258V985H183V915H112V350H183V285H258Z' +
  'M260 345V415H200V852H260V922H906V852H966V415H906V345Z';
const face = 'M260 345H906V415H966V852H906V922H260V852H200V415H260Z';
const rect = (x1, y1, x2, y2) => `M${x1} ${y1}H${x2}V${y2}H${x1}Z`;
const antenna = rect(490, 0, 677, 127) + rect(538, 127, 628, 225);
const ears = rect(0, 481, 90, 777) + rect(1077, 481, 1162, 777);
const eyes = rect(333, 506, 463, 661) + rect(704, 506, 834, 661);
const mouth =
  rect(437, 722, 502, 787) +
  rect(664, 722, 729, 787) +
  rect(502, 787, 663, 853);

// Faint pixel grid, a nod to the robot's 8-bit look.
const grid = [];
for (let x = 0; x <= W; x += 30) grid.push(`M${x} 0V${H}`);
for (let y = 0; y <= H; y += 30) grid.push(`M0 ${y}H${W}`);

const chips = ['Runs tools', 'Writes code', 'Builds apps'];
let chipX = 560;
const chipSvg = chips
  .map((label) => {
    const w = label.length * 11.2 + 40;
    const svg = `
      <rect x="${chipX}" y="418" width="${w}" height="44" rx="22" fill="#1b1c1f" stroke="#34353a"/>
      <text x="${chipX + w / 2}" y="447" text-anchor="middle" font-size="19" fill="${TEXT}" font-weight="500">${label}</text>`;
    chipX += w + 12;
    return svg;
  })
  .join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <defs>
    <radialGradient id="glowP" cx="0.22" cy="0.45" r="0.55">
      <stop offset="0" stop-color="${ORANGE}" stop-opacity="0.32"/>
      <stop offset="1" stop-color="${ORANGE}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowM" cx="0.95" cy="1.05" r="0.6">
      <stop offset="0" stop-color="${STEEL}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${STEEL}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffa45c"/>
      <stop offset="0.55" stop-color="${ORANGE}"/>
      <stop offset="1" stop-color="#d9480b"/>
    </linearGradient>
    <linearGradient id="word" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="${GLOW}"/>
    </linearGradient>
    <radialGradient id="gridFade" cx="0.3" cy="0.5" r="0.75">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#gridFade)"/></mask>
    <filter id="eyeGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="18" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <path d="${grid.join('')}" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1" mask="url(#gridMask)"/>
  <rect width="${W}" height="${H}" fill="url(#glowP)"/>
  <rect width="${W}" height="${H}" fill="url(#glowM)"/>

  <!-- Robbie -->
  <g transform="translate(96 150) scale(0.31)">
    <path d="${face}" fill="#0a0a0b"/>
    <path d="${antenna}${ears}${head}" fill="url(#metal)" fill-rule="evenodd"/>
    <path d="${eyes}" fill="${GLOW}" filter="url(#eyeGlow)"/>
    <path d="${mouth}" fill="#ffb347" filter="url(#eyeGlow)"/>
  </g>

  <!-- Copy -->
  <g>
    <rect x="560" y="150" width="148" height="34" rx="17" fill="${ORANGE}" fill-opacity="0.12" stroke="${ORANGE}" stroke-opacity="0.5"/>
    <circle cx="582" cy="167" r="5" fill="${ORANGE}"/>
    <text x="596" y="173" font-size="16" font-weight="700" letter-spacing="2.5" fill="#ffc9a3">AI AGENT</text>

    <text x="554" y="300" font-size="132" font-weight="800" letter-spacing="-4" fill="url(#word)">Robbie</text>
    <text x="560" y="368" font-size="34" font-weight="500" fill="${TEXT}">Your AI agent, on its own machine.</text>
    ${chipSvg}
  </g>

  <!-- Footer -->
  <rect x="0" y="${H - 6}" width="${W}" height="6" fill="url(#metal)"/>
  <text x="96" y="${H - 52}" font-size="20" fill="${MUTED}">Built by <tspan fill="${TEXT}" font-weight="600">Ismael Francisco</tspan></text>
  <text x="${W - 96}" y="${H - 52}" text-anchor="end" font-size="20" fill="${MUTED}">ismaelfrancisco.tech</text>
</svg>`;

await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9, palette: false })
  .toFile(new URL('../public/og.png', import.meta.url).pathname);

// Square icon for iOS home screens and apps that show a small preview.
await sharp(Buffer.from(svg))
  .extract({ left: 66, top: 120, width: 420, height: 420 })
  .resize(180, 180)
  .png()
  .toFile(new URL('../public/apple-touch-icon.png', import.meta.url).pathname);

console.log('public/og.png and public/apple-touch-icon.png written');
