// Password screen. Sends the password to the Worker; on success the server sets an HttpOnly session
// cookie and the reload shows the game. Nothing here (or anywhere public) holds game data.
import { Ocean } from './ocean.mjs';

const $ = id => document.getElementById(id);
let settings = {}; try { settings = JSON.parse(localStorage.getItem('mz:settings')) || {}; } catch { /* storage may be blocked */ }
const scene = new Ocean($('ocean'), $('mascot'));
scene.lowPower = !!settings.lowPower; scene.resize();
document.body.classList.toggle('low-power', !!settings.lowPower);
document.body.classList.toggle('colorblind', !!settings.colorblind);
function viewport() { document.documentElement.style.setProperty('--vh', (window.visualViewport?.height || innerHeight) + 'px'); }
viewport(); window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport);

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = $('login-btn'), error = $('login-error');
  button.disabled = true; button.textContent = '…'; error.hidden = true;
  try {
    const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }), signal: AbortSignal.timeout(15000) });
    if (response.ok) { location.reload(); return; }
    const body = await response.json().catch(() => ({}));
    error.textContent = body.error || 'Wrong password';
  } catch { error.textContent = 'The signal is lost. Please retry.'; }
  error.hidden = false; button.disabled = false; button.textContent = 'DIVE IN ▼';
  $('password').select();
});
$('mascot').addEventListener('click', () => { $('mascot').classList.remove('poked'); void $('mascot').offsetWidth; $('mascot').classList.add('poked'); });
$('password').focus({ preventScroll: true });
