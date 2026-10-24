// PDF generation (jsPDF + autotable) for issue slips, POs, GRNs, vouchers, gate passes — every PDF opens in a panel that
// slides in from the right (pages drawn with PDF.js so it also works on phones) with Download, Print and Open in new tab.
import { reactive } from 'vue';
import { sb, state, money, toast, ROLES } from './lib.js';

// ---------- slide-in PDF viewer ----------
export const pdfView = reactive({ open: false, url: null, name: '', title: '', pages: 0, rendering: false });
let pdfBlob = null;
export function showPdf(doc, filename, title) {
  if (pdfView.url) URL.revokeObjectURL(pdfView.url);
  pdfBlob = doc.output('blob');
  Object.assign(pdfView, { open: true, url: URL.createObjectURL(pdfBlob), name: filename, title: title || filename.replace(/\.pdf$/i, ''), pages: 0 });
}
let pdfjs = null;
function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = () => { pdfjs = null; rej(new Error('Could not load the PDF viewer')); };
    document.head.appendChild(s);
  });
  return pdfjs;
}
export const PdfPanel = {
  data: () => ({ v: pdfView, err: '' }),
  watch: { 'v.url'(u) { if (u) this.$nextTick(() => this.render()); else if (this.$refs.pages) { this.$refs.pages.innerHTML = ''; this.err = ''; } } },
  mounted() { this.esc = e => { if (e.key === 'Escape' && this.v.open) this.close(); }; window.addEventListener('keydown', this.esc); },
  unmounted() { window.removeEventListener('keydown', this.esc); },
  methods: {
    // draw every page as a canvas at the panel's width (sharp on high-density screens)
    async render() {
      const box = this.$refs.pages; if (!box) return;
      box.innerHTML = ''; this.err = ''; this.v.rendering = true;
      try {
        const lib = await loadPdfJs();
        const pdf = await lib.getDocument({ data: await pdfBlob.arrayBuffer() }).promise;
        this.v.pages = pdf.numPages;
        const width = Math.max(box.clientWidth - 24, 280), ratio = window.devicePixelRatio || 1;
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const scale = width / page.getViewport({ scale: 1 }).width;
          const vp = page.getViewport({ scale: scale * ratio });
          const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
          c.style.width = width + 'px'; c.className = 'pdf-page';
          box.appendChild(c);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        }
      } catch (e) { this.err = (e && e.message) || 'Preview not available — use Download or Open'; }
      this.v.rendering = false;
    },
    download() { const a = document.createElement('a'); a.href = this.v.url; a.download = this.v.name; a.click(); },
    open() { if (!window.open(this.v.url, '_blank')) toast('Allow pop-ups to open the PDF in a new tab', 'info'); },
    print() {
      // print through a hidden frame; phones that cannot print a frame get the PDF in a new tab instead
      const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      f.src = this.v.url; document.body.appendChild(f);
      f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { this.open(); } setTimeout(() => f.remove(), 60000); };
    },
    close() { this.v.open = false; },
  },
  template: `<div class="pdf-shade" :class="{on: v.open}" @click.self="close">
    <aside class="pdf-panel" :class="{on: v.open}" role="dialog" aria-label="Document preview">
      <div class="pdf-head">
        <div style="flex:1;min-width:0"><b class="pdf-title">{{ v.title }}</b><div class="small muted">{{ v.rendering ? 'Preparing preview…' : v.pages ? v.pages + (v.pages === 1 ? ' page' : ' pages') : '' }}</div></div>
        <button class="btn sm primary" @click="download" title="Download PDF">⬇ Download</button>
        <button class="btn sm" @click="print" title="Print">🖨 Print</button>
        <button class="btn sm hide-sm" @click="open" title="Open in a new tab">↗</button>
        <button class="btn sm" @click="close" aria-label="Close">✕</button>
      </div>
      <div class="pdf-body"><div v-if="err" class="card empty">{{ err }}</div><div ref="pages"></div></div>
    </aside>
  </div>`,
};

// ======================================================================
// House document style (Citi Homes PO system): A4, Carlito (Calibri metrics), logo top-left, address footer bottom-left,
// "No. | Page n" bottom-right; centred title, number + date, party block, underlined subject, navy table with zebra rows and a
// grey totals band, amount in words, numbered payment terms then terms & conditions, three signatures with each user's
// stored signature image, and the counter-party's acceptance block.
// ======================================================================
const NAVY = [31, 56, 100], GRID = [142, 169, 219], ZEBRA = [242, 242, 242], TOTAL_FILL = [217, 217, 217], GREY = [127, 127, 127];
const PT = 0.3528;                       // points → mm
const LM = 19, RM = 19, TOP = 35, BOTTOM = 30;
const asset = {};                        // cached fonts (base64) and images (data URL)
async function fetchB64(url) {
  const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
async function loadAssets() {
  if (asset.ready) return asset.ready;
  asset.ready = (async () => {
    const fonts = [['Carlito-Regular.ttf', 'normal'], ['Carlito-Bold.ttf', 'bold'], ['Carlito-Italic.ttf', 'italic'], ['Carlito-BoldItalic.ttf', 'bolditalic']];
    try { asset.fonts = await Promise.all(fonts.map(async ([f, s]) => ({ f, s, b64: await fetchB64('fonts/' + f) }))); } catch (e) { console.warn('fonts', e); asset.fonts = null; }
    for (const [k, f] of [['logo', 'img/doc-logo.png'], ['footer', 'img/doc-footer.png']]) {
      try { asset[k] = 'data:image/png;base64,' + await fetchB64(f); } catch (e) { console.warn(f, e); }
    }
  })();
  return asset.ready;
}
const FONT = () => asset.fonts ? 'Carlito' : 'helvetica';

// "2 October 2026"
export function longDate(d) {
  if (!d) return '';
  const x = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  return isNaN(x) ? String(d) : `${x.getDate()} ${x.toLocaleString('en-GB', { month: 'long' })} ${x.getFullYear()}`;
}
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below1000 = n => [n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' : '', (n % 100) >= 20 ? TENS[Math.floor((n % 100) / 10)] + (n % 10 ? '-' + ONES[n % 10] : '') : ONES[n % 100]].filter(Boolean).join(' ');
function intWords(n) {
  if (!n) return 'Zero';
  const out = [];
  for (const [d, w] of [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]) if (n >= d) { out.push(below1000(Math.floor(n / d)) + ' ' + w); n %= d; }
  if (n) out.push(below1000(n));
  return out.join(' ');
}
export function amountInWords(v) {
  const a = Math.round(Number(v || 0) * 100) / 100, dh = Math.floor(a), fils = Math.round((a - dh) * 100);
  return 'UAE Dirhams ' + intWords(dh) + (fils ? ' and ' + intWords(fils) + ' Fils' : '') + ' Only.';
}

// a vendor / customer row as the counter-party block (name, address, emirate & country, Attn, TRN)
export const partyOf = r => r?.name ? { name: r.name, lines: [r.address, [r.emirate, r.country].filter(Boolean).join(', ')].filter(Boolean), attn: r.contact_person, trn: r.trn } : null;

// prepared / checked / authorised signatories with their stored signature images.
// sign.checks [{label, user}] gives several checkers (e.g. Factory Manager then Finance Manager); otherwise sign.checked is the one checker
async function loadSigners(sign) {
  const c = state.company || {};
  const labels = sign.labels || ['Prepared By', 'Checked By', 'Approved & Authorized Signatory'];
  const checks = sign.checks || [{ label: labels[1], user: sign.checked }];
  const ids = [sign.prepared, ...checks.map(k => k.user), sign.approved && c.auth_sign_user_id].filter(Boolean);
  const [{ data: profs }, { data: sigs }] = ids.length
    ? await Promise.all([sb.from('profiles').select('id,full_name,email,role,job_title').in('id', ids), sb.from('user_signatures').select('user_id,image').in('user_id', ids)])
    : [{ data: [] }, { data: [] }];
  const person = id => { const p = (profs || []).find(x => x.id === id); return p ? { name: p.full_name || p.email, title: p.job_title || ROLES[p.role] || '', image: (sigs || []).find(s => s.user_id === id)?.image || null } : null; };
  const auth = { name: c.auth_sign_name || '', title: c.auth_sign_title || '', image: sign.approved && c.auth_sign_user_id ? person(c.auth_sign_user_id)?.image : null };
  return [{ label: labels[0], ...(person(sign.prepared) || {}) }, ...checks.map(k => ({ label: k.label, ...(person(k.user) || {}) })),
          { label: labels[labels.length - 1], ...auth }];
}

/**
 * makePdf: every printed document.
 *   title, no, date, filename, landscape                 — as before (no + date print as "<noLabel>: no" / "Date: 2 October 2026")
 *   meta [[label, value]], columns [{h, k, w, align, strong}], rows, totals [[label, value]], notes, signatures [labels]
 * House-style extras: noLabel, party {name, lines[], attn, trn}, subject, intro, scopeHeading, words (amount for "Amount in Words"),
 *   paymentTerms [{pct, text}], terms [string] (numbered after the payment terms), deliveryAddress,
 *   sign {prepared, checked, approved, labels} (user ids → stored signatures), acceptance (counter-party name).
 */
export async function makePdf({ title, no, date, meta = [], columns, rows, totals = [], notes = '', signatures = [], filename, landscape = false, subtitle = '',
  noLabel = 'Number', party = null, subject = '', intro = '', scopeHeading = '', words = null, paymentTerms = [], terms = [], deliveryAddress = '', sign = null, acceptance = '',
  sections = [] }) {
  await loadAssets();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  if (asset.fonts) for (const { f, s, b64 } of asset.fonts) { doc.addFileToVFS(f, b64); doc.addFont(f, 'Carlito', s); }
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), CW = W - LM - RM;
  const font = (style = 'normal', size = 10.5) => { doc.setFont(FONT(), style); doc.setFontSize(size); };
  const lh = size => size * PT * 1.3;                      // line height in mm
  let y = TOP;
  const room = h => { if (y + h > H - BOTTOM) { doc.addPage(); y = TOP; } };
  // label in bold followed by normal text on one line
  const kv = (label, value, x, yy, align = 'left') => {
    font('bold'); const lw = doc.getTextWidth(label + ' ');
    font('normal'); const vw = doc.getTextWidth(String(value ?? ''));
    const x0 = align === 'right' ? x - lw - vw : x;
    font('bold'); doc.text(label, x0, yy); font('normal'); doc.text(String(value ?? ''), x0 + lw, yy);
  };
  const para = (text, { style = 'normal', size = 10.5, indent = 0, hang = 0, justify = false, after = 1.5 } = {}) => {
    font(style, size);
    const lines = doc.splitTextToSize(String(text), CW - indent - hang);
    lines.forEach((ln, i) => { room(lh(size)); doc.text(ln, LM + indent + (i ? hang : 0), y, justify && i < lines.length - 1 ? { align: 'justify', maxWidth: CW - indent - hang } : undefined); y += lh(size); });
    y += after;
  };
  doc.setTextColor(0);

  // title, number and date
  font('bold', 11.5); doc.text(title.toUpperCase(), W / 2, y, { align: 'center' }); y += 9;
  font('normal', 10.5);
  if (no) kv(noLabel + ':', no, LM, y);
  if (date) kv('Date:', longDate(date), W - RM, y, 'right');
  y += 9;
  if (subtitle && !subject) { font('italic', 10); doc.text(String(subtitle), LM, y); y += 6; }

  // counter-party block
  if (party?.name) {
    font('bold', 10.5); doc.text(party.name, LM, y); y += lh(10.5);
    font('normal', 10.5);
    [...(party.lines || []), party.attn && 'Attn: ' + party.attn, party.trn && 'TRN: ' + party.trn].filter(Boolean)
      .forEach(l => { doc.splitTextToSize(String(l), CW).forEach(s => { doc.text(s, LM, y); y += lh(10.5); }); });
    y += 4;
  }
  // other details: two columns of "Label: value"
  const m = meta.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (m.length) {
    const half = Math.ceil(m.length / 2), colW = CW / 2;
    m.forEach(([l, v], i) => {
      const col = i < half ? 0 : 1, row = i < half ? i : i - half;
      font('bold', 9.5); const lw = doc.getTextWidth(l + ': ');
      font('normal', 9.5); const val = doc.splitTextToSize(String(v), colW - lw - 3)[0] || '';
      font('bold', 9.5); doc.text(l + ':', LM + col * colW, y + row * lh(9.5));
      font('normal', 9.5); doc.text(val, LM + col * colW + lw, y + row * lh(9.5));
    });
    y += half * lh(9.5) + 4;
  }
  if (subject) {
    room(8); font('bold', 10.5); doc.text('Subject:', LM, y);
    const sx = LM + doc.getTextWidth('Subject: '), sl = doc.splitTextToSize(subject, CW - (sx - LM));
    sl.forEach((s, i) => { doc.text(s, sx, y); doc.setLineWidth(0.25); doc.line(sx, y + 0.8, sx + doc.getTextWidth(s), y + 0.8); if (i < sl.length - 1) y += lh(10.5); });
    y += 8;
  }
  if (intro) para(intro, { justify: true, after: 5 });
  if (scopeHeading) { room(8); font('bold', 10.5); doc.text(scopeHeading, LM, y); y += 4; }

  // lines table: navy header, light-blue grid, zebra rows, grey totals band
  const strongCol = columns.findIndex(c => c.strong);
  const cellText = (c, r) => { const v = (typeof c.k === 'function' ? c.k(r) : r[c.k]) ?? ''; return c.h === 'Sr. No.' && typeof v === 'number' ? v + '.' : v; };
  doc.autoTable({
    startY: y,
    head: [columns.map(c => c.h)],
    body: rows.map(r => columns.map(c => cellText(c, r))),
    foot: totals.length ? totals.map(([l, v]) => [{ content: String(l), colSpan: columns.length - 1, styles: { halign: 'right' } }, { content: String(v), styles: { halign: 'right' } }]) : undefined,
    showFoot: 'lastPage',
    theme: 'grid',
    styles: { font: FONT(), fontSize: 9.5, cellPadding: 1.6, lineColor: GRID, lineWidth: 0.18, textColor: 20, valign: 'middle' },
    headStyles: { fillColor: NAVY, textColor: 255, fontStyle: 'bold', halign: 'center' },
    footStyles: { fillColor: TOTAL_FILL, textColor: 20, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, { halign: c.align || (c.h === 'Sr. No.' ? 'center' : 'left'), cellWidth: c.w || 'auto' }])),
    margin: { left: LM, right: RM, top: TOP, bottom: BOTTOM },
    // the main description column: first line bold, the rest normal
    willDrawCell: d => { if (d.section === 'body' && d.column.index === strongCol && d.cell.text.length) { d.cell._lines = d.cell.text; d.cell.text = []; } },
    didDrawCell: d => {
      const ls = d.cell._lines; if (!ls) return;
      const fs = d.cell.styles.fontSize, step = fs * PT * doc.getLineHeightFactor();
      let yy = d.cell.y + (d.cell.height - ls.length * step) / 2 + fs * PT * 0.85;
      ls.forEach((t, i) => { doc.setFont(FONT(), i === 0 ? 'bold' : 'normal'); doc.setFontSize(fs); doc.setTextColor(20); doc.text(t, d.cell.x + d.cell.padding('left'), yy); yy += step; });
    },
  });
  y = doc.lastAutoTable.finalY + 6;

  if (words !== null && words !== undefined) {
    room(6); font('bold', 9.5); doc.text('Amount in Words:', LM, y);
    const x = LM + doc.getTextWidth('Amount in Words: ');
    font('italic', 9.5); doc.splitTextToSize(amountInWords(words), CW - (x - LM)).forEach((s, i) => { doc.text(s, x, y); y += lh(9.5); });
    y += 3;
  }
  // further tables in the same style (e.g. the PO delivery schedule), each with a heading
  for (const s of sections) {
    if (!s.rows?.length) continue;
    room(16); font('bold', 11.5); doc.text(s.heading, LM, y); y += 3;
    doc.autoTable({
      startY: y, head: [s.columns.map(c => c.h)], body: s.rows.map(r => s.columns.map(c => cellText(c, r))), theme: 'grid',
      styles: { font: FONT(), fontSize: 9.5, cellPadding: 1.6, lineColor: GRID, lineWidth: 0.18, textColor: 20, valign: 'middle' },
      headStyles: { fillColor: NAVY, textColor: 255, fontStyle: 'bold', halign: 'center' }, alternateRowStyles: { fillColor: ZEBRA },
      columnStyles: Object.fromEntries(s.columns.map((c, i) => [i, { halign: c.align || (c.h === 'Sr. No.' ? 'center' : 'left'), cellWidth: c.w || 'auto', fontStyle: c.bold ? 'bold' : 'normal' }])),
      margin: { left: LM, right: RM, top: TOP, bottom: BOTTOM },
    });
    y = doc.lastAutoTable.finalY + 6;
  }
  let n = 0;
  if (paymentTerms.length) {
    room(10); font('bold', 11.5); doc.text('Payment Terms', LM, y); y += 6;
    paymentTerms.forEach(p => { n++; para(`${n}.  ${p.pct ? Number(p.pct) + '% ' : ''}${p.text}`, { justify: true, hang: 5, after: 1 }); });
    y += 2;
  }
  if (terms.length) {
    room(10); font('bold', 11.5); doc.text('Terms & Conditions', LM, y); y += 6;
    terms.forEach(t => { n++; para(`${n}.  ${t}`, { justify: true, hang: 5, after: 1 }); });
    y += 2;
  }
  if (deliveryAddress) { room(6); kv('Delivery Address:', deliveryAddress, LM, y); y += 7; }
  if (notes) { room(8); font('bold', 10.5); doc.text('Notes', LM, y); y += 5; para(notes, { size: 9.5, after: 3 }); }

  // signatures: label, stored signature image, line, name, title
  // a blank label drops that block (e.g. an RFQ only has "Prepared By")
  const sigs = (sign ? await loadSigners(sign) : signatures.map(s => Array.isArray(s) ? { label: s[0], title: s[1] } : { label: s })).filter(s => s.label);
  if (sigs.length) {
    const blockH = 42 + (acceptance ? 48 : 0);
    if (y + blockH > H - BOTTOM) { doc.addPage(); y = TOP; } else y += 6;
    const cw = CW / Math.max(sigs.length, 3), fs = sigs.length > 3 ? 8.5 : 9.5, tw = cw - 5;
    sigs.forEach((s, i) => {
      const x = LM + i * cw;
      font('bold', fs); doc.text(s.label || '', x, y);
      if (s.image) { try { const p = doc.getImageProperties(s.image), sc = Math.min((tw - 2) / p.width, 18 / p.height); doc.addImage(s.image, x, y + 20 - p.height * sc, p.width * sc, p.height * sc); } catch (e) { console.warn('signature', e); } }
      doc.setDrawColor(60); doc.setLineWidth(0.2); doc.line(x, y + 22, x + cw - 6, y + 22);
      // narrow columns (4 signers): long names / titles wrap onto a second line
      let ty = y + 27;
      if (s.name) { font('bold', fs); doc.splitTextToSize(s.name, tw).slice(0, 2).forEach(t => { doc.text(t, x, ty); ty += lh(fs); }); }
      if (s.title) { font('italic', fs); doc.splitTextToSize(s.title, tw).slice(0, 2).forEach(t => { doc.text(t, x, ty); ty += lh(fs); }); }
    });
    y += 42;
  }
  if (acceptance) {
    room(48);
    font('bold', 10.5);
    doc.splitTextToSize(`On behalf of ${acceptance}, being the authorized representative, I have reviewed and accepted the aforementioned details of this ${title.replace(/\b\w/g, ch => ch.toUpperCase())} and associated terms and conditions.`, CW)
      .forEach(s => { doc.text(s, LM, y); y += lh(10.5); });
    y += 3; doc.text('Received & Accepted by:', LM, y); doc.line(LM, y + 0.8, LM + doc.getTextWidth('Received & Accepted by:'), y + 0.8);
    y += 14; doc.setDrawColor(60); doc.line(LM, y, LM + 72, y); y += 5;
    font('bold', 9.5); doc.text('Name:', LM, y); y += 4.5;
    font('italic', 9.5); ['Designation:', 'Date:', 'Company Stamp:'].forEach(t => { doc.text(t, LM, y); y += 4.5; });
  }

  // every page: logo, address footer, document number and page
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (asset.logo) doc.addImage(asset.logo, 'PNG', LM, 12.7, 78.7, 78.7 * 234 / 1240);
    else { font('bold', 13); doc.setTextColor(0); doc.text((state.company || {}).company_name || 'Citi Homes', LM, 18); }
    // company TRN and trade licence, top right beside the logo
    const co = state.company || {};
    const ids = [co.trn && 'TRN: ' + co.trn, co.trade_license_no && 'Trade Licence: ' + co.trade_license_no].filter(Boolean);
    font('normal', 8); doc.setTextColor(...GREY);
    ids.forEach((t, i) => doc.text(t, W - RM, 21.5 + i * 3.8, { align: 'right' }));
    if (asset.footer) doc.addImage(asset.footer, 'PNG', LM, H - 9 - 39.5 * 298 / 746, 39.5, 39.5 * 298 / 746);
    font('normal', 8); doc.setTextColor(...GREY);
    doc.text(`${no ? no + '  |  ' : ''}Page ${p} of ${pages}`, W - RM, H - 10.5, { align: 'right' });
    doc.setTextColor(0);
  }
  showPdf(doc, filename || `${(no || title).replace(/[\/\\]/g, '-')}.pdf`, [title, no].filter(Boolean).join(' · '));
}

export const m = money;
