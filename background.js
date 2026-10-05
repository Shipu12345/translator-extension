// Service worker: tracks which tabs have translation switched on and routes
// user triggers (icon, shortcuts, context menu) to the tab's content script.

const MENU_ID = 'gte-translate-selection';
const key = (tabId) => `tab:${tabId}`;

async function isActive(tabId) {
  const k = key(tabId);
  const data = await chrome.storage.session.get(k);
  return Boolean(data[k]);
}

async function setActive(tabId, active) {
  if (active) await chrome.storage.session.set({ [key(tabId)]: true });
  else await chrome.storage.session.remove(key(tabId));
  await setBadge(tabId, active ? 'EN' : '');
}

async function setBadge(tabId, text, color = '#4a90d9') {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Tab may have closed.
  }
}

async function send(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return undefined; // No content script (chrome:// pages, Web Store, PDF viewer, not yet loaded).
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Translate selection to English',
    contexts: ['selection'],
  });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('setup/setup.html') });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const next = !(await isActive(tab.id));
  const reply = await send(tab.id, { type: 'set-active', active: next });
  if (reply === undefined) {
    // Can't run on this page; don't leave the tab in an "on" state.
    await setActive(tab.id, false);
    await setBadge(tab.id, '✕', '#999');
    setTimeout(() => setBadge(tab.id, ''), 1500);
    return;
  }
  await setActive(tab.id, next);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'translate-selection' && tab?.id !== undefined) {
    await send(tab.id, { type: 'translate-selection' });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id !== undefined) {
    await send(tab.id, { type: 'translate-selection', text: info.selectionText });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (msg.type === 'hello' && tabId !== undefined) {
    // Content script loaded on a new page: tell it whether to resume translating.
    isActive(tabId).then(async (active) => {
      await setBadge(tabId, active ? 'EN' : '');
      sendResponse({ active });
    });
    return true;
  }
  if (msg.type === 'status' && tabId !== undefined) {
    if (msg.status === 'error') setBadge(tabId, '!', '#d9534f');
    else if (msg.status === 'ok') isActive(tabId).then((a) => setBadge(tabId, a ? 'EN' : ''));
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(key(tabId));
});
