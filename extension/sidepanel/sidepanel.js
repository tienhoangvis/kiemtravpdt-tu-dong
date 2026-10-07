import { getSettings, saveSettings } from '../lib/settings.js';
import { originPattern, syncContentScripts, injectIntoTab } from '../lib/sites.js';
import { extractText, base64ToBytes, detectKind } from '../lib/extract.js';
import { chat, parseJson } from '../lib/deepseek.js';
import { analyzeMessages, triageMessages, reportMessages, LOAI_LABEL } from '../lib/prompts.js';
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
  lastTriage: null,
  batch: null // {running, stop, tabId, timer, items}
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
  initBatch();
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
    if (state.batch?.running) return; // chế độ tự động tự điều khiển
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

function workTabId() {
  return state.batch?.running ? state.batch.tabId : state.tab?.id;
}

function send(msg) {
  const tabId = workTabId();
  if (!tabId) return Promise.reject(new Error('Không có tab.'));
  return chrome.tabs.sendMessage(tabId, { target: 'vpdt', ...msg }, { frameId: 0 });
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
  return (f.remote ? `${workTabId()}:` : '') + f.id;
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

    state.abort = new AbortController();
    const { result, content, usage, warnings, meta } = await analyzeCore({
      ctx,
      loai,
      key,
      files: chosen,
      signal: state.abort.signal,
      progress: (t) => setStatus('status', spin(t))
    });
    state.lastMeta = meta;
    render(result, content);
    hide('exportStatus');
    await saveHistory({ key, title: meta.title, time: Date.now(), result, raw: content, meta: { ...meta, files: [] } });

    const tokens = usage ? ` · ${usage.total_tokens} token` : '';
    setStatus('status', `✔ Hoàn tất${tokens}.${warnings.length ? '\n⚠ ' + warnings.join('\n⚠ ') : ''}`, warnings.length ? '' : 'ok');
    if (result && state.settings.autoExport && state.settings.sheetUrl) await exportDocument();
  } catch (e) {
    setStatus('status', '✖ ' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

// Đọc file + gọi DeepSeek cho một văn bản. Dùng chung cho phân tích thủ công và tự động.
async function analyzeCore({ ctx, loai, key, files, signal, progress = () => {} }) {
  const docFiles = [];
  const warnings = [];
  for (const [i, f] of files.entries()) {
    progress(`Đang đọc file ${i + 1}/${files.length}: ${f.name}`);
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
  progress(`Đang gửi cho DeepSeek (${state.settings.model})…`);
  const { content, usage, model } = await chat(state.settings, messages, { signal });
  const result = parseJson(content);
  const meta = {
    loai,
    title: ctx.docTitle || key,
    url: ctx.url || '',
    model: model || state.settings.model,
    files: files.map(({ id, name, kind, size, remote }) => ({ id, name, kind, size, remote }))
  };
  return { result, content, usage, warnings, meta };
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
    const { r, skipped } = await exportCore(meta, record, (t) => setStatus('exportStatus', spin(t)));
    const box = $('exportStatus');
    box.className = 'status ok';
    box.replaceChildren(exportSummary(r, skipped) + ' ', sheetLink(r.sheetUrl));
    show('exportStatus');
  } catch (e) {
    setStatus('exportStatus', '✖ ' + e.message, 'err');
  } finally {
    $('btnExport').disabled = false;
  }
}

async function exportCore(meta, record, progress = () => {}) {
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
  progress(`Đang ghi Google Sheet${files.length ? ` và lưu ${files.length} file lên Drive` : ''}…`);
  const r = await postToSheet(state.settings, {
    action: 'document',
    loai: meta.loai,
    title: meta.title,
    url: meta.url,
    model: meta.model,
    record,
    files
  });
  return { r, skipped };
}

function exportSummary(r, skipped = []) {
  return (
    `✔ Đã ${r.updated ? 'cập nhật' : 'thêm'} dòng ${r.row} – trang "${r.sheetName}"` +
    (r.files?.length ? `, lưu ${r.files.length} file lên Drive` : '') +
    (skipped.length ? `.\n⚠ Không lưu: ${skipped.join(', ')}` : '') +
    '.'
  );
}

function sheetLink(url) {
  const a = el('a', '', 'Mở Google Sheet');
  a.href = url;
  a.target = '_blank';
  return a;
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

// ---------- Kiểm tra tự động văn bản chưa đọc ----------
const SECTION_CRUMB = { den: /vb đã nhận|văn bản đã nhận/i, di: /phát hành/i, noi_bo: /nội bộ đã nhận/i };
const SECTION_NAME = {
  den: 'Văn bản đến → VB đã nhận',
  di: 'Văn bản đi → VB phát hành',
  noi_bo: 'Văn bản nội bộ → VB nội bộ đã nhận'
};
const PROCESSED_MAX = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function initBatch() {
  const b = state.settings.batch || {};
  document.querySelectorAll('#tab-batch [data-sec]').forEach((cb) => (cb.checked = (b.sections || ['den', 'di', 'noi_bo']).includes(cb.dataset.sec)));
  $('bScope').value = b.scope || 'unread';
  $('bMax').value = b.max || 20;
  $('bAttach').checked = b.attach !== false;
  $('bSkip').checked = b.skip !== false;
  $('bExport').checked = b.export !== false;
  $('bRepeat').checked = !!b.repeat;
  $('bRepeatMin').value = b.repeatMin || 30;
  $('btnBatchStart').onclick = () => runBatch();
  $('btnBatchStop').onclick = stopBatch;
  $('btnResetProcessed').onclick = async () => {
    await chrome.storage.local.set({ processed: {} });
    batchStatus('Đã xoá danh sách văn bản đã kiểm tra. Lần chạy sau sẽ kiểm tra lại từ đầu.', 'ok');
  };
}

function batchOptions() {
  return {
    sections: [...document.querySelectorAll('#tab-batch [data-sec]')].filter((c) => c.checked).map((c) => c.dataset.sec),
    scope: $('bScope').value,
    max: Math.max(1, Math.min(200, Number($('bMax').value) || 20)),
    attach: $('bAttach').checked,
    skip: $('bSkip').checked,
    export: $('bExport').checked,
    repeat: $('bRepeat').checked,
    repeatMin: Math.max(5, Number($('bRepeatMin').value) || 30)
  };
}

function batchStatus(msg, kind = '') {
  setStatus('batchStatus', msg, kind);
}

function batchLog(text, kind = '') {
  const li = el('li', kind, `${new Date().toLocaleTimeString('vi-VN')}  ${text}`);
  $('batchLog').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

function stopBatch() {
  if (state.batch) {
    state.batch.stop = true;
    clearTimeout(state.batch.timer);
    state.abort?.abort();
  }
  if (!state.batch?.running) {
    state.batch = null;
    toggle('btnBatchStop', false);
    batchStatus('Đã dừng kiểm tra tự động.', '');
  }
}

async function waitFor(fn, { timeout = 15000, interval = 500 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    if (state.batch?.stop) throw new Error('Đã dừng.');
    try {
      last = await fn();
      if (last) return last;
    } catch (_) {}
    await sleep(interval);
  }
  return null;
}

async function ensureSection(loai) {
  const here = await waitFor(() => call({ type: 'listDocs' }), { timeout: 20000 });
  if (!here) throw new Error('Trang VPĐT không phản hồi. Hãy tải lại trang (F5) rồi chạy lại.');
  if (here.inDialog) await call({ type: 'closeDoc' }).catch(() => {});
  if (here.loai === loai && SECTION_CRUMB[loai].test(here.breadcrumb || '')) return here;
  await call({ type: 'gotoSection', loai });
  const t0 = Date.now();
  const ok = await waitFor(
    async () => {
      const r = await call({ type: 'listDocs' });
      const arrived = r.loai === loai && SECTION_CRUMB[loai].test(r.breadcrumb || '');
      // Đợi bảng tải xong (hoặc tối đa 5 giây nếu danh sách trống).
      return arrived && (r.docs.length || Date.now() - t0 > 5000) ? r : null;
    },
    { timeout: 25000 }
  );
  if (!ok) throw new Error(`Không mở được mục ${SECTION_NAME[loai]}. Hãy mở mục này bằng tay rồi chạy lại.`);
  await sleep(800);
  return call({ type: 'listDocs' });
}

async function processDoc(loai, doc, opts) {
  await call({ type: 'clearFiles' });
  state.textCache.clear();
  state.bytesCache.clear();
  await call({ type: 'openDoc', key: doc.key });

  const opened = await waitFor(async () => {
    const { context } = await call({ type: 'getContext' });
    return context.inDialog && context.docTitle ? context : null;
  });
  if (!opened) throw new Error('Không mở được văn bản (không thấy cửa sổ "Xem:").');

  // Chờ trình xem tải file chính.
  await waitFor(async () => (await call({ type: 'getContext' })).context.files.length > 0, { timeout: 12000 });
  if (opts.attach) {
    batchStatus(spin(`${doc.key}: đang mở các file đính kèm…`));
    const r = await call({ type: 'loadAttachments', max: 10 }).catch(() => null);
    if (r?.clicked) await sleep(1000);
  }
  const { context: ctx } = await call({ type: 'getContext' });
  const files = (ctx.files || []).map((f) => ({ ...f, remote: true }));

  state.abort = new AbortController();
  const out = await analyzeCore({
    ctx,
    loai,
    key: doc.key,
    files,
    signal: state.abort.signal,
    progress: (t) => batchStatus(spin(`${doc.key}: ${t}`))
  });
  const item = { loai, key: doc.key, title: ctx.docTitle, ...out, exported: '' };
  await saveHistory({ key: ctx.docTitle || doc.key, title: ctx.docTitle || doc.key, time: Date.now(), result: out.result, raw: out.content, meta: { ...out.meta, files: [] } });

  if (opts.export && state.settings.sheetUrl && out.result) {
    try {
      const { r, skipped } = await exportCore(out.meta, out.result, (t) => batchStatus(spin(`${doc.key}: ${t}`)));
      item.exported = exportSummary(r, skipped);
      item.sheetUrl = r.sheetUrl;
    } catch (e) {
      item.exported = '✖ ' + e.message;
    }
  }
  await call({ type: 'closeDoc' }).catch(() => {});
  await sleep(700);
  return item;
}

async function runBatch() {
  if (state.busy) return;
  if (!state.settings.apiKey) return batchStatus('Chưa nhập DeepSeek API key (bấm ⚙ Cài đặt).', 'err');
  if (!state.connected) return batchStatus('Tiện ích chưa được bật trên trang VPĐT (xem thông báo phía trên).', 'err');
  const opts = batchOptions();
  if (!opts.sections.length) return batchStatus('Hãy chọn ít nhất một mục để kiểm tra.', 'err');
  await saveSettings({ batch: opts });

  clearTimeout(state.batch?.timer);
  state.batch = { running: true, stop: false, tabId: state.tab.id, timer: null, items: [] };
  setBusy(true);
  $('btnBatchStart').disabled = true;
  show('btnBatchStop');
  $('batchLog').replaceChildren();
  $('batchItems').replaceChildren();
  hide('batchReport');

  const { processed = {} } = await chrome.storage.local.get({ processed: {} });
  const items = state.batch.items;
  let errors = 0;
  try {
    for (const loai of opts.sections) {
      if (state.batch.stop) break;
      batchStatus(spin(`Đang mở ${SECTION_NAME[loai]}…`));
      batchLog(`📂 ${SECTION_NAME[loai]}`);
      let list;
      try {
        list = await ensureSection(loai);
      } catch (e) {
        errors++;
        batchLog(`✖ ${e.message}`, 'err');
        continue;
      }
      const all = list.docs || [];
      const unread = all.filter((d) => d.unread);
      let todo = opts.scope === 'unread' ? unread : all;
      const before = todo.length;
      if (opts.skip) todo = todo.filter((d) => !processed[`${loai}|${d.key}`]);
      todo = todo.slice(0, opts.max);
      batchLog(
        `   Danh sách có ${all.length} văn bản, ${unread.length} chưa đọc` +
          (before !== todo.length ? `; bỏ qua ${before - todo.length} đã kiểm tra/vượt giới hạn` : '') +
          `. Sẽ kiểm tra ${todo.length}.`
      );
      if (opts.scope === 'unread' && all.length && !unread.length) {
        batchLog('   (Không nhận ra văn bản chưa đọc. Nếu thực tế còn, hãy chọn phạm vi "Tất cả văn bản trên trang".)', 'muted');
      }
      for (const [i, d] of todo.entries()) {
        if (state.batch.stop) break;
        batchStatus(spin(`${SECTION_NAME[loai]} – ${i + 1}/${todo.length}: ${d.key}`));
        try {
          const item = await processDoc(loai, d, opts);
          items.push(item);
          processed[`${loai}|${d.key}`] = Date.now();
          renderBatchItem(item);
          batchLog(`   ✔ ${d.key}${item.result?.muc_do_uu_tien ? ` – ưu tiên ${item.result.muc_do_uu_tien}` : ''}`, 'ok');
        } catch (e) {
          if (state.batch.stop) break;
          errors++;
          batchLog(`   ✖ ${d.key}: ${e.message}`, 'err');
          await call({ type: 'closeDoc' }).catch(() => {});
          await sleep(500);
        }
      }
      // Ghi lại sau mỗi mục để không mất tiến độ nếu bị dừng giữa chừng.
      const keys = Object.keys(processed);
      if (keys.length > PROCESSED_MAX) keys.sort((a, b) => processed[a] - processed[b]).slice(0, keys.length - PROCESSED_MAX).forEach((k) => delete processed[k]);
      await chrome.storage.local.set({ processed });
    }

    if (items.length && !state.batch.stop) {
      batchStatus(spin(`Đang lập báo cáo tổng hợp ${items.length} văn bản…`));
      try {
        state.abort = new AbortController();
        const { content } = await chat(state.settings, reportMessages(state.settings, items), { signal: state.abort.signal });
        const report = parseJson(content);
        renderReport(report, content);
        if (opts.export && state.settings.sheetUrl && report) {
          const r = await postToSheet(state.settings, {
            action: 'report',
            scope: opts.sections.map((x) => LOAI_LABEL[x]).join(', '),
            report,
            docs: items.map((it) => ({ so: LOAI_LABEL[it.loai], key: it.key, trich_yeu: it.result?.trich_yeu || it.title }))
          }).catch((e) => ({ error: e.message }));
          $('reportExport').replaceChildren(r.error ? '✖ ' + r.error : `✔ Đã ghi báo cáo vào trang "${r.sheetName}". `, ...(r.sheetUrl ? [sheetLink(r.sheetUrl)] : []));
        }
      } catch (e) {
        batchLog(`✖ Không lập được báo cáo tổng hợp: ${e.message}`, 'err');
      }
    }

    const summary = state.batch.stop
      ? `Đã dừng. Đã kiểm tra ${items.length} văn bản.`
      : `✔ Hoàn tất: kiểm tra ${items.length} văn bản${errors ? `, ${errors} lỗi` : ''}.`;
    batchStatus(summary, state.batch.stop ? '' : errors ? '' : 'ok');
    notify('Kiểm tra VPĐT tự động', items.length ? `${summary} Mở side panel để xem tóm tắt và khuyến nghị.` : summary);
  } finally {
    const repeat = opts.repeat && !state.batch.stop;
    state.batch.running = false;
    setBusy(false);
    $('btnBatchStart').disabled = false;
    if (repeat) {
      const at = new Date(Date.now() + opts.repeatMin * 60000);
      state.batch.timer = setTimeout(() => runBatch(), opts.repeatMin * 60000);
      batchLog(`⏱ Lần kiểm tra tiếp theo lúc ${at.toLocaleTimeString('vi-VN')} (giữ side panel và tab VPĐT mở).`);
    } else {
      hide('btnBatchStop');
      state.batch = null;
    }
  }
}

function renderBatchItem(it) {
  const r = it.result || {};
  const card = el('div', 'card tri ' + priorityClass(r.muc_do_uu_tien));
  const head = el('div', 'head');
  head.append(el('strong', '', `${r.so_ky_hieu || it.key}`));
  const pill = el('span', 'pill');
  setPriority(pill, r.muc_do_uu_tien);
  head.append(pill);
  card.append(head, el('div', 'muted', [LOAI_LABEL[it.loai], r.co_quan_ban_hanh, r.han_xu_ly && `Hạn: ${r.han_xu_ly}`].filter(Boolean).join(' · ')));
  if (r.trich_yeu) card.append(el('div', '', r.trich_yeu));
  card.append(el('p', '', r.tom_tat || (it.result ? '' : 'AI không trả về đúng định dạng.')));
  if (r.y_kien_xu_ly) card.append(el('div', 'op', '✍ ' + r.y_kien_xu_ly));
  if (it.warnings?.length) card.append(el('div', 'hint', '⚠ ' + it.warnings.join('; ')));
  if (it.exported) {
    const ex = el('div', 'hint', it.exported + ' ');
    if (it.sheetUrl) ex.append(sheetLink(it.sheetUrl));
    card.append(ex);
  }
  const open = el('button', 'link', 'Xem chi tiết →');
  open.onclick = () => {
    showTab('doc');
    state.lastMeta = { ...it.meta, files: [] };
    hide('exportStatus');
    render(it.result, it.content);
  };
  card.append(open);
  $('batchItems').append(card);
}

function renderReport(r, raw) {
  show('batchReport');
  $('reportExport').replaceChildren();
  if (!r) {
    $('reportOverview').textContent = raw || '';
    ['reportUrgent', 'reportRecs', 'reportDeadlines', 'reportBySo'].forEach((id) => $(id).replaceChildren());
    return;
  }
  $('reportOverview').textContent = r.tong_quan || '';
  const fill = (id, arr, fmt) => {
    $(id).replaceChildren(...(arr || []).map((x) => el('li', '', fmt(x))));
    toggle(id + 'Box', (arr || []).length > 0);
  };
  fill('reportUrgent', r.can_xu_ly_ngay, (x) => (typeof x === 'string' ? x : [x.so_ky_hieu, x.so_van_ban, x.ly_do, x.han && `Hạn: ${x.han}`].filter(Boolean).join(' – ')));
  fill('reportRecs', r.khuyen_nghi, (x) => String(x));
  fill('reportDeadlines', r.moc_thoi_han, (x) => (typeof x === 'string' ? x : [x.han, x.viec, x.so_ky_hieu].filter(Boolean).join(' – ')));
  const so = r.theo_so || {};
  fill('reportBySo', Object.entries(so).filter(([, v]) => v), ([k, v]) => `${LOAI_LABEL[k] || k}: ${v}`);
}

function notify(title, message) {
  try {
    chrome.notifications?.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message });
  } catch (_) {}
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
