import { getSettings, saveSettings } from '../lib/settings.js';
import { syncContentScripts } from '../lib/sites.js';
import { chat } from '../lib/deepseek.js';
import { postToSheet } from '../lib/sheets.js';

const $ = (id) => document.getElementById(id);
const TEXT = ['apiKey', 'model', 'baseUrl', 'orgName', 'userRole', 'departments', 'customInstructions', 'sheetUrl', 'sheetToken'];
const NUM = ['temperature', 'maxChars', 'maxPdfPages'];
const BOOL = ['autoAnalyze', 'useCache', 'autoExport', 'saveFilesToDrive'];

let settings;

async function load() {
  settings = await getSettings();
  TEXT.forEach((k) => ($(k).value = settings[k] ?? ''));
  NUM.forEach((k) => ($(k).value = settings[k]));
  BOOL.forEach((k) => ($(k).checked = !!settings[k]));
  renderSites();
}

function collect() {
  const out = {};
  TEXT.forEach((k) => (out[k] = $(k).value.trim()));
  NUM.forEach((k) => (out[k] = Number($(k).value)));
  BOOL.forEach((k) => (out[k] = $(k).checked));
  if (!out.baseUrl) out.baseUrl = 'https://api.deepseek.com';
  if (!out.model) out.model = 'deepseek-chat';
  return out;
}

function renderSites() {
  const ul = $('sites');
  ul.replaceChildren();
  if (!settings.sites.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Chưa có trang nào.';
    ul.append(li);
  }
  for (const s of settings.sites) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = s;
    const btn = document.createElement('button');
    btn.textContent = 'Gỡ';
    btn.onclick = async () => {
      const sites = settings.sites.filter((x) => x !== s);
      await chrome.permissions.remove({ origins: [s] }).catch(() => {});
      await saveSettings({ sites });
      settings.sites = sites;
      await syncContentScripts(sites);
      renderSites();
    };
    li.append(span, btn);
    ul.append(li);
  }
}

$('btnSave').onclick = async () => {
  await saveSettings(collect());
  settings = await getSettings();
  $('saveResult').textContent = '✔ Đã lưu';
  setTimeout(() => ($('saveResult').textContent = ''), 2000);
};

$('btnTest').onclick = async () => {
  const s = { ...settings, ...collect() };
  $('testResult').textContent = 'Đang kiểm tra…';
  try {
    const { content, model } = await chat(
      s,
      [{ role: 'user', content: 'Trả lời đúng một từ: OK' }],
      { json: false, timeoutMs: 30000 }
    );
    $('testResult').textContent = `✔ Kết nối thành công (${model}): ${content.trim().slice(0, 40)}`;
  } catch (e) {
    $('testResult').textContent = '✖ ' + e.message;
  }
};

$('btnTestSheet').onclick = async () => {
  const s = { ...settings, ...collect() };
  const out = $('sheetResult');
  out.replaceChildren('Đang kiểm tra…');
  try {
    const r = await postToSheet(s, { action: 'ping' }, { timeoutMs: 60000 });
    const a = document.createElement('a');
    a.href = r.sheetUrl;
    a.target = '_blank';
    a.textContent = r.name;
    out.replaceChildren(`✔ Kết nối thành công${r.user ? ` (tài khoản ${r.user})` : ''}: `, a);
  } catch (e) {
    out.replaceChildren('✖ ' + e.message);
  }
};

load();
