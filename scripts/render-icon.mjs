// Generates the Preflight logo set in media/ from one seal definition.
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const NAVY = '#13233A';
const ORANGE = '#F58025';
const SLATE = '#5B6F8A';

function ticks() {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const major = i % 6 === 0;
    out.push(
      `<line x1="90" y1="${major ? 28 : 30}" x2="90" y2="36" stroke-width="${major ? 2.6 : 2}" ` +
        `opacity="${major ? 0.9 : 0.5}" transform="rotate(${i * 15} 90 90)"/>`,
    );
  }
  return out.join('');
}

// The seal, drawn on a 180x180 canvas.
const seal = `
  <rect width="180" height="180" rx="40" fill="${NAVY}"/>
  <circle cx="90" cy="90" r="66" fill="none" stroke="${ORANGE}" stroke-width="3.5"/>
  <circle cx="90" cy="90" r="49" fill="none" stroke="#FFFFFF" stroke-width="1" opacity="0.18"/>
  <g stroke="#FFFFFF" stroke-linecap="round">${ticks()}</g>
  <polyline points="62,88 82,108 120,66" fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="74" cy="132" r="4" fill="${SLATE}"/>
  <circle cx="90" cy="132" r="4" fill="${SLATE}"/>
  <circle cx="106" cy="132" r="4" fill="${ORANGE}"/>`;

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180">
  <title>Preflight</title>${seal}
</svg>
`;

// Activity bar glyph: VS Code renders it as a single-colour mask, so keep it to ring + check.
const activity = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9.5" stroke-width="1.5"/>
  <circle cx="12" cy="12" r="6.6" stroke-width="0.9" stroke-dasharray="1 1.6" opacity="0.8"/>
  <polyline points="8.4,12.2 11,14.8 15.8,9.6" stroke-width="2"/>
</svg>
`;

const FONT = "'Segoe UI', -apple-system, 'Helvetica Neue', Arial, sans-serif";
const wordmark = (text, sub) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 140" width="400" height="140">
  <title>Preflight — Check. Fix. Ship.</title>
  <g transform="translate(10,10) scale(0.6667)">${seal}</g>
  <text x="152" y="78" font-family="${FONT}" font-size="56" font-weight="600" letter-spacing="-1" fill="${text}">Preflight</text>
  <text x="155" y="110" font-family="${FONT}" font-size="20" font-weight="400" letter-spacing="0.5" fill="${sub}">Check. Fix. Ship.</text>
</svg>
`;

const files = {
  'media/logo.svg': logo,
  'media/activity.svg': activity,
  'media/wordmark-light.svg': wordmark(NAVY, SLATE),
  'media/wordmark-dark.svg': wordmark('#FFFFFF', '#AEBBCC'),
};
for (const [path, svg] of Object.entries(files)) writeFileSync(path, svg);

const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
writeFileSync('media/icon.png', png(logo, 128));
writeFileSync('media/icon@256.png', png(logo, 256));
writeFileSync('media/wordmark-light.png', png(files['media/wordmark-light.svg'], 800));
writeFileSync('media/wordmark-dark.png', png(files['media/wordmark-dark.svg'], 800));
console.log('icons written');
