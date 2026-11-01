// Keep a guest identity stable before the client's parallel boot requests.
// The server creates the cookie; a single handshake prevents two first-visit identities.
window.playSession = sessionStorage.getItem('bg_play_session');
if (!/^[a-f0-9]{32}$/.test(window.playSession || '')) {
  window.playSession = crypto.randomUUID().replaceAll('-', '');
  sessionStorage.setItem('bg_play_session', window.playSession);
}
window.sandboxReady = fetch('/api/me', {credentials:'same-origin',headers:{'X-Play-Session':window.playSession}}).then(r => {
  if(!r.ok) throw new Error('Не удалось создать сессию');
  return r.json();
});
try {
  const saved = JSON.parse(localStorage.getItem('bg_prefs') || '{}');
  document.documentElement.classList.toggle('admin-concealed', saved.showAdmin === false);
} catch {}
