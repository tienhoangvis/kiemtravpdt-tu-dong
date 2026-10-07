// Chạy trong ngữ cảnh trang (MAIN world). Bắt các file văn bản (PDF/DOCX...) mà
// trang VPĐT tải về để hiển thị, rồi chuyển cho content script qua postMessage.
(() => {
  if (window.__vpdtHookInstalled) return;
  window.__vpdtHookInstalled = true;

  const MAX_BYTES = 40 * 1024 * 1024;
  const FILE_CT = /application\/(pdf|msword|vnd\.openxmlformats|vnd\.ms-|octet-stream|x-download|force-download)/i;
  const FILE_URL = /\.(pdf|docx?|xlsx?)(\?|#|$)/i;
  let authHeader = null;

  const post = (msg, transfer) => {
    try {
      window.postMessage({ __vpdt: true, ...msg }, '*', transfer || []);
    } catch (_) {}
  };

  function nameFrom(url, disposition) {
    if (disposition) {
      const m = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
      if (m) {
        try {
          return decodeURIComponent((m[1] || m[2]).trim());
        } catch (_) {
          return (m[1] || m[2]).trim();
        }
      }
    }
    try {
      const u = new URL(url, location.href);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      return last || u.hostname;
    } catch (_) {
      return 'file';
    }
  }

  function isFileMagic(buf) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return (
      (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) || // %PDF
      (b[0] === 0x50 && b[1] === 0x4b) || // PK (docx/xlsx)
      (b[0] === 0xd0 && b[1] === 0xcf) // .doc cũ
    );
  }

  function emitBuffer(buf, url, contentType, disposition, source) {
    if (!buf || buf.byteLength < 64 || buf.byteLength > MAX_BYTES) return;
    if (!isFileMagic(buf)) return;
    const copy = buf.slice(0);
    post(
      {
        type: 'file',
        url: String(url || ''),
        name: nameFrom(url, disposition),
        mime: contentType || '',
        source,
        bytes: copy
      },
      [copy]
    );
  }

  function b64ToBuf(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // Một số API trả file dưới dạng base64 trong JSON.
  function scanJsonForFiles(obj, url, depth = 0) {
    if (!obj || depth > 4) return;
    if (typeof obj === 'string') {
      if (obj.length > 1000 && /^(JVBERi|UEsDB|0M8R4)/.test(obj)) {
        try {
          emitBuffer(b64ToBuf(obj.replace(/\s/g, '')), url, '', '', 'json-base64');
        } catch (_) {}
      }
      return;
    }
    if (typeof obj === 'object') {
      for (const k in obj) scanJsonForFiles(obj[k], url, depth + 1);
    }
  }

  function maybeJson(text, url) {
    if (!text || text.length < 1000 || text.length > MAX_BYTES * 1.4) return;
    if (!/JVBERi|UEsDB|0M8R4/.test(text)) return;
    try {
      scanJsonForFiles(JSON.parse(text), url);
    } catch (_) {}
  }

  function rememberAuth(name, value) {
    if (name && /^authorization$/i.test(name) && value) authHeader = value;
  }

  // --- XMLHttpRequest ---
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const origSetHeader = XHR.setRequestHeader;

  XHR.open = function (method, url) {
    this.__vpdtUrl = url;
    return origOpen.apply(this, arguments);
  };
  XHR.setRequestHeader = function (name, value) {
    rememberAuth(name, value);
    return origSetHeader.apply(this, arguments);
  };
  XHR.send = function () {
    this.addEventListener('load', () => {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        const cd = this.getResponseHeader('content-disposition') || '';
        const url = this.responseURL || this.__vpdtUrl;
        const rt = this.responseType;
        if (rt === 'arraybuffer') {
          emitBuffer(this.response, url, ct, cd, 'xhr');
        } else if (rt === 'blob') {
          this.response && this.response.arrayBuffer().then((b) => emitBuffer(b, url, ct || this.response.type, cd, 'xhr'));
        } else if (rt === 'json') {
          scanJsonForFiles(this.response, url);
        } else if (rt === '' || rt === 'text') {
          if (/json/i.test(ct)) maybeJson(this.responseText, url);
        }
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  // --- fetch ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const h = (init && init.headers) || (input instanceof Request ? input.headers : null);
      if (h) {
        if (h instanceof Headers) rememberAuth('authorization', h.get('authorization'));
        else if (Array.isArray(h)) h.forEach(([k, v]) => rememberAuth(k, v));
        else for (const k in h) rememberAuth(k, h[k]);
      }
    } catch (_) {}
    const p = origFetch.apply(this, arguments);
    p.then((res) => {
      try {
        const ct = res.headers.get('content-type') || '';
        const cd = res.headers.get('content-disposition') || '';
        const len = Number(res.headers.get('content-length') || 0);
        if (len > MAX_BYTES) return;
        if (FILE_CT.test(ct) || /attachment/i.test(cd) || FILE_URL.test(res.url)) {
          res.clone().arrayBuffer().then((b) => emitBuffer(b, res.url, ct, cd, 'fetch'));
        } else if (/json/i.test(ct)) {
          res.clone().text().then((t) => maybeJson(t, res.url));
        }
      } catch (_) {}
    }).catch(() => {});
    return p;
  };

  // --- Blob URL (trình xem PDF thường dùng URL.createObjectURL) ---
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.apply(this, arguments);
    try {
      if (obj instanceof Blob && obj.size > 64 && obj.size <= MAX_BYTES) {
        obj.arrayBuffer().then((b) => emitBuffer(b, url, obj.type, '', 'blob'));
      }
    } catch (_) {}
    return url;
  };

  // --- Yêu cầu tải file từ content script (dùng cookie + token của trang) ---
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__vpdt !== true || d.type !== 'fetch-request') return;
    try {
      const headers = authHeader ? { Authorization: authHeader } : {};
      const res = await origFetch(d.url, { credentials: 'include', headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      post(
        {
          type: 'fetch-result',
          reqId: d.reqId,
          ok: true,
          url: res.url,
          name: nameFrom(res.url, res.headers.get('content-disposition')),
          mime: res.headers.get('content-type') || '',
          bytes: buf
        },
        [buf]
      );
    } catch (e) {
      post({ type: 'fetch-result', reqId: d.reqId, ok: false, error: String(e && e.message || e) });
    }
  });
})();
