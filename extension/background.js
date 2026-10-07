import { getSettings } from './lib/settings.js';
import { syncContentScripts } from './lib/sites.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('setPanelBehavior', e));

async function resync() {
  const { sites } = await getSettings();
  await syncContentScripts(sites).catch((e) => console.warn('syncContentScripts', e));
}

chrome.runtime.onInstalled.addListener(resync);
chrome.runtime.onStartup.addListener(resync);
chrome.permissions.onRemoved.addListener(resync);
