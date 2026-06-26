// Runs in ISOLATED world — has chrome.runtime access but is a separate JS context
// from the page. Playwright's page.evaluate() runs in the MAIN world.
// We bridge the two via window.postMessage: the page sends { __action: 'captureTab', __id }
// and we respond with { __captureTabResult: id, imageData } or { ..., error }.
(function () {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.__action !== 'captureTab') return;

    const reqId = event.data.__id;

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'captureTab' }, resolve);
      });

      if (!response?.imageData) {
        window.postMessage({
          __captureTabResult: reqId,
          error: response?.error || 'no imageData',
        }, '*');
        return;
      }

      // Crop to the centre 40%×60% — same region as page.screenshot clip.
      // The captcha dialog is always centred in the Amazon auth page.
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload  = () => resolve(i);
        i.onerror = () => reject(new Error('img decode failed'));
        i.src = response.imageData;
      });

      const cropX = Math.round(img.width  * 0.30);
      const cropY = Math.round(img.height * 0.20);
      const cropW = Math.round(img.width  * 0.40);
      const cropH = Math.round(img.height * 0.60);

      const canvas = document.createElement('canvas');
      canvas.width  = cropW;
      canvas.height = cropH;
      canvas.getContext('2d').drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      window.postMessage({
        __captureTabResult: reqId,
        imageData: canvas.toDataURL('image/jpeg', 0.90),
      }, '*');
    } catch (err) {
      window.postMessage({ __captureTabResult: reqId, error: String(err) }, '*');
    }
  });
})();
