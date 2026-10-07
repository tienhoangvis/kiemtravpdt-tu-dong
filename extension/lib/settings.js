// Cấu hình dùng chung cho background, side panel và trang tuỳ chọn.

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  temperature: 0.3,
  maxChars: 60000,
  maxPdfPages: 40,
  orgName: 'Vishipel',
  userRole: 'Phó Tổng giám đốc',
  departments: [
    'P. TCLĐ',
    'P. HCTH',
    'CSKD',
    'Ban KSNB',
    'Ban điều hành',
    'Chủ tịch'
  ].join('\n'),
  customInstructions: '',
  autoAnalyze: false,
  useCache: true,
  // Google Sheet / Drive (qua Google Apps Script web app)
  sheetUrl: '',
  autoExport: false,
  saveFilesToDrive: true,
  // Kiểm tra tự động văn bản chưa đọc
  batch: { sections: ['den', 'di', 'noi_bo'], scope: 'unread', max: 20, attach: true, skip: true, export: true, repeat: false, repeatMin: 30 },
  sites: []
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // API key và mã bảo mật lưu ở local để không đồng bộ lên tài khoản Google.
  const secrets = await chrome.storage.local.get({ apiKey: '', sheetToken: '' });
  return { ...DEFAULT_SETTINGS, ...stored, ...secrets };
}

export async function saveSettings(patch) {
  const { apiKey, sheetToken, ...rest } = patch;
  const secrets = {};
  if (apiKey !== undefined) secrets.apiKey = apiKey;
  if (sheetToken !== undefined) secrets.sheetToken = sheetToken;
  if (Object.keys(secrets).length) await chrome.storage.local.set(secrets);
  if (Object.keys(rest).length) await chrome.storage.sync.set(rest);
}
