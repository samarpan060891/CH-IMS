// QR codes: payload format, generation (vector, for PDFs) and scanning (phone camera or USB scanner)
//   CH:L:<lot uuid>   stock lot         CH:I:<item code>   item / bin label      CH:A:<asset tag>   tool / machine
import { sb, must, qty, dt, refRow } from './lib.js';
import { Modal } from './components.js';

const LIBS = {
  qr: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
  cam: 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
};
const loading = {};
export function loadLib(key) {
  const globalName = key === 'qr' ? 'qrcode' : 'Html5Qrcode';
  if (window[globalName]) return Promise.resolve(window[globalName]);
  loading[key] ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = LIBS[key]; s.onload = () => res(window[globalName]); s.onerror = () => rej(new Error('Could not load the scanner / QR library'));
    document.head.appendChild(s);
  });
  return loading[key];
}

export const qrText = { lot: id => `CH:L:${id}`, item: code => `CH:I:${code}`, asset: tag => `CH:A:${tag}` };
export function parseCode(raw) {
  const t = String(raw || '').trim();
  const m = t.match(/^CH:([LIA]):(.+)$/i);
  if (m) return { kind: { L: 'lot', I: 'item', A: 'asset' }[m[1].toUpperCase()], value: m[2] };
  // plain text from a USB scanner or typed: treat as item code or asset tag
  return { kind: 'text', value: t };
}

// QR module matrix (true = dark) — drawn as vector squares in jsPDF
export async function qrMatrix(text) {
  const qrcode = await loadLib('qr');
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount();
  return { n, dark: (r, c) => q.isDark(r, c) };
}

// ---------- scanner modal: camera + keyboard-wedge (USB scanner / manual) input ----------
export const Scanner = {
  components: { Modal },
  props: { title: { type: String, default: 'Scan QR / barcode' } },
  emits: ['code', 'close'],
  data: () => ({ manual: '', camOn: false, err: '' }),
  async mounted() {
    this.$refs.inp?.focus();
    try {
      const Html5Qrcode = await loadLib('cam');
      this.cam = new Html5Qrcode('ims-cam');
      await this.cam.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, text => this.hit(text), () => {});
      this.camOn = true;
    } catch (e) { this.err = 'Camera not available — use a USB scanner or type the code.'; }
  },
  beforeUnmount() { this.stop(); },
  methods: {
    async stop() { if (this.cam && this.camOn) { try { await this.cam.stop(); } catch { /* already stopped */ } this.camOn = false; } },
    async hit(text) { if (this.done) return; this.done = true; await this.stop(); this.$emit('code', text); },
    submit() { if (this.manual.trim()) this.hit(this.manual.trim()); },
  },
  template: `<Modal :title="title" small @close="stop(); $emit('close')">
    <div id="ims-cam" style="width:100%;min-height:40px;border-radius:8px;overflow:hidden;background:#0f2143"></div>
    <p class="small muted" v-if="err">{{ err }}</p>
    <form @submit.prevent="submit" style="margin-top:10px" class="row">
      <input ref="inp" v-model="manual" placeholder="USB scanner or type code / tag" style="flex:1">
      <button class="btn primary">Go</button>
    </form>
  </Modal>`,
};

// ---------- resolve a scanned code into something useful ----------
export async function describeCode(raw) {
  const c = parseCode(raw);
  if (c.kind === 'lot') {
    const l = must(await sb.from('v_lot_values').select('*').eq('lot_id', c.value).maybeSingle());
    if (!l) {
      const z = must(await sb.from('stock_lots').select('id,lot_no,qty_on_hand,items(code,name)').eq('id', c.value).maybeSingle());
      if (!z) throw new Error('Unknown lot label');
      return { kind: 'lot', title: `${z.items.code} — ${z.items.name}`, lines: [`Lot ${z.lot_no}`, 'This lot is fully used (qty 0)'], item_code: z.items.code, lot_id: z.id };
    }
    return { kind: 'lot', item_id: l.item_id, item_code: l.item_code, lot_id: l.lot_id, title: `${l.item_code} — ${l.item_name}`,
      lines: [`Lot ${l.lot_no}${l.batch_no ? ' / batch ' + l.batch_no : ''}`, `At ${l.location_code}: ${qty(l.qty_on_hand)} ${l.uom}`,
              `Received ${dt(l.received_date)} (${l.age_days} days)`, l.lot_status !== 'AVAILABLE' ? 'ON HOLD' : '',
              l.project_id ? 'Reserved for ' + (refRow('projects', l.project_id)?.code || 'a project') : 'Free stock'].filter(Boolean) };
  }
  if (c.kind === 'asset' || c.kind === 'text') {
    const a = must(await sb.from('v_asset_register').select('*').eq('asset_tag', c.value).maybeSingle());
    if (a) return { kind: 'asset', asset_tag: a.asset_tag, title: `${a.asset_tag} — ${a.item_name}`,
      lines: [`Status: ${a.status}`, a.custodian_name ? `With ${a.custodian_name}` : `At ${a.location_name || '-'}`, a.serial_no ? 'Serial ' + a.serial_no : ''].filter(Boolean) };
    if (c.kind === 'asset') throw new Error('Unknown tool / asset tag');
  }
  const code = c.value;
  const it = must(await sb.from('v_item_stock').select('item_id,code,name,uom,on_hand,available,reserved_qty,buffer_zone').eq('code', code).maybeSingle());
  if (!it) throw new Error(`Nothing found for "${code}"`);
  return { kind: 'item', item_id: it.item_id, item_code: it.code, title: `${it.code} — ${it.name}`,
    lines: [`On hand ${qty(it.on_hand)} ${it.uom} · free ${qty(it.available)}${Number(it.reserved_qty) ? ' · reserved ' + qty(it.reserved_qty) : ''}`, it.buffer_zone ? 'Buffer: ' + it.buffer_zone : ''].filter(Boolean) };
}
