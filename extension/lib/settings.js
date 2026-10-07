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
  sites: []
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // API key lưu ở local để không đồng bộ lên tài khoản Google.
  const { apiKey } = await chrome.storage.local.get({ apiKey: '' });
  return { ...DEFAULT_SETTINGS, ...stored, apiKey };
}

export async function saveSettings(patch) {
  const { apiKey, ...rest } = patch;
  if (apiKey !== undefined) await chrome.storage.local.set({ apiKey });
  if (Object.keys(rest).length) await chrome.storage.sync.set(rest);
}
