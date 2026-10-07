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
  // Tiền tố theo phiên để ID file không trùng sau khi trang tải lại.
  const SESSION = Math.random().toString(36).slice(2, 7);

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
    const st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
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
    const id = SESSION + '-f' + ++seq;
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

  // Nhận diện sổ văn bản: 'den' (Văn bản đến), 'di' (Văn bản đi), 'noi_bo' (Văn bản nội bộ).
  function classify(text) {
    const t = (text || '').toLowerCase();
    if (/nội bộ|vbnb/.test(t)) return 'noi_bo';
    if (/văn bản đi|vb phát hành|vb đã gửi|trình ký/.test(t)) return 'di';
    if (/văn bản đến|vb đã nhận|vb chờ duyệt|vb đến/.test(t)) return 'den';
    return '';
  }

  function breadcrumb() {
    for (const el of document.querySelectorAll('nav, ol, ul, div')) {
      if (el.childElementCount > 8) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < 80 && /văn bản (đến|đi|nội bộ)\s*\/\s*\S/i.test(t) && isVisible(el)) return t;
    }
    return '';
  }

  function detectLoai(dialog) {
    const crumb = breadcrumb();
    let loai = classify(crumb);
    if (!loai) loai = classify(decodeURIComponent(location.pathname + location.hash).replace(/[-_]/g, ' '));
    if (!loai && /incoming|den\b/i.test(location.href)) loai = 'den';
    if (!loai && /outgoing|vbdi|vb-di/i.test(location.href)) loai = 'di';
    if (!loai && /internal|noibo|noi-bo/i.test(location.href)) loai = 'noi_bo';
    if (!loai && dialog && /Đơn vị ngoài|Chuyển theo dõi/.test(dialog.innerText)) loai = 'di';
    return { loai: loai || 'den', breadcrumb: crumb };
  }

  function getContext() {
    const dialog = topDialog();
    const root = dialog || document.body;
    const { loai, breadcrumb: crumb } = detectLoai(dialog);
    return {
      url: location.href,
      pageTitle: document.title,
      inDialog: !!dialog,
      loai,
      breadcrumb: crumb,
      docTitle: docTitle(root),
      pageText: clean(root.innerText, 20000),
      viewerText: clean(viewerText(root), 60000),
      links: fileLinks(root),
      files: [...files.values()]
        .sort((a, b) => b.time - a.time)
        .map(({ bytes, fp, ...meta }) => meta)
    };
  }

  // ---------- Chế độ tự động: duyệt danh sách, mở / đóng văn bản ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY_RE = /\d+[\p{L}\p{N}.\-()]*\/[\p{L}\p{N}.\-()\/]+/u;
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Tất cả tài liệu có thể đọc: trang chính + iframe cùng nguồn (đệ quy).
  function allDocs() {
    const docs = [document];
    for (let i = 0; i < docs.length && i < 20; i++) {
      docs[i].querySelectorAll('iframe, frame').forEach((f) => {
        try {
          if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument);
        } catch (_) {}
      });
    }
    return docs;
  }

  const ROW_SEL = [
    'tr', '[role="row"]', '.ag-row', '.dx-data-row', '.k-master-row', '.p-datatable-row', '.mat-row', '.mat-mdc-row',
    '.el-table__row', '.ant-table-row', '.ui-grid-row', '.rgRow', '.rgAltRow', '.e-row', '.x-grid-row', '.datagrid-row'
  ].join(',');
  const CELL_SEL = 'td, [role="gridcell"], [role="cell"], .ag-cell, .e-rowcell, .x-grid-cell, .datagrid-cell';

  function docRows() {
    const out = [];
    const seen = new Set();
    const dlg = topDialog();
    for (const doc of allDocs()) {
      for (const tr of doc.querySelectorAll(ROW_SEL)) {
        if (tr.closest('thead') || tr.querySelector('th, [role="columnheader"]')) continue;
        if (dlg && dlg.contains(tr)) continue;
        if (!isVisible(tr)) continue;
        const text = clean(tr.innerText);
        if (text.length < 10) continue;
        const m = KEY_RE.exec(text);
        if (!m) continue;
        const key = m[0].replace(/[:,]$/, '');
        // Hàng lồng nhau hoặc lưới chia nhiều khung: giữ hàng trong cùng, mỗi số ký hiệu một lần.
        if (tr.querySelector(ROW_SEL) && [...tr.querySelectorAll(ROW_SEL)].some((c) => KEY_RE.test(c.innerText || ''))) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tr, key, text });
      }
    }
    return out;
  }

  // Thông tin chẩn đoán khi không tìm thấy dòng văn bản nào.
  function diagnose() {
    const docs = allDocs();
    const count = (sel) => docs.reduce((n, d) => n + d.querySelectorAll(sel).length, 0);
    let sample = '';
    for (const d of docs) {
      const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (KEY_RE.test(n.textContent) && /\d+\/[A-ZĐ]/.test(n.textContent)) {
          const path = [];
          for (let e = n.parentElement; e && e !== d.body && path.length < 7; e = e.parentElement) {
            path.push(e.tagName.toLowerCase() + (e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
          }
          sample = `"${n.textContent.trim().slice(0, 40)}" ← ${path.join(' < ')}`;
          break;
        }
      }
      if (sample) break;
    }
    let crossFrames = 0;
    document.querySelectorAll('iframe').forEach((f) => {
      try {
        void f.contentDocument.body;
      } catch (_) {
        crossFrames++;
      }
    });
    return `table=${count('table')} tr=${count('tr')} role=row:${count('[role="row"]')} iframe=${docs.length - 1}${crossFrames ? ` (+${crossFrames} khác nguồn)` : ''} dialog=${topDialog() ? 'có' : 'không'} | ${sample || 'không thấy số ký hiệu nào'}`;
  }

  // Văn bản chưa đọc: có chấm tròn màu ở đầu dòng hoặc chữ in đậm.
  function isUnread(tr) {
    const win = tr.ownerDocument.defaultView || window;
    const transparent = (c) => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    const nodes = tr.querySelectorAll('*');
    for (const el of nodes) {
      if (el.childElementCount) continue;
      const r = el.getBoundingClientRect();
      const st = win.getComputedStyle(el);
      if (r.width >= 4 && r.width <= 14 && Math.abs(r.width - r.height) <= 2 && !el.textContent.trim()) {
        if (!transparent(st.backgroundColor) && parseFloat(st.borderRadius) >= r.width / 2 - 1) return true;
      }
      const t = el.textContent.trim();
      if (/^[●•⬤]/.test(t)) return true;
      if (t.length > 15 && (parseInt(st.fontWeight, 10) >= 600 || st.fontWeight === 'bold')) return true;
    }
    // Chấm vẽ bằng ::before / ::after
    for (const el of nodes) {
      for (const pseudo of ['::before', '::after']) {
        const b = win.getComputedStyle(el, pseudo);
        if (b.content && b.content !== 'none' && parseFloat(b.width) <= 14 && parseFloat(b.borderRadius) > 2 && !transparent(b.backgroundColor)) return true;
      }
    }
    return false;
  }

  function listDocs() {
    return docRows().map(({ tr, key, text }) => ({ key, unread: isUnread(tr), text: text.slice(0, 400) }));
  }

  function clickEl(el) {
    el.scrollIntoView({ block: 'center' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    el.click();
  }

  function openDoc(key) {
    const row = docRows().find((r) => r.key === key);
    if (!row) throw new Error('Không thấy văn bản ' + key + ' trong danh sách.');
    // Bấm vào phần tử nhỏ nhất chứa số ký hiệu (thường là liên kết màu xanh).
    let target = null;
    for (const el of row.tr.querySelectorAll('a, span, div, b, strong, td')) {
      if ((el.innerText || '').includes(key) && isVisible(el)) {
        if (!target || target.contains(el)) target = el;
      }
    }
    clickEl(target || row.tr);
    return { ok: true };
  }

  function visibleByText(texts, scope = document) {
    const want = texts.map(norm);
    const found = [];
    for (const el of scope.querySelectorAll('a, button, li, span, div, p, [role="menuitem"], [role="tab"]')) {
      const t = norm(el.innerText);
      if (!t || t.length > 60 || !want.includes(t) || !isVisible(el)) continue;
      found.push(el);
    }
    // Bỏ phần tử nằm trong breadcrumb ("Văn bản đến / VB đã nhận"), ưu tiên phần tử sâu nhất, nằm bên trái (menu).
    const notCrumb = (el) => {
      for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
        const t = n.innerText || '';
        if (t.length < 80 && /\S\s*\/\s*\S/.test(t)) return false;
      }
      return true;
    };
    return found
      .filter((el) => notCrumb(el) && !found.some((o) => o !== el && el.contains(o)))
      .sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left);
  }

  const NAV = {
    den: [['văn bản đến'], ['vb đã nhận', 'văn bản đã nhận']],
    di: [['văn bản đi'], ['vb phát hành', 'văn bản phát hành', 'văn bản đã phát hành']],
    noi_bo: [['văn bản nội bộ'], ['vb nội bộ đã nhận', 'văn bản nội bộ đã nhận']]
  };

  async function gotoSection(loai) {
    const [parent, child] = NAV[loai] || NAV.den;
    let items = visibleByText(child);
    if (!items.length) {
      const p = visibleByText(parent).filter((el) => !el.closest(DIALOG_SEL) && !/\d/.test(el.innerText));
      if (!p.length) throw new Error('Không tìm thấy menu "' + parent[0] + '".');
      clickEl(p[0].closest('a, li, button, [role="menuitem"]') || p[0]);
      await sleep(700);
      items = visibleByText(child);
    }
    if (!items.length) throw new Error('Không tìm thấy mục "' + child[0] + '" trong menu.');
    clickEl(items[0].closest('a, button, [role="menuitem"]') || items[0]);
    return { ok: true };
  }

  async function loadAttachments(maxFiles = 10) {
    const dialog = topDialog();
    if (!dialog) return { clicked: 0 };
    // Nút danh sách file: có huy hiệu số (vd. biểu tượng nhiều lớp có số 6).
    const badges = [...dialog.querySelectorAll('span, sup, i, b, div')].filter((el) => {
      if (el.childElementCount || !/^\d{1,2}$/.test((el.textContent || '').trim()) || !isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width < 36 && r.height < 36 && !el.closest('table, .pagination, [class*="paginat"]');
    });
    const toggle = badges.map((b) => b.closest('button, a, [role="button"]') || b.parentElement).find(Boolean);
    if (!toggle) return { clicked: 0 };
    const FILE_NAME = /\.(pdf|docx?|xlsx?)\s*$/i;
    const openList = async () => {
      clickEl(toggle);
      await sleep(700);
      return [...document.querySelectorAll('a, li, span, div, td, p')].filter(
        (el) => el.childElementCount <= 2 && FILE_NAME.test(el.innerText || '') && (el.innerText || '').length < 250 && isVisible(el)
      );
    };
    let list = await openList();
    const names = [...new Set(list.map((el) => clean(el.innerText)))].slice(0, maxFiles);
    let clicked = 0;
    for (const name of names) {
      let el = list.find((x) => clean(x.innerText) === name && document.contains(x) && isVisible(x));
      if (!el) {
        list = await openList();
        el = list.find((x) => clean(x.innerText) === name);
      }
      if (!el) continue;
      const before = files.size;
      clickEl(el);
      clicked++;
      for (let i = 0; i < 16 && files.size === before; i++) await sleep(250);
      await sleep(400);
    }
    // Đóng danh sách nếu còn mở.
    if (list.some((x) => document.contains(x) && isVisible(x))) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { clicked, names };
  }

  async function closeDoc() {
    const dialog = topDialog();
    if (!dialog) return { ok: true };
    const btn =
      visibleByText(['đóng', 'close'], dialog)[0] ||
      [...dialog.querySelectorAll('button, a, span, i')].find(
        (el) => isVisible(el) && (/^[×✕x]$/i.test((el.textContent || '').trim()) || /close|dong/i.test((el.getAttribute('aria-label') || '') + ' ' + el.className))
      );
    if (btn) clickEl(btn.closest('button, a') || btn);
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    for (let i = 0; i < 20 && topDialog(); i++) await sleep(150);
    return { ok: !topDialog() };
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
          return { ok: true, rows: listRows(), loai: detectLoai(topDialog()).loai, breadcrumb: breadcrumb() };
        case 'fillOpinion':
          return fillOpinion(msg.text);
        case 'listDocs': {
          const { loai, breadcrumb: crumb } = detectLoai(topDialog());
          const docs = listDocs();
          return { ok: true, loai, breadcrumb: crumb, inDialog: !!topDialog(), docs, diag: docs.length ? '' : diagnose() };
        }
        case 'openDoc':
          return openDoc(msg.key);
        case 'loadAttachments':
          return { ok: true, ...(await loadAttachments(msg.max)) };
        case 'closeDoc':
          return closeDoc();
        case 'gotoSection':
          return gotoSection(msg.loai);
        default:
          throw new Error('Lệnh không hợp lệ: ' + msg.type);
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });
})();
