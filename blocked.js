// ─── Blocked Page Handlers ───
// Separate JS file to comply with extension CSP (no inline event handlers).

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('goBackBtn').addEventListener('click', () => {
    if (history.length > 1) {
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
