// Citi Homes IMS logo (approved option B): black circle, CH monogram, "CITI HOMES", IMS badge.
// One geometry, three renderers: inline SVG (UI), canvas PNG (PDFs), and the static files in /img.

// CH monogram in a 680 x 340 box: thin open C, H crossbar running from inside the C through both stems
export const CH = {
  c: 'M 312.9 87.5 A 165 165 0 1 0 312.9 252.5',          // stroked, width 13
  bar: [305, 164, 365, 12],                                   // x, y, w, h
  stems: ['M 434 5 L 456 5 L 453 170 L 456 335 L 434 335 L 437 170 Z',
          'M 624 5 L 646 5 L 643 170 L 646 335 L 624 335 L 627 170 Z'],
};
const BLACK = '#111111', BROWN = '#8a5a2b';
const SERIF = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";
const SERIF_BOLD = "'Playfair Display', Georgia, 'Times New Roman', serif";

function monogramSvg(x, y, w, color = '#ffffff') {
  const h = w / 2;
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 680 340">
    <path d="${CH.c}" fill="none" stroke="${color}" stroke-width="13"/>
    <rect x="${CH.bar[0]}" y="${CH.bar[1]}" width="${CH.bar[2]}" height="${CH.bar[3]}" fill="${color}"/>
    ${CH.stems.map(d => `<path d="${d}" fill="${color}"/>`).join('')}</svg>`;
}

// variant 'full' = option B; 'mark' = circle + CH only (tiny sizes, favicon)
export function logoSvg(size = 64, variant = 'full') {
  if (variant === 'mark') {
    return `<svg viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="Citi Homes IMS">
      <circle cx="100" cy="100" r="96" fill="${BLACK}"/>${monogramSvg(26, 63, 148)}</svg>`;
  }
  return `<svg viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="Citi Homes IMS">
    <circle cx="100" cy="94" r="88" fill="${BLACK}"/>
    ${monogramSvg(44, 46, 112)}
    <text x="100" y="126" text-anchor="middle" font-family="${SERIF}" font-size="15" font-weight="600" letter-spacing="2.5" fill="#ffffff">CITI HOMES</text>
    <rect x="66" y="164" width="68" height="26" rx="13" fill="${BROWN}" stroke="#ffffff" stroke-width="2"/>
    <text x="100" y="182" text-anchor="middle" font-family="${SERIF_BOLD}" font-size="14" font-weight="600" letter-spacing="3" fill="#ffffff">IMS</text>
  </svg>`;
}

export const Logo = {
  props: { size: { type: Number, default: 64 }, variant: { type: String, default: 'full' } },
  computed: { html() { return logoSvg(this.size, this.variant); } },
  template: `<span style="display:inline-flex;line-height:0" v-html="html"></span>`,
};

// ---------- PNG for PDFs (canvas, so web fonts are used) ----------
let pngCache = null;
export async function logoPng(px = 400) {
  if (pngCache) return pngCache;
  try { await Promise.all([document.fonts.load(`600 15px 'Cormorant Garamond'`), document.fonts.load(`600 14px 'Playfair Display'`)]); } catch { /* fall back to Georgia */ }
  const cv = document.createElement('canvas');
  cv.width = px; cv.height = px;
  const g = cv.getContext('2d');
  const k = px / 200;
  g.scale(k, k);
  g.fillStyle = BLACK; g.beginPath(); g.arc(100, 94, 88, 0, Math.PI * 2); g.fill();
  // monogram
  g.save(); g.translate(44, 46); g.scale(112 / 680, 112 / 680);
  g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff'; g.lineWidth = 13;
  g.stroke(new Path2D(CH.c));
  g.fillRect(...CH.bar);
  CH.stems.forEach(d => g.fill(new Path2D(d)));
  g.restore();
  // wording
  g.textAlign = 'center'; g.fillStyle = '#ffffff';
  g.font = `600 15px ${SERIF}`; if ('letterSpacing' in g) g.letterSpacing = '2.5px';
  g.fillText('CITI HOMES', 101.25, 126);
  // IMS badge
  g.beginPath(); g.roundRect(66, 164, 68, 26, 13); g.fillStyle = BROWN; g.fill();
  g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
  g.fillStyle = '#ffffff'; g.font = `600 14px ${SERIF_BOLD}`; if ('letterSpacing' in g) g.letterSpacing = '3px';
  g.fillText('IMS', 101.5, 182);
  pngCache = cv.toDataURL('image/png');
  return pngCache;
}
