chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'captureTab') return;
  const windowId = sender.tab?.windowId ?? null;
  chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 92 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      console.error('[captcha-ext] captureVisibleTab error:', chrome.runtime.lastError.message);
      sendResponse({ error: chrome.runtime.lastError.message });
    } else {
      console.log('[captcha-ext] captured', Math.round((dataUrl?.length || 0) / 1024), 'KB');
      sendResponse({ imageData: dataUrl || null });
    }
  });
  return true; // keep channel open for async sendResponse
});
