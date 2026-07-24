// ─── Blocked Page Handlers ───
// Separate JS file to comply with extension CSP (no inline event handlers).

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('goBackBtn').addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('spa') === '1') {
      // If we got here via an SPA redirect (chrome.tabs.update),
      // the blocked page is still in the history stack.
      // Go back twice to skip the blocked page and return to the safe page.
      history.go(-2);
    } else if (history.length > 1) {
      history.back();
    } else {
      // If there's no history (e.g. typed directly), go to new tab page
      window.location.href = 'about:blank';
    }
  });

  document.getElementById('closeTabBtn').addEventListener('click', () => {
    window.close();
  });
});
