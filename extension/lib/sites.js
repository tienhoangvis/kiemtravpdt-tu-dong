// Đăng ký content script động cho các trang VPĐT mà người dùng đã cấp quyền.

const HOOK_ID = 'vpdt-hook';
const CONTENT_ID = 'vpdt-content';

export function originPattern(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Chỉ hỗ trợ trang http/https.');
  return `${u.protocol}//${u.hostname}/*`;
}

export async function syncContentScripts(sites) {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ids = existing.map((s) => s.id).filter((id) => id === HOOK_ID || id === CONTENT_ID);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });

  const granted = [];
  for (const pattern of sites) {
    if (await chrome.permissions.contains({ origins: [pattern] })) granted.push(pattern);
  }
  if (!granted.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: HOOK_ID,
      matches: granted,
      js: ['content/hook.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN'
    },
    {
      id: CONTENT_ID,
      matches: granted,
      js: ['content/content.js'],
      runAt: 'document_start',
      allFrames: true
    }
  ]);
}

// Tiêm script vào tab đang mở (dùng ngay sau khi cấp quyền, không cần tải lại trang).
export async function injectIntoTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/hook.js'],
    world: 'MAIN'
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/content.js']
  });
}
