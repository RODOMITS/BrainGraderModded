// Keep a guest identity stable before the client's parallel boot requests.
// The server creates the cookie; a single handshake prevents two first-visit identities.
window.playSession = sessionStorage.getItem('bg_play_session');
if (!/^[a-f0-9]{32}$/.test(window.playSession || '')) {
  window.playSession = crypto.randomUUID().replaceAll('-', '');
  sessionStorage.setItem('bg_play_session', window.playSession);
}
// Admin scripts wait for session setup before making their own authenticated requests.
window.sandboxReady = Promise.resolve();
try {
  const saved = JSON.parse(localStorage.getItem('bg_prefs') || '{}');
  document.documentElement.classList.toggle('admin-concealed', saved.modded === false || saved.showAdmin === false);
} catch {}
