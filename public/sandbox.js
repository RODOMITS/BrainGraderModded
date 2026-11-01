// Keep a guest identity stable before the client's parallel boot requests.
// The server creates the cookie; a single handshake prevents two first-visit identities.
window.sandboxReady = fetch('/api/me', {credentials:'same-origin'}).then(r => {
  if(!r.ok) throw new Error('Не удалось создать сессию');
  return r.json();
});
try {
  const saved = JSON.parse(localStorage.getItem('bg_prefs') || '{}');
  document.documentElement.classList.toggle('admin-concealed', saved.showAdmin === false);
} catch {}
