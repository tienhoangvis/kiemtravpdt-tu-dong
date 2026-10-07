import { getSettings, saveSettings } from '../lib/settings.js';
import { originPattern, syncContentScripts, injectIntoTab } from '../lib/sites.js';
import { extractText, base64ToBytes, detectKind } from '../lib/extract.js';
import { chat, parseJson } from '../lib/deepseek.js';
import { analyzeMessages, triageMessages, LOAI_LABEL } from '../lib/prompts.js';
import { postToSheet } from '../lib/sheets.js';

const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 50;
const DRIVE_MAX_BYTES = 25 * 1024 * 1024;

const state = {
  settings: null,
  tab: null, // {id, url}
  connected: false,
  context: null,
  selected: new Set(),
  known: new Set(),
  localFiles: new Map(), // id -> {id, name, kind, size, bytes}
  textCache: new Map(), // key -> {text, warning}
  bytesCache: new Map(), // key -> Uint8Array
  docOpenedAt: 0,
  busy: false,
  abort: null,
  lastResult: null,
  lastMeta: null, // {loai, title, url, model, files: [file meta]}
  lastTriage: null
};

// ---------- Khởi tạo ----------
init();

async function init() {
  state.settings = await getSettings();
  $('autoAnalyze').checked = !!state.settings.autoAnalyze;
  updateKeyBox();

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('btnSettings').onclick = $('btnOpenSettings').onclick = () => chrome.runtime.openOptionsPage();
  $('btnConnect').onclick = connectSite;
  $('btnRefresh').onclick = () => refreshContext();
  $('btnClearFiles').onclick = clearFiles;
  $('fileInput').onchange = onUpload;
  $('autoAnalyze').onchange = (e) => saveSettings({ autoAnalyze: e.target.checked });
  $('btnAnalyze').onclick = () => analyze({ auto: false });
  $('btnStop').onclick = () => state.abort?.abort();
  $('btnCopy').onclick = copyOpinion;
  $('btnFill').onclick = fillOpinion;
  $('btnTriage').onclick = triage;
  $('btnExport').onclick = () => exportDocument();
  $('btnTriageExport').onclick = exportTriage;
  $('loaiSelect').onchange = renderFiles;
  $('btnClearHistory').onclick = async () => {
    await chrome.storage.local.set({ history: [] });
    renderHistory();
  };

  chrome.storage.onChanged.addListener(async () => {
    state.settings = await getSettings();
    $('autoAnalyze').checked = !!state.settings.autoAnalyze;
    updateKeyBox();
  });

  chrome.tabs.onActivated.addListener(() => updateTab());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === state.tab?.id && (info.status === 'complete' || info.url)) updateTab();
  });

  let filesTimer = null;
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!sender.tab || sender.tab.id !== state.tab?.id) return;
    if (msg.type === 'filesChanged') {
      clearTimeout(filesTimer);
      filesTimer = setTimeout(() => refreshContext(), 400);
    } else if (msg.type === 'docOpened') {
      state.docOpenedAt = Date.now() - 8000;
      state.selected.clear();
      state.known.clear();
      hide('result');
      refreshContext();
      if (state.settings.autoAnalyze) {
        // Chờ trình xem tải xong file rồi mới phân tích.
        setTimeout(() => analyze({ auto: true }), 3500);
      }
    }
  });

  await updateTab();
  renderHistory();
}

function updateKeyBox() {
  toggle('keyBox', !state.settings.apiKey);
  $('modelInfo').textContent = `DeepSeek · ${state.settings.model}`;
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((s) => toggle(s.id, s.id === 'tab-' + name));
  if (name === 'history') renderHistory();
}

// ---------- Kết nối với tab ----------
async function updateTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab ? { id: tab.id, url: tab.url || '' } : null;
  state.connected = false;
  if (!tab) return;
  try {
    const r = await send({ type: 'ping' });
    state.connected = !!r?.ok;
  } catch (_) {
    state.connected = false;
  }
  const httpPage = /^https?:/.test(state.tab.url);
  toggle('connectBox', !state.connected);
  $('btnConnect').classList.toggle('hidden', !httpPage);
  $('connectMsg').textContent = httpPage
    ? `Tiện ích chưa được bật trên ${new URL(state.tab.url).hostname}. Bấm để cho phép đọc trang Văn phòng điện tử này.`
    : 'Hãy mở trang Văn phòng điện tử (VPĐT) trong tab hiện tại.';
  if (state.connected) refreshContext();
}

function connectSite() {
  let pattern;
  try {
    pattern = originPattern(state.tab.url);
  } catch (e) {
    return setStatus('status', e.message, 'err');
  }
  // Phải gọi permissions.request ngay trong sự kiện click.
  chrome.permissions.request({ origins: [pattern] }, async (granted) => {
    if (!granted) return setStatus('status', 'Bạn chưa cấp quyền cho trang này.', 'err');
    const sites = [...new Set([...(state.settings.sites || []), pattern])];
    await saveSettings({ sites });
    state.settings.sites = sites;
    await syncContentScripts(sites);
    try {
      await injectIntoTab(state.tab.id);
    } catch (e) {
      console.warn(e);
    }
    setStatus('status', 'Đã bật. Nếu trình xem file đã mở từ trước, hãy tải lại trang (F5) để thu thập file đầy đủ.', 'ok');
    await updateTab();
  });
}

function send(msg) {
  if (!state.tab) return Promise.reject(new Error('Không có tab.'));
  return chrome.tabs.sendMessage(state.tab.id, { target: 'vpdt', ...msg }, { frameId: 0 });
}

async function call(msg) {
  const r = await send(msg);
  if (!r) throw new Error('Trang không phản hồi. Hãy tải lại trang VPĐT.');
  if (r.ok === false) throw new Error(r.error);
  return r;
}

// ---------- Ngữ cảnh văn bản & file ----------
async function refreshContext() {
  if (!state.connected) {
    renderFiles();
    return;
  }
  try {
    const { context } = await call({ type: 'getContext' });
    state.context = context;
  } catch (e) {
    state.context = null;
  }
  renderFiles();
}

function allFiles() {
  const remote = (state.context?.files || []).map((f) => ({ ...f, remote: true }));
  const local = [...state.localFiles.values()].map(({ bytes, ...f }) => ({ ...f, remote: false, time: Infinity }));
  return [...local, ...remote];
}

function renderFiles() {
  const ctx = state.context;
  $('docTitle').textContent = ctx?.docTitle || (ctx?.inDialog ? '(Hộp thoại đang mở)' : 'Chưa mở văn bản nào. Vào Văn bản đến → VB đã nhận và bấm vào một văn bản.');
  $('docTitle').classList.toggle('muted', !ctx?.docTitle);
  $('loaiDetected').textContent = ctx?.loai ? `(nhận diện: ${LOAI_LABEL[ctx.loai]})` : '';

  const list = allFiles();
  for (const f of list) {
    if (!state.known.has(f.id)) {
      state.known.add(f.id);
      if (!f.remote || f.time >= state.docOpenedAt) state.selected.add(f.id);
    }
  }
  $('fileCount').textContent = list.length;
  const ul = $('fileList');
  ul.replaceChildren();
  if (!list.length) {
    const li = el('li', 'muted', 'Chưa thu thập được file nào. Hãy mở văn bản / bấm "Xem file".');
    ul.append(li);
  }
  for (const f of list) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(f.id);
    cb.onchange = () => (cb.checked ? state.selected.add(f.id) : state.selected.delete(f.id));
    li.append(cb, el('span', 'name', f.name), el('span', 'meta', `${f.kind.toUpperCase()} · ${fmtSize(f.size)}${f.remote ? '' : ' · máy tính'}`));
    ul.append(li);
  }

  const links = ctx?.links || [];
  toggle('linksBox', links.length > 0);
  $('linkCount').textContent = links.length;
  const ll = $('linkList');
  ll.replaceChildren();
  for (const l of links) {
    const li = document.createElement('li');
    const btn = el('button', '', 'Lấy');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const { id } = await call({ type: 'fetchUrl', url: l.url });
        state.selected.add(id);
        state.known.add(id);
        await refreshContext();
      } catch (e) {
        setStatus('status', e.message, 'err');
        btn.disabled = false;
        btn.textContent = 'Lấy';
      }
    };
    li.append(el('span', 'name', l.label), btn);
    ll.append(li);
  }
}

async function clearFiles() {
  state.localFiles.clear();
  state.selected.clear();
  state.known.clear();
  state.textCache.clear();
  state.bytesCache.clear();
  if (state.connected) await call({ type: 'clearFiles' }).catch(() => {});
  await refreshContext();
}

async function onUpload(e) {
  for (const file of e.target.files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = 'u' + Date.now() + Math.random().toString(16).slice(2, 6);
    state.localFiles.set(id, { id, name: file.name, kind: detectKind(bytes, file.name), size: bytes.length, bytes });
  }
  e.target.value = '';
  renderFiles();
}

function fileKey(f) {
  return (f.remote ? `${state.tab.id}:` : '') + f.id;
}

async function fileBytes(f) {
  const key = fileKey(f);
  if (!state.bytesCache.has(key)) {
    const bytes = f.remote ? base64ToBytes((await call({ type: 'getFile', id: f.id })).base64) : state.localFiles.get(f.id).bytes;
    state.bytesCache.set(key, bytes);
  }
  return state.bytesCache.get(key);
}

async function fileText(f) {
  const key = fileKey(f);
  if (state.textCache.has(key)) return state.textCache.get(key);
  // pdf.js chiếm quyền sở hữu bộ đệm, nên truyền bản sao.
  const bytes = (await fileBytes(f)).slice();
  const out = await extractText(bytes, { name: f.name, kind: f.kind, maxPdfPages: state.settings.maxPdfPages });
  state.textCache.set(key, out);
  return out;
}

// ---------- Phân tích văn bản ----------
async function analyze({ auto }) {
  if (state.busy) return;
  if (!state.settings.apiKey) return setStatus('status', 'Chưa nhập DeepSeek API key (bấm ⚙ Cài đặt).', 'err');
  setBusy(true);
  try {
    if (state.connected) await refreshContext();
    const ctx = state.context || {};
    const loai = currentLoai();
    const chosen = allFiles().filter((f) => state.selected.has(f.id));

    if (!ctx.docTitle && !chosen.length && !ctx.viewerText) {
      if (auto) return setStatus('status', '');
      throw new Error('Chưa có nội dung để đọc. Hãy mở một văn bản trên VPĐT hoặc thêm file từ máy tính.');
    }

    const key = ctx.docTitle || chosen.map((f) => f.name).join(', ') || 'Văn bản';
    if (auto && state.settings.useCache) {
      const hit = (await loadHistory()).find((h) => h.key === key);
      if (hit) {
        state.lastMeta = hit.meta || null;
        render(hit.result, hit.raw);
        return setStatus('status', 'Đã có kết quả phân tích trước đó (từ lịch sử). Bấm "Đọc & phân tích" để chạy lại.', 'ok');
      }
    }

    const docFiles = [];
    const warnings = [];
    for (const [i, f] of chosen.entries()) {
      setStatus('status', spin(`Đang đọc file ${i + 1}/${chosen.length}: ${f.name}`));
      try {
        const { text, warning } = await fileText(f);
        docFiles.push({ name: f.name, text, warning });
        if (warning) warnings.push(`${f.name}: ${warning}`);
      } catch (e) {
        warnings.push(`${f.name}: ${e.message}`);
      }
    }

    const messages = analyzeMessages(state.settings, {
      loai,
      breadcrumb: ctx.breadcrumb,
      docTitle: ctx.docTitle,
      pageText: ctx.pageText,
      viewerText: ctx.viewerText,
      files: docFiles
    });
    setStatus('status', spin(`Đang gửi cho DeepSeek (${state.settings.model})…`));
    state.abort = new AbortController();
    const { content, usage, model } = await chat(state.settings, messages, { signal: state.abort.signal });
    const result = parseJson(content);
    state.lastMeta = {
      loai,
      title: ctx.docTitle || key,
      url: ctx.url || '',
      model: model || state.settings.model,
      files: chosen.map(({ id, name, kind, size, remote }) => ({ id, name, kind, size, remote }))
    };
    render(result, content);
    hide('exportStatus');
    await saveHistory({ key, title: ctx.docTitle || key, time: Date.now(), result, raw: content, meta: { ...state.lastMeta, files: [] } });

    const tokens = usage ? ` · ${usage.total_tokens} token` : '';
    setStatus('status', `✔ Hoàn tất${tokens}.${warnings.length ? '\n⚠ ' + warnings.join('\n⚠ ') : ''}`, warnings.length ? '' : 'ok');
    if (result && state.settings.autoExport && state.settings.sheetUrl) await exportDocument();
  } catch (e) {
    setStatus('status', '✖ ' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  state.busy = b;
  $('btnAnalyze').disabled = b;
  $('btnTriage').disabled = b;
  toggle('btnStop', b);
  if (!b) state.abort = null;
}

function render(r, raw) {
  state.lastResult = r;
  show('result');
  $('raw').textContent = raw || '';
  if (!r) {
    $('opinion').value = '';
    $('summary').textContent = 'AI không trả về đúng định dạng JSON, xem "Phản hồi gốc" bên dưới.';
    ['pointsCard', 'tasksCard', 'attCard', 'noteCard'].forEach((id) => hide(id));
    $('meta').replaceChildren();
    return;
  }
  $('opinion').value = r.y_kien_xu_ly || '';
  setPriority($('priority'), r.muc_do_uu_tien);
  $('summary').textContent = r.tom_tat || '';

  const meta = [
    ['Số ký hiệu', r.so_ky_hieu],
    ['Ngày văn bản', r.ngay_van_ban],
    ['Cơ quan ban hành', r.co_quan_ban_hanh],
    ['Loại văn bản', r.loai_van_ban],
    ['Trích yếu', r.trich_yeu],
    ['Độ khẩn', r.do_khan],
    ['Hạn xử lý', r.han_xu_ly],
    ['Hướng xử lý', r.huong_xu_ly]
  ].filter(([, v]) => v);
  $('meta').replaceChildren(...meta.map(([k, v]) => {
    const tr = document.createElement('tr');
    tr.append(el('td', '', k), el('td', '', String(v)));
    return tr;
  }));

  fillList('points', 'pointsCard', (r.noi_dung_chinh || []).map(String));
  fillList('tasks', 'tasksCard', (r.nhiem_vu || []).map((t) =>
    typeof t === 'string' ? t : [t.viec, t.han && `Hạn: ${t.han}`, t.don_vi_de_xuat && `→ ${t.don_vi_de_xuat}`].filter(Boolean).join(' · ')
  ));
  fillList('attachments', 'attCard', (r.file_dinh_kem || []).map((a) =>
    typeof a === 'string' ? a : `${a.ten || ''}: ${a.tom_tat || ''}`
  ));
  $('note').textContent = r.luu_y || '';
  toggle('noteCard', !!r.luu_y);
}

function fillList(listId, cardId, items) {
  $(listId).replaceChildren(...items.filter(Boolean).map((t) => el('li', '', t)));
  toggle(cardId, items.length > 0);
}

function setPriority(node, p) {
  node.textContent = p ? `Ưu tiên: ${p}` : '';
  node.className = 'pill ' + priorityClass(p);
  node.classList.toggle('hidden', !p);
}

function priorityClass(p = '') {
  const s = p.toLowerCase();
  if (s.includes('cao')) return 'cao';
  if (s.includes('trung')) return 'trung';
  if (s.includes('thấp') || s.includes('thap')) return 'thap';
  return '';
}

async function copyOpinion() {
  await navigator.clipboard.writeText($('opinion').value);
  setStatus('status', 'Đã sao chép ý kiến xử lý.', 'ok');
}

async function fillOpinion() {
  try {
    await call({ type: 'fillOpinion', text: $('opinion').value });
    setStatus('status', 'Đã điền vào ô nhập. Vui lòng kiểm tra lại trước khi gửi.', 'ok');
  } catch (e) {
    setStatus('status', e.message, 'err');
  }
}

// ---------- Rà soát danh sách ----------
async function triage() {
  if (state.busy) return;
  if (!state.settings.apiKey) return setStatus('triageStatus', 'Chưa nhập DeepSeek API key (bấm ⚙ Cài đặt).', 'err');
  setBusy(true);
  try {
    const { rows, loai: detected } = await call({ type: 'getListRows' });
    const sel = $('loaiSelect').value;
    const loai = sel === 'auto' ? detected || 'den' : sel;
    if (!rows.length) throw new Error('Không tìm thấy bảng danh sách văn bản trên trang.');
    setStatus('triageStatus', spin(`Đang gửi ${rows.length} dòng cho DeepSeek…`));
    state.abort = new AbortController();
    const { content } = await chat(state.settings, triageMessages(state.settings, rows, loai), { signal: state.abort.signal });
    const r = parseJson(content);
    if (!r) throw new Error('AI không trả về đúng định dạng.\n' + content.slice(0, 500));
    state.lastTriage = { loai, overview: r.tong_quan || '', items: r.van_ban || [] };
    renderTriage(r);
    hide('triageExportStatus');
    setStatus('triageStatus', `✔ Đã rà soát ${rows.length} ${LOAI_LABEL[loai].toLowerCase()}.`, 'ok');
    if (state.settings.autoExport && state.settings.sheetUrl) await exportTriage();
  } catch (e) {
    setStatus('triageStatus', '✖ ' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

function renderTriage(r) {
  show('triageResult');
  $('triageOverview').textContent = r.tong_quan || '';
  $('triageItems').replaceChildren(...(r.van_ban || []).map((v) => {
    const card = el('div', 'card tri ' + priorityClass(v.muc_do_uu_tien));
    const head = el('div', 'head');
    head.append(el('strong', '', v.so_ky_hieu || `#${v.stt}`));
    const pill = el('span', 'pill');
    setPriority(pill, v.muc_do_uu_tien);
    head.append(pill);
    card.append(head, el('div', '', v.trich_yeu || ''), el('div', 'muted', [v.noi_ban_hanh, v.huong_xu_ly].filter(Boolean).join(' · ')));
    if (v.y_kien_so_bo) card.append(el('div', 'op', v.y_kien_so_bo));
    return card;
  }));
}

// ---------- Xuất Google Sheet / Drive ----------
function currentLoai() {
  const sel = $('loaiSelect').value;
  return sel === 'auto' ? state.context?.loai || 'den' : sel;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  txt: 'text/plain'
};

async function exportDocument() {
  const meta = state.lastMeta;
  if (!state.lastResult || !meta) return setStatus('exportStatus', 'Chưa có kết quả phân tích để xuất.', 'err');
  if (!state.settings.sheetUrl) return setStatus('exportStatus', 'Chưa cấu hình Google Sheet (bấm ⚙ Cài đặt).', 'err');
  $('btnExport').disabled = true;
  try {
    // Lấy ý kiến xử lý đã sửa trong ô nhập.
    const record = { ...state.lastResult, y_kien_xu_ly: $('opinion').value };
    const files = [];
    const skipped = [];
    if (state.settings.saveFilesToDrive) {
      let total = 0;
      for (const f of meta.files || []) {
        try {
          const bytes = await fileBytes(f);
          if (total + bytes.length > DRIVE_MAX_BYTES) {
            skipped.push(`${f.name} (quá lớn)`);
            continue;
          }
          total += bytes.length;
          files.push({ name: f.name, mime: MIME[f.kind] || 'application/octet-stream', base64: bytesToBase64(bytes) });
        } catch (e) {
          skipped.push(`${f.name} (${e.message})`);
        }
      }
    }
    setStatus('exportStatus', spin(`Đang ghi Google Sheet${files.length ? ` và lưu ${files.length} file lên Drive` : ''}…`));
    const r = await postToSheet(state.settings, {
      action: 'document',
      loai: meta.loai,
      title: meta.title,
      url: meta.url,
      model: meta.model,
      record,
      files
    });
    const box = $('exportStatus');
    box.className = 'status ok';
    const a = el('a', '', 'Mở Google Sheet');
    a.href = r.sheetUrl;
    a.target = '_blank';
    box.replaceChildren(
      `✔ Đã ${r.updated ? 'cập nhật' : 'thêm'} dòng ${r.row} – trang "${r.sheetName}"` +
        (r.files?.length ? `, lưu ${r.files.length} file lên Drive` : '') +
        (skipped.length ? `.\n⚠ Không lưu: ${skipped.join(', ')}` : '') + '. ',
      a
    );
    show('exportStatus');
  } catch (e) {
    setStatus('exportStatus', '✖ ' + e.message, 'err');
  } finally {
    $('btnExport').disabled = false;
  }
}

async function exportTriage() {
  const t = state.lastTriage;
  if (!t) return;
  if (!state.settings.sheetUrl) return setStatus('triageExportStatus', 'Chưa cấu hình Google Sheet (bấm ⚙ Cài đặt).', 'err');
  $('btnTriageExport').disabled = true;
  try {
    setStatus('triageExportStatus', spin('Đang ghi Google Sheet…'));
    const r = await postToSheet(state.settings, { action: 'triage', loai: t.loai, overview: t.overview, items: t.items });
    const box = $('triageExportStatus');
    box.className = 'status ok';
    const a = el('a', '', 'Mở Google Sheet');
    a.href = r.sheetUrl;
    a.target = '_blank';
    box.replaceChildren(`✔ Đã ghi ${r.count} dòng vào trang "${r.sheetName}". `, a);
    show('triageExportStatus');
  } catch (e) {
    setStatus('triageExportStatus', '✖ ' + e.message, 'err');
  } finally {
    $('btnTriageExport').disabled = false;
  }
}

// ---------- Lịch sử ----------
async function loadHistory() {
  const { history } = await chrome.storage.local.get({ history: [] });
  return history;
}

async function saveHistory(item) {
  const history = (await loadHistory()).filter((h) => h.key !== item.key);
  history.unshift(item);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

async function renderHistory() {
  const history = await loadHistory();
  const ul = $('historyList');
  ul.replaceChildren();
  if (!history.length) ul.append(el('li', 'muted', 'Chưa có lịch sử.'));
  for (const h of history) {
    const li = document.createElement('li');
    li.append(el('div', '', h.title), el('time', '', new Date(h.time).toLocaleString('vi-VN')));
    if (h.result?.y_kien_xu_ly) li.append(el('div', 'muted', h.result.y_kien_xu_ly));
    li.onclick = () => {
      showTab('doc');
      state.lastMeta = h.meta || { loai: 'den', title: h.title, url: '', model: '', files: [] };
      hide('exportStatus');
      render(h.result, h.raw);
    };
    ul.append(li);
  }
}

// ---------- Tiện ích giao diện ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function toggle(id, on) {
  $(id).classList.toggle('hidden', !on);
}
function show(id) {
  toggle(id, true);
}
function hide(id) {
  toggle(id, false);
}
function spin(text) {
  return { spin: true, text };
}
function setStatus(id, msg, kind = '') {
  const box = $(id);
  if (!msg) return hide(id);
  show(id);
  box.className = 'status ' + kind;
  if (typeof msg === 'object' && msg.spin) {
    box.replaceChildren(el('span', 'spinner'), document.createTextNode(msg.text));
  } else {
    box.textContent = msg;
  }
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
