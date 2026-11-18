// Admin page. Public code, no data: everything is fetched from /api/admin/* with the admin session.
// Text from the chat is only ever inserted with textContent or escaped first.
import { TIERS, TIER_KEYS } from './rules.mjs';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tierLabel = t => `${TIERS[t].emoji} ${TIERS[t].name}`;
const ANSWER_PAGE = 150;
let csrf = '', prompts = [], current = null, guesses = [], showAll = false, answerFilter = '';
let idleMs = 30 * 60e3, absoluteEnd = 0, lastActivity = Date.now(), toastTimer = null, signedOut = false;

async function api(path, data) {
  const init = { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) };
  if (data !== undefined) Object.assign(init, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) });
  const r = await fetch('/api/admin/' + path, init);
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== 'login') { showLogin('Your admin session ended. Sign in again.'); throw new Error('Signed out.'); }
  if (!r.ok) throw Object.assign(new Error(body.error || 'Something went wrong. Try again.'), { status: r.status });
  lastActivity = Date.now();
  return body;
}

// ---------- tabs: Prompts, Members, Settings (last one used is remembered on this device) ----------
const TABS = ['prompts', 'members', 'settings'];
const savedTab = () => { try { const t = localStorage.getItem('mz:admin-tab'); return TABS.includes(t) ? t : 'prompts'; } catch { return 'prompts'; } };
function showTab(tab) {
  document.querySelectorAll('#admin-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
  try { localStorage.setItem('mz:admin-tab', tab); } catch { /* storage may be blocked */ }
}
$('admin-tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

// ---------- sign in / out ----------
function showLogin(note = '') {
  signedOut = true; csrf = '';
  $('admin-bar').hidden = true; $('admin-tabs').hidden = true; document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true; }); $('logout-btn').hidden = true; $('idle-warning').hidden = true;
  $('session-info').textContent = ''; $('login-view').hidden = false;
  $('admin-login-note').textContent = note; $('admin-password').value = ''; $('admin-password').focus();
}
async function startSession() {
  const s = await api('session');
  if (!s.authenticated) return showLogin();
  signedOut = false; csrf = s.csrf; idleMs = s.idleMs;
  absoluteEnd = Date.now() + (s.absoluteExpiresAt - s.serverNow); // the 8-hour limit, in this browser's clock
  $('login-view').hidden = true; $('admin-bar').hidden = false; $('admin-tabs').hidden = false; $('logout-btn').hidden = false;
  showTab(savedTab());
  await Promise.all([loadPrompts(), loadPreview(), loadAudit(), loadLockouts(), loadSettings(), loadMembers()]);
}
$('admin-login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = $('admin-login-btn'), error = $('admin-login-error');
  button.disabled = true; error.hidden = true;
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('admin-password').value }) });
    if (!r.ok) { error.textContent = (await r.json().catch(() => ({}))).error || 'Wrong password'; error.hidden = false; $('admin-password').select(); return; }
    $('admin-password').value = '';
    await startSession();
  } catch { error.textContent = 'The signal is lost. Please retry.'; error.hidden = false; }
  finally { button.disabled = false; }
});
$('logout-btn').addEventListener('click', async () => { try { await api('logout', {}); } catch { /* signed out either way */ } showLogin('Signed out.'); });
$('stay-btn').addEventListener('click', async () => { try { await api('session'); $('idle-warning').hidden = true; } catch { /* showLogin already ran */ } });

// Idle warning: the server ends the session after 30 idle minutes (or 8 hours total).
setInterval(() => {
  if (signedOut || !csrf) return;
  const end = Math.min(lastActivity + idleMs, absoluteEnd), left = end - Date.now();
  $('session-info').textContent = absoluteEnd !== Infinity && absoluteEnd - Date.now() < 3600e3 ? `session ends in ${Math.ceil((absoluteEnd - Date.now()) / 60e3)} min` : '';
  if (left <= 0) { showLogin(end === absoluteEnd ? 'Signed out: admin sessions last 8 hours.' : 'Signed out after 30 minutes without activity.'); return; }
  if (left <= 5 * 60e3) {
    const m = Math.floor(left / 60e3), s = Math.floor(left % 60e3 / 1000);
    $('idle-text').textContent = `You'll be signed out in ${m}:${String(s).padStart(2, '0')}${end === absoluteEnd ? ' (8-hour limit)' : ' for inactivity'}.`;
    $('stay-btn').hidden = end === absoluteEnd; $('idle-warning').hidden = false;
  } else $('idle-warning').hidden = true;
}, 1000);

// ---------- prompt list: search, filters, hide/show ----------
const filters = { category: '', status: 'all' };
const SETUP_HINT = 'If the game was just updated, run every file in game/supabase/migrations in Supabase (npm run check:db shows which are missing).';
async function loadPrompts() {
  try {
    prompts = (await api('prompts')).prompts;
    const cats = [...new Set(prompts.map(p => p.category))].sort();
    if (filters.category && !cats.includes(filters.category)) filters.category = '';
    $('filter-category').innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option value="${esc(c)}"${c === filters.category ? ' selected' : ''}>${esc(c)} (${prompts.filter(p => p.category === c).length})</option>`).join('');
    renderList();
  } catch (e) {
    prompts = [];
    $('prompt-count').textContent = '';
    $('prompt-list').innerHTML = `<li class="error">Couldn't load prompts: ${esc(e.message)}<br><span class="muted">${esc(SETUP_HINT)}</span></li>`;
  }
}
function tierCounts(counts) {
  return TIER_KEYS.filter(k => counts[k]).map(k => `<span class="mini-chip" style="--chip:${TIERS[k].color}" title="${esc(TIERS[k].name)}">${TIERS[k].emoji}${counts[k]}</span>`).join('');
}
const STATUS = { all: () => true, on: p => p.enabled, off: p => !p.enabled, review: p => p.needsReview, warn: p => p.warnings.length > 0 };
function renderList() {
  const q = $('prompt-search').value.trim().toLowerCase();
  const shown = prompts
    .filter(p => !filters.category || p.category === filters.category)
    .filter(STATUS[filters.status])
    .map(p => ({ p, inPrompt: !q || p.id.includes(q) || p.text.toLowerCase().includes(q) || p.category.toLowerCase().includes(q), inAnswers: !!q && (p.answerText || '').includes(q) }))
    .filter(x => x.inPrompt || x.inAnswers);
  const filtered = filters.category || filters.status !== 'all' || q;
  $('prompt-count').textContent = filtered ? `${shown.length} of ${prompts.length} prompts` : `${prompts.length} prompts`;
  $('prompt-list').innerHTML = shown.map(({ p, inPrompt }) => `<li><button type="button" data-prompt="${esc(p.id)}" aria-current="${current?.id === p.id}">
    <span class="p-text">${esc(p.text)}</span>
    <span class="p-meta"><code>${esc(p.id)}</code> · ${esc(p.category)} ${p.enabled ? '<b class="badge on">on</b>' : '<b class="badge off">off</b>'}${p.needsReview ? ' <b class="badge review">review</b>' : ''}${p.warnings.length ? ' <b class="badge warn" title="' + esc(p.warnings.join(' ')) + '">⚠</b>' : ''}${!inPrompt ? ' <span class="muted">· matches an answer</span>' : ''}</span>
    <span class="p-tiers">${tierCounts(p.counts)}</span></button></li>`).join('') || '<li class="muted">No prompts match.</li>';
}
$('prompt-search').addEventListener('input', renderList);
$('filter-category').addEventListener('change', e => { filters.category = e.target.value; renderList(); });
document.querySelector('.status-filter').addEventListener('click', e => {
  const b = e.target.closest('[data-status]'); if (!b) return;
  filters.status = b.dataset.status;
  document.querySelectorAll('.status-filter [data-status]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderList();
});
$('prompt-list').addEventListener('click', e => { const b = e.target.closest('[data-prompt]'); if (b) void openPrompt(b.dataset.prompt); });
// Hide/show the list like a menu; remembered on this device.
function setListHidden(hidden, remember = true) {
  $('editor-view').classList.toggle('list-hidden', hidden);
  $('list-pane').hidden = hidden; $('show-list-btn').hidden = !hidden;
  if (remember) try { localStorage.setItem('mz:admin-list-hidden', hidden ? '1' : '0'); } catch { /* storage may be blocked */ }
}
$('hide-list-btn').addEventListener('click', () => setListHidden(true));
$('show-list-btn').addEventListener('click', () => { setListHidden(false); $('prompt-search').focus(); });
try { if (localStorage.getItem('mz:admin-list-hidden') === '1') setListHidden(true, false); } catch { /* storage may be blocked */ }

// ---------- new prompt ----------
const categories = () => [...new Set(prompts.map(p => p.category))].sort();
$('new-prompt-btn').addEventListener('click', () => {
  current = null; renderList();
  $('prompt-pane').innerHTML = `<form id="new-prompt-form" class="card-form">
    <h2>New prompt</h2>
    <label>Question<input id="np-text" required maxlength="200" placeholder="Name a …"></label>
    <label>Category<input id="np-category" required maxlength="30" list="category-options" placeholder="pick or type one"></label>
    <datalist id="category-options">${categories().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <p class="muted">It starts switched off. Add its answers next, then switch it on.</p>
    <div class="form-buttons"><button type="submit" class="primary">Create prompt</button> <button type="button" class="link-btn" data-cancel-new>cancel</button></div>
  </form>`;
  $('np-text').focus();
});
$('prompt-pane').addEventListener('submit', async e => {
  if (e.target.id !== 'new-prompt-form') return;
  e.preventDefault();
  try {
    const { prompt } = await api('create-prompt', { text: $('np-text').value, category: $('np-category').value });
    await loadPrompts(); current = prompt; guesses = []; showAll = false; answerFilter = '';
    renderPrompt(); renderList(); toast('Prompt created. Now add its answers.'); void loadAudit();
    $('add-answer-text')?.focus();
  } catch (err) { toast(err.message, true); }
});

// ---------- one prompt ----------
async function openPrompt(id) {
  showTab('prompts');
  $('prompt-pane').innerHTML = '<p class="muted">Loading…</p>';
  try { const r = await api('prompt?id=' + encodeURIComponent(id)); current = r.prompt; guesses = r.guesses; showAll = false; answerFilter = ''; renderPrompt(); renderList(); }
  catch (e) { $('prompt-pane').innerHTML = `<p class="error">Couldn't open that prompt: ${esc(e.message)}</p><p class="muted">${esc(SETUP_HINT)}</p>`; }
}
function updateCurrent(prompt) {
  current = prompt;
  const i = prompts.findIndex(p => p.id === prompt.id);
  if (i >= 0) prompts[i] = { ...prompts[i], ...prompt }; else prompts.push(prompt);
  renderPrompt(); renderList();
}
function answerRow(a, i) {
  return `<tr data-row="${i}">
    <td class="a-answer">${esc(a.answer)}${a.autoPick ? ' <span class="muted" title="Picked automatically as the One in a Krillion">auto</span>' : ''}${a.addedHere ? ' <span class="badge added" title="Added on this page">new</span>' : ''}</td>
    <td class="a-aliases">${a.aliases.length ? a.aliases.map(esc).join(', ') : '<span class="muted">—</span>'}</td>
    <td class="a-weight">${a.weight === null ? '' : esc(Math.round(a.weight * 10) / 10)}</td>
    <td class="a-quip">${esc(a.quip || '')}</td>
    <td><button type="button" class="tier-chip" data-tier-for="${i}" aria-haspopup="listbox" style="--chip:${TIERS[a.tier].color}">${esc(tierLabel(a.tier))}</button></td>
    <td><button type="button" class="link-btn" data-edit-row="${i}">edit</button></td></tr>`;
}
function renderPrompt() {
  const p = current;
  const filtered = p.answers.filter(a => !answerFilter || a.answer.toLowerCase().includes(answerFilter) || a.aliases.some(x => x.toLowerCase().includes(answerFilter)));
  const rows = showAll ? filtered : filtered.slice(0, ANSWER_PAGE);
  $('prompt-pane').innerHTML = `
    <header class="prompt-head" id="prompt-head"><h2>${esc(p.text)} <button type="button" class="link-btn small" id="edit-question">edit</button></h2>
      <p class="muted"><code>${esc(p.id)}</code> · ${esc(p.category)} · ${p.answerCount} answers${p.needsReview ? ' · <b class="badge review">needs review</b>' : ''}${p.createdHere ? ' · <b class="badge added">made here</b>' : ''}</p>
      <label class="enable-toggle"><input type="checkbox" id="enabled-box" ${p.enabled ? 'checked' : ''}> <span>${p.enabled ? 'On: can be picked for daily and practice dives' : p.answerCount ? 'Off: never picked' : 'Off: add an answer before switching it on'}</span></label>
      ${p.note ? `<p class="note">Note: ${esc(p.note)}</p>` : ''}
      ${p.answerCount ? p.warnings.map(w => `<p class="warning">⚠ ${esc(w)}</p>`).join('') : ''}
      <p class="notice">Changes apply to rounds scored from now on, including later players today. Scores already given never change.</p>
      <p class="tier-totals">${tierCounts(p.counts)}</p>
    </header>
    <form id="add-answer-form" class="add-answer">
      <input id="add-answer-text" required maxlength="120" placeholder="Add an answer…" aria-label="New answer">
      <select id="add-answer-tier" required aria-label="Tier for the new answer"><option value="">tier…</option>${TIER_KEYS.map(k => `<option value="${k}">${TIERS[k].emoji} ${esc(TIERS[k].name)} · ${TIERS[k].score}</option>`).join('')}</select>
      <button type="submit" class="primary">Add</button>
    </form>
    ${p.answerCount ? `<div class="answers-tools"><input id="answer-filter" type="search" placeholder="filter ${p.answerCount} answers…" value="${esc(answerFilter)}" aria-label="Filter answers"><span class="muted">${filtered.length === p.answerCount ? '' : filtered.length + ' match'}</span></div>
    <div class="table-wrap"><table class="answers"><thead><tr><th>Answer</th><th>Aliases</th><th>Weight</th><th>Quip</th><th>Tier</th><th></th></tr></thead><tbody>
    ${rows.map(a => answerRow(a, p.answers.indexOf(a))).join('')}
    </tbody></table></div>
    ${!showAll && filtered.length > ANSWER_PAGE ? `<button type="button" class="quiet" id="show-all">Show all ${filtered.length} answers</button>` : ''}` : '<p class="muted">No answers yet. Add the first one above.</p>'}
    <section class="guesses"><h3>Top wrong guesses</h3>
      ${guesses.length ? `<p class="muted">Guesses that matched nothing. Add one as an alias so it counts next time.</p><datalist id="answer-options">${p.answers.map(a => `<option value="${esc(a.answer)}">`).join('')}</datalist>
      <table class="guess-table"><thead><tr><th>Guess</th><th>Times</th><th>Add as alias of…</th></tr></thead><tbody>
      ${guesses.map((g, i) => `<tr><td>${esc(g.example)}</td><td>${g.count}</td><td><form class="alias-from-guess" data-guess="${i}"><input list="answer-options" placeholder="answer…" aria-label="Answer to add this guess to" required><button type="submit" class="quiet">Add</button></form></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No wrong guesses logged for this prompt yet.</p>'}
    </section>`;
  $('answer-filter')?.addEventListener('input', e => { answerFilter = e.target.value.trim().toLowerCase(); const pos = e.target.selectionStart; renderPrompt(); const box = $('answer-filter'); box.focus(); box.setSelectionRange(pos, pos); });
}
$('prompt-pane').addEventListener('change', async e => {
  if (e.target.id !== 'enabled-box') return;
  const enabled = e.target.checked;
  try { updateCurrent((await api('enabled', { promptId: current.id, enabled })).prompt); toast(enabled ? 'Switched on.' : 'Switched off.'); void loadPreview(); void loadAudit(); }
  catch (err) { e.target.checked = !enabled; toast(err.message, true); }
});
$('prompt-pane').addEventListener('click', e => {
  if (e.target.closest('[data-cancel-new]')) { $('prompt-pane').innerHTML = '<p class="muted">Pick a prompt from the list.</p>'; return; }
  if (e.target.id === 'show-all') { showAll = true; renderPrompt(); }
  if (e.target.id === 'edit-question') editQuestion();
  const chip = e.target.closest('[data-tier-for]'); if (chip) openTierMenu(chip, Number(chip.dataset.tierFor));
  const edit = e.target.closest('[data-edit-row]'); if (edit) editRow(Number(edit.dataset.editRow));
});
$('prompt-pane').addEventListener('submit', async e => {
  if (e.target.id === 'add-answer-form') {
    e.preventDefault();
    const text = $('add-answer-text').value, tier = $('add-answer-tier').value;
    if (!tier) { toast('Pick a tier for the answer.', true); $('add-answer-tier').focus(); return; }
    try {
      updateCurrent((await api('add-answer', { promptId: current.id, answer: text, tier })).prompt);
      toast(`Added "${text.trim()}" as ${tierLabel(tier)}.`); void loadAudit();
      $('add-answer-tier').value = tier; $('add-answer-text').focus(); // ready for the next one
    } catch (err) { toast(err.message, true); }
    return;
  }
  const form = e.target.closest('.alias-from-guess'); if (!form) return;
  e.preventDefault();
  const g = guesses[Number(form.dataset.guess)], target = form.querySelector('input').value;
  const a = current.answers.find(x => x.answer === target);
  if (!a) { toast('Pick an answer from the list.', true); return; }
  try {
    updateCurrent((await api('aliases', { promptId: current.id, answer: a.answer, aliases: [...a.aliases, g.example] })).prompt);
    guesses = guesses.filter(x => x !== g); renderPrompt(); toast(`Added "${g.example}" as an alias of "${a.answer}".`); void loadAudit();
  } catch (err) { toast(err.message, true); }
});

// ---------- edit the question ----------
function editQuestion() {
  const p = current;
  $('prompt-head').querySelector('h2').outerHTML = `<form id="question-form" class="card-form inline">
    <label>Question<input id="q-text" required maxlength="200" value="${esc(p.text)}"></label>
    <label>Category<input id="q-category" required maxlength="30" list="q-category-options" value="${esc(p.category)}"></label>
    <datalist id="q-category-options">${categories().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="form-buttons"><button type="submit" class="primary">Save</button> <button type="button" class="link-btn" id="cancel-question">cancel</button></div></form>`;
  $('q-text').focus();
  $('cancel-question').addEventListener('click', () => renderPrompt());
  $('question-form').addEventListener('submit', async e => {
    e.preventDefault();
    try { updateCurrent((await api('edit-prompt', { promptId: p.id, text: $('q-text').value, category: $('q-category').value })).prompt); toast('Question saved.'); void loadAudit(); void loadPreview(); }
    catch (err) { toast(err.message, true); }
  });
}

// ---------- edit one answer (text, aliases, quip) or delete it ----------
function editRow(index) {
  const a = current.answers[index], row = document.querySelector(`tr[data-row="${index}"]`);
  row.classList.add('editing');
  row.innerHTML = `<td colspan="6"><form class="row-form">
    <label>Answer<input name="answer" required maxlength="120" value="${esc(a.answer)}"></label>
    <label>Aliases <span class="muted">(other ways to type it, comma separated)</span><input name="aliases" value="${esc(a.aliases.join(', '))}" placeholder="e.g. gbbo, bake off"></label>
    <label>Quip <span class="muted">(shown after the dive)</span><input name="quip" maxlength="200" value="${esc(a.quip || '')}"></label>
    <div class="form-buttons"><button type="submit" class="primary">Save</button> <button type="button" class="link-btn" data-cancel-row>cancel</button><button type="button" class="danger" data-delete-row>Delete answer</button></div>
  </form></td>`;
  const form = row.querySelector('form');
  form.answer.focus();
  form.querySelector('[data-cancel-row]').addEventListener('click', () => renderPrompt());
  form.querySelector('[data-delete-row]').addEventListener('click', async () => {
    if (!confirm(`Delete "${a.answer}"? Scores already given for it stay the same.`)) return;
    try { updateCurrent((await api('delete-answer', { promptId: current.id, answer: a.answer })).prompt); toast(`Deleted "${a.answer}".`); void loadAudit(); }
    catch (err) { toast(err.message, true); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const change = { promptId: current.id, answer: a.answer };
    if (form.answer.value.trim() !== a.answer) change.newAnswer = form.answer.value;
    const aliases = form.aliases.value.split(',').map(x => x.trim()).filter(Boolean);
    if (JSON.stringify(aliases) !== JSON.stringify(a.aliases)) change.aliases = aliases;
    if (form.quip.value.trim() !== (a.quip || '')) change.quip = form.quip.value;
    if (Object.keys(change).length === 2) { renderPrompt(); return; }
    try { updateCurrent((await api('edit-answer', change)).prompt); toast('Answer saved.'); void loadAudit(); }
    catch (err) { toast(err.message, true); }
  });
}

// ---------- tiers ----------
function openTierMenu(chip, index) {
  const menu = $('tier-menu'), a = current.answers[index], r = chip.getBoundingClientRect();
  menu.innerHTML = TIER_KEYS.map(k => `<button type="button" role="option" aria-selected="${k === a.tier}" data-pick-tier="${k}" style="--chip:${TIERS[k].color}">${TIERS[k].emoji} ${esc(TIERS[k].name)} <b>${TIERS[k].score}</b></button>`).join('');
  menu.hidden = false;
  menu.style.top = Math.min(window.scrollY + r.bottom + 4, window.scrollY + innerHeight - menu.offsetHeight - 8) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.dataset.index = index;
  menu.querySelector('[aria-selected="true"]')?.focus();
}
function closeTierMenu() { $('tier-menu').hidden = true; }
document.addEventListener('click', e => { if (!e.target.closest('#tier-menu') && !e.target.closest('[data-tier-for]')) closeTierMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTierMenu(); });
$('tier-menu').addEventListener('click', async e => {
  const b = e.target.closest('[data-pick-tier]'); if (!b) return;
  const a = current.answers[Number($('tier-menu').dataset.index)];
  closeTierMenu();
  await setTier(a.answer, b.dataset.pickTier, true);
});
async function setTier(answer, tier, offerUndo) {
  try {
    const r = await api('tier', { promptId: current.id, answer, tier });
    const promptId = current.id;
    updateCurrent(r.prompt); void loadAudit();
    if (r.oldTier === tier) return toast('No change.');
    toast(`Saved: "${answer}" is now ${tierLabel(tier)}.`, false, offerUndo ? async () => {
      if (current?.id !== promptId) await openPrompt(promptId);
      await setTier(answer, r.oldTier, false);
    } : null);
  } catch (err) { toast(err.message, true); }
}

// ---------- preview and audit ----------
async function loadPreview() {
  try {
    const p = await api('preview');
    const day = d => `<div class="preview-day"><h4>${esc(d.label)} · ${esc(d.date)} · Dive #${d.dayNumber} <span class="muted">${d.fixed ? '(fixed)' : '(not chosen yet; can change if prompts are turned on or off)'}</span></h4><ol>${d.prompts.map(x => `<li><button type="button" class="link-btn" data-prompt="${esc(x.id)}">${esc(x.text)}</button> <span class="muted">${esc(x.category)}</span></li>`).join('')}</ol></div>`;
    $('preview').innerHTML = day(p.today) + day(p.tomorrow);
  } catch (e) { $('preview').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
$('preview').addEventListener('click', e => { const b = e.target.closest('[data-prompt]'); if (b) { void openPrompt(b.dataset.prompt); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
const ACTIONS = { login: 'signed in', login_failed: 'wrong password', login_blocked: 'blocked (too many attempts)', logout: 'signed out', tier: 'tier', aliases: 'aliases', enabled: 'on/off', create_prompt: 'new prompt', edit_prompt: 'question edited', add_answer: 'answer added', edit_answer: 'answer edited', delete_answer: 'answer deleted', unlock: 'unlocked logins', launch_date: 'launch date', add_member: 'name added', rename_member: 'name changed', hide_member: 'name hidden', show_member: 'name shown again' };
const show = v => v === null || v === undefined ? '—' : typeof v === 'string' && TIERS[v] ? tierLabel(v) : Array.isArray(v) ? (v.join(', ') || '(none)')
  : typeof v === 'object' ? Object.entries(v).filter(([, x]) => x !== null && !(Array.isArray(x) && !x.length)).map(([k, x]) => `${k}: ${show(x)}`).join('; ') || '—' : String(v);
async function loadAudit() {
  try {
    const { entries } = await api('audit');
    $('audit').innerHTML = entries.length ? `<table class="audit-table"><thead><tr><th>When</th><th>What</th><th>Prompt</th><th>Answer</th><th>Change</th><th>IP</th></tr></thead><tbody>${entries.map(e => `<tr${e.mine ? ' class="mine"' : ''}>
      <td>${esc(new Date(e.at).toLocaleString())}</td><td>${esc(ACTIONS[e.action] || e.action)}</td><td>${e.promptId ? `<code>${esc(e.promptId)}</code>` : ''}</td><td>${esc(e.answer || '')}</td>
      <td>${e.oldValue !== null || e.newValue !== null ? `${esc(show(e.oldValue))} → ${esc(show(e.newValue))}` : ''}</td><td class="muted">${esc(e.ip || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing yet.</p>';
  } catch (e) { $('audit').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// ---------- launch date ----------
const prettyDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
let launchSettings = null;
function renderSettings(st) {
  launchSettings = st;
  const days = Math.round((Date.parse(st.launchDate) - Date.parse(st.today)) / 86400000);
  $('launch').innerHTML = `
    <p class="launch-status ${st.preview ? 'preview' : 'live'}">${st.preview
      ? `<b>Preview</b> until ${esc(prettyDate(st.launchDate))} (${days === 1 ? 'tomorrow' : 'in ' + days + ' days'}). Players can dive as much as they like; no names, and nothing is saved.`
      : `<b>Live</b> since ${esc(prettyDate(st.launchDate))}. Today is Dive #${st.diveToday}.`}</p>
    <form id="launch-form" class="launch-form"><label>Dive #1 is on <input type="date" id="launch-input" required value="${esc(st.launchDate)}"></label> <button type="submit" class="primary">Save</button></form>
    <p class="muted">Before this date, anyone with the player password gets preview dives: the full game, but no name picker, no leaderboard, and nothing stored. From midnight (Vancouver time) on this date the real game starts on its own.</p>`;
}
async function loadSettings() { try { renderSettings(await api('settings')); } catch (e) { $('launch').innerHTML = `<p class="error">${esc(e.message)}</p><p class="muted">${esc(SETUP_HINT)}</p>`; } }
$('launch').addEventListener('submit', async e => {
  if (e.target.id !== 'launch-form') return;
  e.preventDefault();
  const date = $('launch-input').value;
  if (!date || date === launchSettings?.launchDate) return;
  if (launchSettings && !launchSettings.preview && !confirm(`The game is already live and its dives are numbered from ${prettyDate(launchSettings.launchDate)}. Changing the launch date renumbers every dive. Continue?`)) return;
  try { renderSettings(await api('launch-date', { date })); toast(`Launch date set to ${prettyDate(date)}.`); void loadPreview(); void loadAudit(); }
  catch (err) { toast(err.message, true); }
});

// ---------- members ----------
let members = [];
function renderMembers() {
  const hidden = members.filter(m => !m.active).length;
  $('member-count').textContent = `${members.length - hidden} in the picker${hidden ? ` · ${hidden} hidden` : ''}`;
  $('member-admin-list').innerHTML = members.map(m => `<li data-member-id="${esc(m.id)}" class="${m.active ? '' : 'is-hidden'}">
    <span class="m-name">${esc(m.name)}</span>${m.active ? '' : ' <b class="badge off">hidden</b>'}
    <span class="m-actions"><button type="button" class="link-btn" data-rename>rename</button><button type="button" class="link-btn" data-toggle>${m.active ? 'hide' : 'show'}</button></span></li>`).join('') || '<li class="muted">No members yet. Add the first name above.</li>';
}
async function loadMembers() { try { members = (await api('members')).members; renderMembers(); } catch (e) { $('member-admin-list').innerHTML = `<li class="error">${esc(e.message)}</li>`; } }
$('add-member-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('new-member-name');
  try { const { member } = await api('add-member', { name: input.value }); input.value = ''; await loadMembers(); toast(`Added "${member.name}".`); void loadAudit(); input.focus(); }
  catch (err) { toast(err.message, true); }
});
$('member-admin-list').addEventListener('click', async e => {
  const li = e.target.closest('[data-member-id]'); if (!li) return;
  const m = members.find(x => x.id === li.dataset.memberId);
  if (e.target.closest('[data-toggle]')) {
    try { await api('member-active', { id: m.id, active: !m.active }); await loadMembers(); toast(m.active ? `Hid "${m.name}" from the picker.` : `"${m.name}" is back in the picker.`); void loadAudit(); }
    catch (err) { toast(err.message, true); }
  }
  if (e.target.closest('[data-rename]')) {
    li.innerHTML = `<form class="rename-form"><input maxlength="40" value="${esc(m.name)}" aria-label="New name for ${esc(m.name)}" required> <button type="submit" class="primary">Save</button> <button type="button" class="link-btn" data-cancel>cancel</button></form>`;
    const form = li.querySelector('form'), input = form.querySelector('input');
    input.focus(); input.select();
    form.querySelector('[data-cancel]').addEventListener('click', renderMembers);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (input.value.trim() === m.name) return renderMembers();
      try { await api('rename-member', { id: m.id, name: input.value }); await loadMembers(); toast('Renamed.'); void loadAudit(); }
      catch (err) { toast(err.message, true); }
    });
  }
});

// ---------- login lockouts ----------
const minutesLeft = (until, serverNow) => { const m = Math.ceil((until - serverNow) / 60e3); return m >= 120 ? `${Math.ceil(m / 60)} hours` : m === 1 ? '1 minute' : `${m} minutes`; };
function renderLockouts(l) {
  const rows = [];
  for (const kind of ['player', 'admin']) {
    const who = kind === 'player' ? 'Player login' : 'Admin login';
    if (l[kind].globalUntil) rows.push(`<li><b>${who}: switched off for everyone</b> (too many wrong passwords overall), ${minutesLeft(l[kind].globalUntil, l.serverNow)} left <button type="button" class="quiet" data-unlock="${kind}">Unlock everyone</button></li>`);
    for (const x of l[kind].ips) rows.push(`<li>${who} from <code>${esc(x.ip)}</code>: locked for ${minutesLeft(x.until, l.serverNow)} after ${x.failures} wrong passwords <button type="button" class="quiet" data-unlock="${kind}" data-ip="${esc(x.ip)}">Unlock</button></li>`);
  }
  $('lockouts').innerHTML = rows.length
    ? `<ul class="lockout-list">${rows.join('')}</ul><p class="muted">Unlocking clears those wrong-password attempts, so the next lock starts at 15 minutes again.</p>`
    : '<p class="muted">Nobody is locked out. <button type="button" class="link-btn" id="refresh-lockouts">refresh</button></p>';
}
async function loadLockouts() {
  try { renderLockouts(await api('lockouts')); } catch (e) { $('lockouts').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
$('lockouts').addEventListener('click', async e => {
  if (e.target.id === 'refresh-lockouts') return void loadLockouts();
  const b = e.target.closest('[data-unlock]'); if (!b) return;
  b.disabled = true;
  try {
    renderLockouts(await api('unlock', { kind: b.dataset.unlock, ...(b.dataset.ip ? { ip: b.dataset.ip } : {}) }));
    toast(b.dataset.ip ? `Unlocked ${b.dataset.ip}.` : 'Unlocked everyone.'); void loadAudit();
  } catch (err) { b.disabled = false; toast(err.message, true); }
});

// ---------- toast with undo ----------
function toast(message, isError = false, undo = null) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.className = 'toast' + (isError ? ' error' : '');
  t.innerHTML = `<span></span>${undo ? ' <button type="button" class="quiet" id="undo-btn">Undo</button>' : ''}`;
  t.firstChild.textContent = message;
  t.hidden = false;
  if (undo) $('undo-btn').addEventListener('click', () => { t.hidden = true; void undo(); }, { once: true });
  toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 8000 : 3500);
}

// The server already sent the right view; only an editor page needs the session (for its CSRF token).
if (document.body.dataset.signedIn === 'true') startSession().catch(() => showLogin());
else { signedOut = true; $('admin-password').focus(); }
