// ─── Blocked Page Handlers ───
// Separate JS file to comply with extension CSP (no inline event handlers).

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('goBackBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'goBack' });
  });

  document.getElementById('closeTabBtn').addEventListener('click', () => {
    window.close();
  });
});
