// Trích xuất chữ từ file PDF / DOCX / XLSX ngay trong trình duyệt.

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(chrome.runtime.getURL('lib/pdfjs/pdf.min.mjs')).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.mjs');
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function detectKind(bytes, name = '') {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return /\.xlsx?$/i.test(name) ? 'xlsx' : 'docx';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return 'doc';
  if (/\.txt$/i.test(name)) return 'txt';
  return 'unknown';
}

/**
 * @returns {Promise<{text: string, pages?: number, warning?: string}>}
 */
export async function extractText(bytes, { name = '', kind, maxPdfPages = 40 } = {}) {
  kind = kind || detectKind(bytes, name);
  switch (kind) {
    case 'pdf':
      return extractPdf(bytes, maxPdfPages);
    case 'docx':
    case 'xlsx': {
      const zip = await readZip(bytes);
      if (zip.has('word/document.xml')) return { text: await docxText(zip) };
      if (zip.has('xl/workbook.xml')) return { text: await xlsxText(zip) };
      throw new Error('File nén không phải DOCX/XLSX.');
    }
    case 'txt':
      return { text: new TextDecoder().decode(bytes) };
    case 'doc':
      throw new Error('Định dạng .doc (Word 97-2003) chưa được hỗ trợ, hãy dùng bản PDF hoặc DOCX.');
    default:
      throw new Error('Không nhận dạng được định dạng file.');
  }
}

// ---------- PDF ----------
async function extractPdf(bytes, maxPages) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: bytes,
    cMapUrl: chrome.runtime.getURL('lib/pdfjs/cmaps/'),
    cMapPacked: true,
    isEvalSupported: false
  }).promise;
  const total = doc.numPages;
  const n = Math.min(total, maxPages);
  const pages = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    let out = '';
    let lastY = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line) {
        out += line.trimEnd() + '\n';
        line = '';
      }
      line += item.str;
      if (item.hasEOL) {
        out += line.trimEnd() + '\n';
        line = '';
      }
      lastY = y;
    }
    if (line) out += line.trimEnd() + '\n';
    pages.push(`--- Trang ${i} ---\n${out.trim()}`);
    page.cleanup();
  }
  await doc.destroy();
  const text = pages.join('\n\n');
  const letters = text.replace(/--- Trang \d+ ---|\s/g, '').length;
  let warning;
  if (letters < 40 * n) {
    warning = 'PDF có rất ít chữ (có thể là bản scan dạng ảnh). AI sẽ chỉ dựa vào thông tin trên trang.';
  }
  if (total > n) {
    warning = (warning ? warning + ' ' : '') + `Chỉ đọc ${n}/${total} trang đầu.`;
  }
  return { text, pages: total, warning };
}

// ---------- ZIP tối giản (dùng DecompressionStream có sẵn của trình duyệt) ----------
async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('File ZIP hỏng.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (n) => entries.has(n),
    names: () => [...entries.keys()],
    async text(n) {
      const e = entries.get(n);
      if (!e) return null;
      const lnameLen = dv.getUint16(e.local + 26, true);
      const lextraLen = dv.getUint16(e.local + 28, true);
      const start = e.local + 30 + lnameLen + lextraLen;
      const data = bytes.subarray(start, start + e.csize);
      if (e.method === 0) return dec.decode(data);
      if (e.method !== 8) throw new Error('Kiểu nén ZIP không hỗ trợ.');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return dec.decode(await new Response(stream).arrayBuffer());
    }
  };
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

async function docxText(zip) {
  const parts = ['word/document.xml'];
  for (const n of zip.names()) if (/^word\/(header|footer|footnotes)\d*\.xml$/.test(n)) parts.push(n);
  const out = [];
  for (const n of parts) {
    const xml = await zip.text(n);
    if (!xml) continue;
    const paras = xml.split(/<\/w:p>/).map((p) => {
      const withTabs = p.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n');
      const texts = [];
      withTabs.replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|(\t|\n)/g, (_, t, ws) => {
        texts.push(t !== undefined ? t : ws);
        return '';
      });
      return decodeXml(texts.join(''));
    });
    out.push(paras.filter((s) => s.trim()).join('\n'));
  }
  return out.join('\n\n');
}

async function xlsxText(zip) {
  const sharedXml = (await zip.text('xl/sharedStrings.xml')) || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''))
  );
  const out = [];
  const sheets = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  for (const s of sheets) {
    const xml = await zip.text(s);
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
      [...r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)]
        .map(([, attrs, inner]) => {
          const v = /<v>([^<]*)<\/v>/.exec(inner);
          const is = /<t[^>]*>([^<]*)<\/t>/.exec(inner);
          if (/t="s"/.test(attrs) && v) return shared[+v[1]] || '';
          if (is) return decodeXml(is[1]);
          return v ? decodeXml(v[1]) : '';
        })
        .join('\t')
    );
    out.push(`--- ${s.split('/').pop()} ---\n` + rows.join('\n'));
  }
  return out.join('\n\n');
}
