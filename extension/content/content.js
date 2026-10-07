// Content script (isolated world). Thu thập nội dung văn bản đang mở, các file
// đã bắt được, danh sách văn bản và điền ý kiến xử lý vào ô nhập.
(() => {
  if (window.__vpdtContentInstalled) return;
  window.__vpdtContentInstalled = true;

  const IS_TOP = window === window.top;
  const MAX_FILES = 30;
  const files = new Map(); // id -> {id, name, mime, kind, size, url, source, time, bytes}
  const pendingFetch = new Map();
  let seq = 0;

  // ---------- Tiện ích ----------
  function sniffKind(buf, name, mime) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
    if (b[0] === 0x50 && b[1] === 0x4b) {
      if (/\.xlsx?$/i.test(name) || /sheet/i.test(mime)) return 'xlsx';
      return 'docx';
    }
    if (b[0] === 0xd0 && b[1] === 0xcf) return 'doc';
    return 'unknown';
  }

  function fingerprint(buf) {
    const v = new Uint8Array(buf);
    let h = 2166136261 ^ v.length;
    const step = Math.max(1, Math.floor(v.length / 4096));
    for (let i = 0; i < v.length; i += step) h = Math.imul(h ^ v[i], 16777619);
    return (h >>> 0).toString(16) + '-' + v.length;
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  }

  function clean(text, max) {
    const t = (text || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return max && t.length > max ? t.slice(0, max) + '\n…[đã cắt bớt]' : t;
  }

  function addFile(d) {
    if (!d.bytes || !d.bytes.byteLength) return null;
    const fp = fingerprint(d.bytes);
    for (const f of files.values()) if (f.fp === fp) return f.id;
    const kind = sniffKind(d.bytes, d.name || '', d.mime || '');
    if (kind === 'unknown') return null;
    let name = d.name || 'file';
    if (/^blob:/.test(d.url || '') || !/\.[a-z0-9]{2,4}$/i.test(name)) {
      name = (name.startsWith('blob') || name.length > 40 ? 'file' : name) + '.' + kind;
    }
    const id = 'f' + ++seq;
    files.set(id, {
      id,
      fp,
      name,
      mime: d.mime || '',
      kind,
      size: d.bytes.byteLength,
      url: /^blob:/.test(d.url || '') ? '' : d.url || '',
      source: d.source || '',
      time: Date.now(),
      bytes: d.bytes
    });
    while (files.size > MAX_FILES) files.delete(files.keys().next().value);
    if (IS_TOP) notify({ type: 'filesChanged' });
    return id;
  }

  function notify(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {}
  }

  // ---------- Nhận file từ hook.js (cùng frame) và từ frame con ----------
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__vpdt !== true) return;
    if (d.type === 'file') {
      if (IS_TOP) addFile(d);
      else if (ev.source === window) {
        // Frame con: chuyển tiếp lên frame trên cùng.
        try {
          window.top.postMessage({ ...d, forwarded: true }, '*', [d.bytes]);
        } catch (_) {}
      }
    } else if (d.type === 'fetch-result' && ev.source === window) {
      const p = pendingFetch.get(d.reqId);
      if (p) {
        pendingFetch.delete(d.reqId);
        d.ok ? p.resolve(d) : p.reject(new Error(d.error));
      }
    }
  });

  // Tải file qua ngữ cảnh trang (có cookie + Authorization), dự phòng fetch trực tiếp.
  function fetchViaPage(url) {
    return new Promise((resolve, reject) => {
      const reqId = 'r' + Date.now() + Math.random();
      const timer = setTimeout(() => {
        pendingFetch.delete(reqId);
        reject(new Error('Hết thời gian chờ tải file'));
      }, 60000);
      pendingFetch.set(reqId, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      });
      window.postMessage({ __vpdt: true, type: 'fetch-request', url, reqId }, '*');
    });
  }

  async function fetchUrl(url) {
    let d;
    try {
      d = await fetchViaPage(url);
    } catch (e) {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Không tải được file: HTTP ' + res.status);
      d = { url: res.url, name: decodeURIComponent(new URL(res.url).pathname.split('/').pop() || 'file'), mime: res.headers.get('content-type') || '', bytes: await res.arrayBuffer() };
    }
    const id = addFile({ ...d, source: 'link' });
    if (!id) throw new Error('Liên kết không phải file PDF/DOCX hợp lệ.');
    return id;
  }

  // ---------- Đọc ngữ cảnh trang ----------
  const DIALOG_SEL = [
    '.modal.show', '.modal.in', '.modal[style*="display: block"]', '[role="dialog"]', '[aria-modal="true"]',
    '.ant-modal', '.el-dialog', '.p-dialog', '.mat-dialog-container', '.mat-mdc-dialog-container',
    '.k-window', '.dx-popup-content', '.ui-dialog', '.swal2-popup'
  ].join(',');

  function topDialog() {
    const list = [...document.querySelectorAll(DIALOG_SEL)].filter(isVisible);
    if (!list.length) return null;
    // Ưu tiên hộp thoại nằm trên cùng (z-index lớn nhất) và có diện tích lớn.
    const score = (el) => {
      let z = 0;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const v = parseInt(getComputedStyle(n).zIndex, 10);
        if (!isNaN(v)) z = Math.max(z, v);
      }
      const r = el.getBoundingClientRect();
      return z * 1e7 + r.width * r.height;
    };
    return list.sort((a, b) => score(b) - score(a))[0];
  }

  function docTitle(root) {
    const text = (root || document.body).innerText || '';
    const m = /Xem\s*:\s*([^\n]+)/.exec(text);
    return m ? m[1].trim() : '';
  }

  function viewerText(root) {
    // Lớp chữ của trình xem PDF (pdf.js) nếu có.
    const parts = [];
    const collect = (doc) => {
      doc.querySelectorAll('.textLayer').forEach((el) => {
        const t = el.innerText || el.textContent;
        if (t && t.trim()) parts.push(t);
      });
    };
    collect(root || document);
    document.querySelectorAll('iframe').forEach((f) => {
      try {
        if (f.contentDocument) collect(f.contentDocument);
      } catch (_) {}
    });
    return parts.join('\n');
  }

  function fileLinks(root) {
    const out = new Map();
    (root || document).querySelectorAll('a[href], [data-url], [data-href], iframe[src], embed[src], object[data]').forEach((el) => {
      const raw = el.getAttribute('href') || el.dataset.url || el.dataset.href || el.getAttribute('src') || el.getAttribute('data');
      if (!raw || /^(javascript:|#|mailto:)/i.test(raw)) return;
      let url;
      try {
        url = new URL(raw, location.href).href;
      } catch (_) {
        return;
      }
      const label = clean(el.innerText || el.getAttribute('title') || el.getAttribute('download') || '', 120);
      const looksFile = /\.(pdf|docx?|xlsx?)(\?|#|$)/i.test(url) || /download|tai-?file|attach|dinhkem|file/i.test(url) || el.hasAttribute('download');
      if (looksFile && !/^blob:/.test(url)) out.set(url, { url, label: label || decodeURIComponent(url.split('/').pop().split('?')[0]) });
    });
    return [...out.values()].slice(0, 40);
  }

  function listRows() {
    const rows = [];
    document.querySelectorAll('table').forEach((table) => {
      if (!isVisible(table)) return;
      const headers = [...table.querySelectorAll('thead th')].map((th) => clean(th.innerText)).filter(Boolean);
      table.querySelectorAll('tbody tr').forEach((tr) => {
        if (!isVisible(tr)) return;
        const cells = [...tr.querySelectorAll('td')].map((td) => clean(td.innerText)).filter(Boolean);
        if (cells.join(' ').length > 15) rows.push({ headers, cells });
      });
    });
    return rows.slice(0, 100);
  }

  function getContext() {
    const dialog = topDialog();
    const root = dialog || document.body;
    return {
      url: location.href,
      pageTitle: document.title,
      inDialog: !!dialog,
      docTitle: docTitle(root),
      pageText: clean(root.innerText, 20000),
      viewerText: clean(viewerText(root), 60000),
      links: fileLinks(root),
      files: [...files.values()]
        .sort((a, b) => b.time - a.time)
        .map(({ bytes, fp, ...meta }) => meta)
    };
  }

  // ---------- Điền ý kiến xử lý ----------
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let lastFocused = null;
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && t.type === 'text'))) lastFocused = t;
    },
    true
  );

  function fillOpinion(text) {
    let target = lastFocused && document.contains(lastFocused) && isVisible(lastFocused) ? lastFocused : null;
    if (!target) {
      const dialog = topDialog();
      const scope = dialog || document;
      const cands = [...scope.querySelectorAll('textarea, [contenteditable="true"]')].filter(isVisible);
      target = cands.pop() || null;
    }
    if (!target) return { ok: false, error: 'Không tìm thấy ô nhập. Hãy bấm "Ý kiến xử lý" trên trang và nhấp vào ô nhập nội dung, rồi thử lại.' };
    target.focus();
    if (target.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } else {
      setNativeValue(target, text);
    }
    return { ok: true };
  }

  // ---------- Phát hiện mở văn bản mới (cho chế độ tự động) ----------
  if (IS_TOP) {
    let lastKey = '';
    let timer = null;
    const check = () => {
      const dialog = topDialog();
      const key = dialog ? docTitle(dialog) : '';
      if (key && key !== lastKey) {
        lastKey = key;
        notify({ type: 'docOpened', key });
      } else if (!key) {
        lastKey = '';
      }
    };
    const start = () => {
      new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(check, 1500);
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  // ---------- Lệnh từ side panel ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!IS_TOP || !msg || msg.target !== 'vpdt') return;
    (async () => {
      switch (msg.type) {
        case 'ping':
          return { ok: true };
        case 'getContext':
          return { ok: true, context: getContext() };
        case 'getFile': {
          const f = files.get(msg.id);
          if (!f) throw new Error('File không còn trong bộ nhớ, hãy mở lại văn bản.');
          return { ok: true, name: f.name, kind: f.kind, base64: bufToBase64(f.bytes) };
        }
        case 'fetchUrl':
          return { ok: true, id: await fetchUrl(msg.url) };
        case 'clearFiles':
          files.clear();
          return { ok: true };
        case 'getListRows':
          return { ok: true, rows: listRows() };
        case 'fillOpinion':
          return fillOpinion(msg.text);
        default:
          throw new Error('Lệnh không hợp lệ: ' + msg.type);
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });
})();
