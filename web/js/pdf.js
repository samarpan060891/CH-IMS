// PDF generation (jsPDF + autotable) for issue slips, POs, GRNs, vouchers, gate passes — every PDF opens in a panel that
// slides in from the right (pages drawn with PDF.js so it also works on phones) with Download, Print and Open in new tab.
import { reactive } from 'vue';
import { state, dt, dtm, money, toast } from './lib.js';
import { logoPng } from './logo.js';

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

const BRAND = [27, 58, 107];   // navy

export async function makePdf({ title, no, date, meta = [], columns, rows, totals = [], notes = '', signatures = [], filename, landscape = false, subtitle = '' }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const c = state.company || {};

  // company header with logo
  doc.setFillColor(...BRAND); doc.rect(0, 0, W, 3, 'F');
  let tx = 14;
  try { doc.addImage(await logoPng(), 'PNG', 12, 6, 24, 24); tx = 39; } catch (e) { console.warn('logo', e); }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(40);
  doc.text(c.company_name || 'Citi Homes', tx, 14);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
  const addr = [c.address, [c.phone, c.email].filter(Boolean).join('  |  '), c.trn ? 'TRN: ' + c.trn : ''].filter(Boolean);
  addr.forEach((l, i) => doc.text(String(l), tx, 19 + i * 4));

  // title block
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...BRAND);
  doc.text(title.toUpperCase(), W - 14, 14, { align: 'right' });
  doc.setFontSize(10); doc.setTextColor(40);
  doc.text(no || '', W - 14, 20, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text('Date: ' + dt(date), W - 14, 25, { align: 'right' });
  if (subtitle) doc.text(subtitle, W - 14, 30, { align: 'right' });

  // meta (two columns of label: value)
  let y = 36;
  doc.setDrawColor(220); doc.line(14, y - 3, W - 14, y - 3);
  const half = Math.ceil(meta.length / 2);
  const colX = [14, W / 2 + 2];
  doc.setFontSize(8.5);
  meta.forEach(([l, v], i) => {
    const col = i < half ? 0 : 1;
    const row = i < half ? i : i - half;
    const yy = y + row * 5;
    doc.setFont('helvetica', 'bold'); doc.setTextColor(90); doc.text(String(l) + ':', colX[col], yy);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(30);
    doc.text(doc.splitTextToSize(String(v ?? ''), W / 2 - 50)[0] || '', colX[col] + 34, yy);
  });
  y += half * 5 + 3;

  doc.autoTable({
    startY: y,
    head: [columns.map(c => c.h)],
    body: rows.map(r => columns.map(c => (typeof c.k === 'function' ? c.k(r) : r[c.k]) ?? '')),
    styles: { fontSize: 8.5, cellPadding: 1.8, lineColor: [225, 225, 225], lineWidth: 0.1 },
    headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, { halign: c.align || 'left', cellWidth: c.w || 'auto' }])),
    margin: { left: 14, right: 14, bottom: 30 },
  });
  y = doc.lastAutoTable.finalY + 6;

  if (totals.length) {
    doc.setFontSize(9.5);
    totals.forEach(([l, v], i) => {
      doc.setFont('helvetica', i === totals.length - 1 ? 'bold' : 'normal');
      doc.text(String(l), W - 60, y + i * 5.5);
      doc.text(String(v), W - 14, y + i * 5.5, { align: 'right' });
    });
    y += totals.length * 5.5 + 3;
  }
  if (notes) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(70);
    const lines = doc.splitTextToSize(notes, W - 28);
    if (y + lines.length * 4 > H - 40) { doc.addPage(); y = 20; }
    doc.text(lines, 14, y); y += lines.length * 4 + 4;
  }

  // signatures
  if (signatures.length) {
    let sy = Math.max(y + 18, H - 38);
    if (sy > H - 20) { doc.addPage(); sy = H - 38; }
    const w = (W - 28) / signatures.length;
    doc.setFontSize(8.5); doc.setTextColor(60); doc.setDrawColor(150);
    signatures.forEach((s, i) => {
      const x = 14 + i * w;
      doc.line(x + 3, sy, x + w - 6, sy);
      const [name, sub] = Array.isArray(s) ? s : [s, ''];
      doc.text(name, x + 3, sy + 4.5);
      if (sub) { doc.setTextColor(120); doc.text(String(sub), x + 3, sy + 8.5); doc.setTextColor(60); }
    });
  }

  // footer
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5); doc.setTextColor(140);
    doc.text(`Generated by CitiCore · ${dtm(new Date().toISOString())} · ${state.profile?.full_name || state.profile?.email || ''}`, 14, H - 8);
    doc.text(`Page ${p} of ${pages}`, W - 14, H - 8, { align: 'right' });
  }
  showPdf(doc, filename || `${(no || title).replace(/[\/\\]/g, '-')}.pdf`, [title, no].filter(Boolean).join(' · '));
}

export const m = money;
