// Mizerillion browser app. Ported from OpenKrillion's public/app.mjs (MIT).
// Removed: analytics, guide/AI docs, feedback. Added: group leaderboard, quips in the answer review,
// prompts that arrive one round at a time. The server owns the clock and the score.
import { GAME } from './site.mjs';
import { TIERS, BANDS, ROUND_MS, ROUNDS, bandFor, shareText, gameDate } from './rules.mjs';
import { Ocean } from './ocean.mjs';
import { Sound } from './sound.mjs';
import { DROP_MS, easeInOut, easeOut, iconFor, tierImage, diveChart } from './presentation.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const runtime = JSON.parse($('runtime-config').textContent);
const testMode = runtime.local && new URLSearchParams(location.search).has('test');
const KEY = 'mz:';
let scope = ''; // "<member id>:" once the player has picked their name
const fullKey = key => KEY + (key === 'settings' ? '' : scope) + key;
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(fullKey(key))) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(fullKey(key), JSON.stringify(value)); } catch { /* private browsing can block storage */ } };
let csrf = ''; // per-session token from /api/session, sent with every request that changes data
const settings = { lowPower: false, colorblind: false, corrections: true, clearRejected: false, buddy: 'krill', ...read('settings', {}) };
const scene = new Ocean($('ocean'), $('mascot')), sound = new Sound();
let today = null, game = null, phase = 'intro', busy = false, autoSent = false, correction = null, lastTick = -1, review = null, currentScore = 0, paused = false, dialogPausePending = null, clockAtServer = 0, visualScore = 0, scoreAnimation = null, promptExitTimer = null;
const now = () => Date.now() + clockAtServer;

async function api(path, data) {
  const response = await fetch('/api/' + path, { credentials: 'same-origin', cache: 'no-store', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
  if (response.status === 401) { location.reload(); await new Promise(() => {}); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'The signal is lost. Please retry.'), { status: response.status });
  return body;
}
// The server no longer has this dive (only happens when the in-memory test server restarts).
// Go back to the start screen instead of leaving the round frozen.
function lostDive() {
  write('run', null); game = null; paused = false; autoSent = false; correction = null; visualScore = 0;
  scene.setDepth(0); setPhase('intro'); updateHud();
  $('boot-error').textContent = 'That dive was lost because the server restarted. Start a new one.'; $('boot-error').hidden = false;
}
function setPhase(value) {
  const card = $('prompt-card'), exiting = value === 'plunge' && !card.hidden;
  clearTimeout(promptExitTimer); card.classList.toggle('leaving', exiting);
  if (exiting) promptExitTimer = setTimeout(() => { if (phase === 'plunge') card.hidden = true; }, testMode ? 40 : 650);
  phase = value; if (value !== 'answering') document.body.classList.remove('timer-hot');
  document.body.dataset.phase = value; scene.setPhase(value);
  $('hero').hidden = false; $('intro').hidden = value !== 'intro';
  card.hidden = !exiting && !['preview', 'answering'].includes(value);
  $('answer-dock').hidden = value !== 'answering'; $('preview-label').hidden = value !== 'preview';
  $('landing').hidden = value !== 'landed'; $('next-wrap').hidden = value !== 'landed';
  $('results').hidden = value !== 'done'; $('falling-answer').hidden = value !== 'plunge'; $('tier-ladder').hidden = value !== 'plunge';
}
const buddyOptions = [{ id: 'krill', name: 'The Krill', streak: 0, src: '/assets/krill.svg' }, { id: 'schooler', name: 'Schooler', streak: 5, src: '/assets/schooler.svg' }, { id: 'rare', name: 'Rare Squid', streak: 14, src: '/assets/rare.svg' }, { id: 'deepcut', name: 'Deep Cut Angler', streak: 30, src: '/assets/deepcut.svg' }, { id: 'evil', name: 'Evil Krill', streak: 45, src: '/assets/evil.svg' }];
function applySettings() {
  if (scene.lowPower !== settings.lowPower) { scene.lowPower = settings.lowPower; scene.resize(); } document.body.classList.toggle('low-power', settings.lowPower); document.body.classList.toggle('colorblind', settings.colorblind);
  document.querySelectorAll('[data-setting]').forEach(input => input.checked = !!settings[input.dataset.setting]);
  sound.mute(!!settings.muted); $('mute-btn').setAttribute('aria-pressed', String(!!settings.muted)); $('mute-btn').setAttribute('aria-label', settings.muted ? 'Turn sound on' : 'Turn sound off');
  $('mute-btn').innerHTML = `<svg viewBox="0 0 20 16" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="M2 6h3l4-4v12l-4-4H2z"/>${settings.muted ? '<path d="m12 5 5 6m0-6-5 6" stroke="currentColor" stroke-width="2"/>' : '<path d="M11 6h2v4h-2zm4-3h2v10h-2z"/>'}</svg>`;
  $('mascot').dataset.buddy = settings.buddy; const buddy = buddyOptions.find(b => b.id === settings.buddy) || buddyOptions[0];
  $('mascot').querySelector('img').src = buddy.src; $('mascot').querySelector('img').alt = buddy.name; syncBuddyGold();
}
applySettings();
function updateHud() {
  const results = game?.results || []; currentScore = results.reduce((s, r) => s + r.score, 0);
  $('score').textContent = Math.round(visualScore); $('depth').textContent = Math.round(scene.depth).toLocaleString('en-US') + 'm';
  $('round-label').textContent = game ? (game.completed ? 'DIVE COMPLETE' : `PROMPT ${Math.min(ROUNDS, game.round + 1)} OF ${ROUNDS}`) : 'SURFACE';
  document.querySelectorAll('#round-dots i').forEach((dot, i) => { const r = results.find(r => r.round === i); dot.className = r ? 'done' : i === (game?.round ?? -1) ? 'active' : ''; dot.style.setProperty('--dot-color', r ? '#ffd166' : '#26364b'); });
}
function saveRun() { if (game) write('run', { runId: game.runId, date: game.date, mode: game.mode }); }
function setGame(value) { game = value; clockAtServer = typeof game.serverNow === 'number' ? game.serverNow - Date.now() : 0; visualScore = game.results.reduce((sum, r) => sum + r.score, 0); saveRun(); updateHud(); }
const promptText = i => game?.prompts[i]?.text || '';
function resumeView() { if (game.completed) return showResults(); if (game.roundStart === null && game.results.length) { const last = game.results.at(-1); showLanding({ ...last, promptText: promptText(last.round) }); } else showRound(); }
async function begin(practice = false) {
  if (busy) return; busy = true; $('start-btn').disabled = true; $('boot-error').hidden = true; await sound.init();
  try { const response = await api('start', { practice }); setGame(response); sound.event('begin'); scene.targetActive = 1; review = null; await resumeView(); }
  catch (e) { setPhase('intro'); $('boot-error').textContent = e.message; $('boot-error').hidden = false; }
  finally { busy = false; $('start-btn').disabled = false; }
}
function showRound() {
  setPhase('preview'); syncBuddyGold(); correction = null; autoSent = false; lastTick = -1;
  $('answer-status').textContent = ''; $('answer-status').className = 'answer-status';
  $('prompt-number').textContent = `PROMPT ${game.round + 1} OF ${ROUNDS}`; $('prompt-text').textContent = promptText(game.round);
  $('answer').value = read('draft:' + game.runId + ':' + game.round, ''); $('answer').disabled = true; $('submit-btn').disabled = true;
  scene.setDepth(currentScore * 10); scene.roundBase = currentScore * 10; scene.roundIndex = game.round; scene.round(currentScore * 10); tick();
}
async function submit(timeout = false) {
  if (!game || busy || !['preview', 'answering'].includes(phase) || paused) return;
  const raw = $('answer').value.trim(); if (!raw && !timeout) return;
  busy = true; $('submit-btn').disabled = true;
  // Instant feedback while the server checks the answer.
  $('submit-btn').textContent = '…';
  if (raw) { const rect = $('answer').getBoundingClientRect(); for (let i = 0; i < 12; i++) scene.typeAt(rect.left + Math.random() * rect.width, rect.top + Math.random() * rect.height, 1); }
  try {
    const response = await api('answer', { runId: game.runId, round: game.round, answer: raw, timeout, confirm: correction === raw, previewCorrection: settings.corrections });
    if (response.rejected) {
      $('answer-status').className = 'answer-status'; $('answer-status').textContent = response.message; sound.event('reject');
      $('answer').classList.remove('shake'); void $('answer').offsetWidth; $('answer').classList.add('shake');
      if (settings.clearRejected) $('answer').value = ''; correction = null;
    } else if (response.correction) {
      correction = response.correction; $('answer-status').className = 'answer-status correction';
      $('answer-status').innerHTML = `“${escape(raw)}” → corrects to “${escape(correction)}”<small>submit again to confirm · or edit</small>`;
      $('answer').value = correction; write('draft:' + game.runId + ':' + game.round, correction);
    } else if (response.alreadyScored) { setGame(response.state); await resumeView(); }
    else {
      const oldScore = currentScore; setGame(response.state); sound.event('submit');
      $('submit-btn').textContent = 'DIVE';
      await plunge(response.result, oldScore);
    }
  } catch (e) {
    if (e.status === 404) { lostDive(); return; }
    $('answer-status').className = 'answer-status';
    // The end-of-round submit must get through: retry it shortly instead of freezing at 0.
    // Retry quickly, so a typed answer still lands inside the server's 1.5 s grace window.
    if (timeout) { $('answer-status').textContent = 'Reconnecting…'; setTimeout(() => { autoSent = false; }, 600); }
    else $('answer-status').textContent = e.message;
  }
  finally { busy = false; $('submit-btn').textContent = 'DIVE'; if (phase === 'answering') { $('submit-btn').disabled = !$('answer').value.trim(); $('answer').focus({ preventScroll: true }); } }
}
function animateScore(from, to, gold = false) {
  if (scoreAnimation) cancelAnimationFrame(scoreAnimation);
  const started = performance.now(), duration = testMode ? 60 : gold ? 1100 : 700;
  const frame = t => { const p = Math.min(1, (t - started) / duration), e = 1 - (1 - p) ** 4; visualScore = from + (to - from) * e; scene.depth = visualScore * 10; $('score').textContent = Math.round(visualScore); if (p < 1) scoreAnimation = requestAnimationFrame(frame); else { visualScore = to; if (gold) { $('score').classList.add('slam'); setTimeout(() => $('score').classList.remove('slam'), 520); } } };
  scoreAnimation = requestAnimationFrame(frame);
}
async function plunge(result, oldScore) {
  setPhase('plunge'); document.body.dataset.tier = result.tier || 'miss'; visualScore = oldScore; updateHud(); scene.roundIndex = game.round;
  const fall = $('falling-answer'), ladder = $('tier-ladder');
  fall.textContent = result.answer ? `“${result.answer.toUpperCase()}”` : ''; fall.style.color = TIERS[result.tier]?.color || '#7d93b8'; fall.style.setProperty('--chip-color', TIERS[result.tier]?.color || '#7d93b8');
  ladder.innerHTML = result.tier ? Object.entries(TIERS).map(([id, t]) => `<div class="tier-line" data-tier="${id}" data-score="${t.score}" style="--line-color:${t.color}"><span>${tierImage(id)}${t.name.toUpperCase()} · ${t.score}</span></div>`).join('') : '';
  const duration = testMode ? 80 : DROP_MS[result.tier || 'miss'], began = performance.now(); let lastPassed = -1;
  if (result.tier) sound.event('sink'); else { sound.event('miss'); $('game').classList.add('shake'); setTimeout(() => $('game').classList.remove('shake'), 500); }
  await new Promise(resolve => {
    const frame = t => {
      const p = Math.min(1, (t - began) / duration), e = easeInOut(p); scene.drop(oldScore * 10, result, p);
      const sway = result.tier === 'plankton' ? 36 * Math.sin(p * 7) * (1 - .25 * p) : result.tier === 'tooclever' ? 7 * Math.sin(p * 42) : Math.sin(p * (result.tier === 'krillion' ? 24 : 16)) * (1 - p) * (result.tier === 'krillion' ? 26 : 14);
      fall.style.left = `calc(50% - 24px + ${sway}px)`; fall.style.rotate = (sway * (result.tier === 'plankton' ? .55 : .4)) + 'deg'; fall.style.top = (scene.layout().height / 2 - 60) + 'px';
      const travelled = 90 + (result.score * 10 - 90) * e;
      Array.from(ladder.children).forEach((line, i) => { if (travelled >= Number(line.dataset.score) * 10 - 4 && !line.classList.contains('active')) { line.classList.add('active'); if (i > lastPassed) { sound.event('tier'); lastPassed = i; } } });
      if (p < 1) requestAnimationFrame(frame); else { scene.cameraDepth = scene.cameraTarget; resolve(); }
    };
    requestAnimationFrame(frame);
  });
  showLanding(result, oldScore);
}
function showLanding(result, oldScore = currentScore - result.score) {
  setPhase('landed'); const tier = TIERS[result.tier]; document.body.dataset.tier = result.tier || 'miss'; document.documentElement.style.setProperty('--tier', tier?.color || '#7d93b8');
  const icon = $('land-icon'); icon.hidden = !tier; icon.src = '/assets/' + (iconFor(result.tier) || 'plankton') + '.svg'; icon.style.visibility = result.tier === 'krillion' ? 'hidden' : 'visible';
  $('land-tier').textContent = tier?.name.toUpperCase() || 'NOTHING LANDED'; $('land-answer').textContent = result.answer ? `“${result.answer}”` : '—';
  $('land-points').innerHTML = `<b>+${result.score} PTS</b>${result.score ? ' · sink ' + (result.score * 10).toLocaleString('en-US') + 'm' : ''}`;
  $('land-quip').textContent = result.quip || tier?.blurb || (result.rawAnswer ? 'never made it onto the reef.' : 'the clock beat you to it.');
  $('next-btn').textContent = game.completed ? 'SURFACE ▲' : 'DESCEND ▼';
  if (tier) sound.event(result.tier); scene.target = currentScore * 10; scene.roundIndex = game.round;
  if (!scene.fx) scene.fx = { tier: result.tier, progress: 1 };
  scene.moveCamera(currentScore * 10 + 30, testMode ? 1 : 500);
  const gold = result.tier === 'krillion'; visualScore = oldScore;
  if (gold) {
    $('mascot').classList.remove('celebrate'); void $('mascot').offsetWidth; $('mascot').classList.add('celebrate'); setTimeout(() => $('mascot').classList.remove('celebrate'), testMode ? 30 : 1250);
    scene.goldLandAt = performance.now();
    setTimeout(() => { if (phase !== 'landed' || game.results.at(-1)?.round !== result.round) return; syncBuddyGold(); scene.burst('#ffd166', 42); animateScore(oldScore, currentScore, true); }, testMode ? 20 : 1000);
  } else animateScore(oldScore, currentScore);
  if (['rare', 'tooclever'].includes(result.tier)) { $('game').classList.add('shake'); setTimeout(() => $('game').classList.remove('shake'), 500); }
  if (result.score >= 60) { scene.burst(tier.color, result.score === 100 ? 36 : 22); const flash = document.querySelector('.flash'); flash.style.background = tier.color; flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on'); }
  if (!gold) syncBuddyGold(); updateHud();
}
async function next() {
  if (busy) return; busy = true;
  try {
    if (game.completed) { sound.event('surface'); const duration = Math.min(9000, Math.max(2500, (currentScore * 10 + 30) * 3)); scene.moveCamera(-45, testMode ? 1 : duration, easeOut); await showResults(); return; }
    sound.event('begin'); setGame(await api('next', { runId: game.runId })); showRound();
  } catch (e) { if (e.status === 404) lostDive(); else $('land-quip').textContent = e.message; } finally { busy = false; }
}
function syncBuddyGold() { const gold = game?.results.some(r => r.tier === 'krillion'); $('mascot').classList.toggle('gold', !!gold); if (settings.buddy === 'krill') $('mascot').querySelector('img').src = gold ? '/assets/krill-gold.svg' : '/assets/krill.svg'; }
function historyStats() {
  const history = read('history', {}), daily = Object.values(history).filter(r => r.mode === 'daily').sort((a, b) => a.date.localeCompare(b.date));
  let bestStreak = 0, streak = 0, last = null;
  for (const r of daily) { streak = last && Date.parse(r.date) - Date.parse(last) === 86400000 ? streak + 1 : 1; bestStreak = Math.max(bestStreak, streak); last = r.date; }
  const diff = last ? (Date.parse(gameDate()) - Date.parse(last)) / 86400000 : Infinity;
  return { history, daily, played: daily.length, current: diff <= 1 ? streak : 0, bestStreak, best: Math.max(0, ...daily.map(r => r.score)), average: daily.length ? Math.round(daily.reduce((s, r) => s + r.score, 0) / daily.length) : 0 };
}
function storeHistory() { const history = read('history', {}), key = game.mode === 'daily' ? game.date : game.runId; history[key] = { date: game.date, dayNumber: game.dayNumber, mode: game.mode, score: currentScore, tiers: game.results.map(r => r.tier) }; write('history', history); }
const tierEmojis = tiers => tiers.map(t => TIERS[t]?.emoji || '⬛').join('');
function boardHtml(data) {
  if (game.mode !== 'daily') return '<p>Practice dive · it doesn’t count towards your stats or the daily board.</p>';
  if (!data.population) return '<p>You’re the first diver today. Check back once the others have played.</p>';
  return `<p>YOU OUT-DOVE ${data.beat} OF ${data.population} OTHER ${data.population === 1 ? 'DIVER' : 'DIVERS'} TODAY</p><ol class="board">${data.board.map((b, i) => `<li class="${b.you ? 'you-row' : ''}"><span class="board-rank">${i + 1}</span><span class="board-name">${escape(b.name)}${b.you ? ' <b class="you">YOU</b>' : ''}</span><span class="board-tiers" aria-hidden="true">${tierEmojis(b.tiers)}</span><span class="board-score">${b.score}</span></li>`).join('')}</ol>`;
}
async function showResults() {
  setPhase('done'); visualScore = currentScore; syncBuddyGold(); scene.setDepth(0); review = null; storeHistory();
  const band = bandFor(currentScore), stats = historyStats(), practice = game.mode === 'practice';
  document.documentElement.style.setProperty('--tier', TIERS[band.tier].color);
  $('results').innerHTML = `<header class="result-header"><span class="result-brand">${escape(GAME.name.toUpperCase())}</span><span>${practice ? 'Practice · ' : ''}Dive #${game.dayNumber} complete</span></header>
  <div class="result-score"><strong>${currentScore}</strong><span>-${(currentScore * 10).toLocaleString('en-US')}m</span></div>
  <p class="rule">${practice ? 'PRACTICE' : 'TODAY IN THE CHAT'}</p><div class="distribution board-wrap" id="distribution"><p>Sounding the rest of the chat…</p></div>
  <p class="rule">DIVE LOG · DEEPER = RARER</p>${diveChart(game.results, escape)}
  <p class="rule">THE BEARING</p><ul class="band-list">${BANDS.map(b => `<li class="${b === band ? 'current' : ''}">${tierImage(b.tier)}<span class="band-range" style="color:${TIERS[b.tier].color}">${b.min}${b.min === 450 ? '+' : '–' + b.max}</span><span>${b.name}. ${b.text}</span></li>`).join('')}</ul>
  <pre class="share-preview" id="share-preview">${escape(resultText())}</pre><div class="share-actions"><button class="quiet" id="copy-result">Copy result</button>${navigator.share ? '<button class="quiet" id="native-share">Share…</button>' : ''}</div>
  <div class="actions"><button class="quiet" data-action="practice">KEEP DIVING ∞</button><button class="quiet" data-action="logbook">LOGBOOK ⟲</button></div>
  <p class="rule">THE CATCH · TAP A ROUND FOR EVERY ANSWER</p><ul class="answer-review">${game.results.map((r, i) => `<li><button class="review-toggle" aria-expanded="false" data-review="${i}" style="--dot-color:${TIERS[r.tier]?.color || '#43556b'}"><span class="review-number">${i + 1}</span><i class="review-dot">${tierImage(r.tier)}</i><span class="review-question">${escape(promptText(i))}<small>${escape(r.answer || '—')}</small></span><span class="review-points">${r.score}</span><span class="review-sign">+</span></button><div class="review-expanded" hidden></div></li>`).join('')}</ul>
  <p class="rule">LOGBOOK</p><p class="logbook-line">streak ${stats.current} · played ${stats.played} · avg ${stats.average} · best ${stats.best}</p><p class="reset-countdown" id="reset-countdown"></p>
  <footer class="original-footer result-footer"><p>one in a ${escape(GAME.name.toLowerCase())}.</p><p class="independent">Built on top of <a href="https://github.com/VulcanEon/openkrillion.com-service" target="_blank" rel="noopener noreferrer">OpenKrillion</a> (MIT). A private game for one group chat.</p></footer>`;
  $('results').scrollTop = 0; updateHud();
  try { review = await api('review?run=' + encodeURIComponent(game.runId)); if (phase === 'done') $('distribution').innerHTML = boardHtml(review); }
  catch { $('distribution').innerHTML = '<p>Leaderboard temporarily unavailable. Your score is saved.</p>'; }
}
function resultText() { return shareText(game.dayNumber, game.results, game.mode === 'practice'); }
async function copyResult(button) {
  try { await navigator.clipboard.writeText(resultText()); button.textContent = 'Copied ✓'; setTimeout(() => button.textContent = 'Copy result', 2200); }
  catch { button.textContent = 'Select and copy above'; const range = document.createRange(); range.selectNodeContents($('share-preview')); getSelection().removeAllRanges(); getSelection().addRange(range); }
}
async function expandReview(button) {
  const i = Number(button.dataset.review), box = button.nextElementSibling, open = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!open)); button.querySelector('.review-sign').textContent = open ? '+' : '−'; box.hidden = open; if (open) return;
  if (!review) { box.innerHTML = '<p class="muted">Loading accepted answers…</p>'; try { review = await api('review?run=' + encodeURIComponent(game.runId)); } catch { box.innerHTML = '<p class="muted">Could not load answers. Close and try again.</p>'; return; } }
  const answers = review.prompts[i].answers, own = game.results[i].answer;
  box.innerHTML = `${answers.length > 30 ? '<input class="search-answers" aria-label="Search accepted answers" placeholder="search ' + answers.length + ' answers…">' : ''}<ul class="review-list">${answers.map(a => `<li data-answer="${escape(a.answer.toLowerCase())}" style="color:${TIERS[a.tier].color}"><span>${escape(a.answer)}${a.answer === own ? '<b class="you">YOU</b>' : ''}<small class="review-tier">${TIERS[a.tier].emoji} ${TIERS[a.tier].name}</small>${a.quip ? '<small>' + escape(a.quip) + '</small>' : ''}</span><span>+${a.score}</span></li>`).join('')}</ul>`;
}
function openLogbook() {
  const s = historyStats();
  $('logbook-content').innerHTML = `<div class="stats-grid"><div><strong>${s.current}</strong><span>Current streak</span></div><div><strong>${s.bestStreak}</strong><span>Best streak</span></div><div><strong>${s.played}</strong><span>Daily dives</span></div><div><strong>${s.best}</strong><span>Best daily score</span></div></div><ul class="history-list">${Object.values(s.history).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map(r => `<li><span>${escape(r.date)} <small>${escape(r.mode)}</small></span><span>${r.score} pts · ${r.score * 10}m</span></li>`).join('') || '<li>Your next dive starts your logbook.</li>'}</ul>`;
  openDialog('logbook-dialog');
}
function openWardrobe() { const best = historyStats().bestStreak; $('buddy-list').innerHTML = buddyOptions.map(b => `<button data-buddy="${b.id}" aria-pressed="${settings.buddy === b.id}" ${best < b.streak ? 'disabled' : ''}><img src="${b.src}" alt=""><span>${b.name}</span><small>${best >= b.streak ? 'Earned' : b.streak + '-day streak'}</small></button>`).join(''); openDialog('wardrobe-dialog'); }
async function pauseGame() { if (!game || !['preview', 'answering'].includes(phase) || paused) return; paused = true; try { dialogPausePending = api('pause', { runId: game.runId, paused: true }); setGame(await dialogPausePending); } catch { paused = false; } finally { dialogPausePending = null; } }
async function resumeGame() { if (leaving || document.querySelector('dialog[open]') || !paused) return; const rid = game.runId; try { if (dialogPausePending) await dialogPausePending; const resumed = await api('pause', { runId: rid, paused: false }); if (game.runId === rid) setGame(resumed); paused = false; tick(); } catch (e) { if (e.status === 404) { lostDive(); return; } $('answer-status').textContent = 'Could not resume. Reopen the menu and try again.'; } }
function openDialog(id) { document.querySelectorAll('dialog[open]').forEach(d => d.close()); $(id).showModal(); void pauseGame(); }
function doAction(action) {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  if (action === 'daily') { if (game?.mode === 'daily') void resumeView(); else void begin(false); }
  if (action === 'practice') void begin(true);
  if (action === 'settings') openDialog('settings-dialog');
  if (action === 'logbook') openLogbook();
  if (action === 'switch') void switchMember();
  if (action === 'logout') void logout();
}
// "Not you? Switch": forget the name on this device (the server session keeps the password).
// Before leaving, un-pause the dive so it isn't left frozen on the server.
let leaving = false;
async function leaveDive() {
  leaving = true;
  if (game && paused) { try { await (dialogPausePending || Promise.resolve()); await api('pause', { runId: game.runId, paused: false }); } catch { /* the server also resumes on the next start */ } }
}
async function switchMember() {
  await leaveDive();
  try { await api('member', { memberId: null }); } catch { /* reload shows the right screen either way */ }
  location.reload();
}
async function logout() {
  await leaveDive();
  try { await api('logout', {}); } catch { /* the reload shows the password screen either way */ }
  location.reload();
}
// Name picker. Resolves with the picked member; can't be dismissed without picking.
async function pickMember() {
  const dialog = $('who-dialog'), list = $('member-list');
  list.innerHTML = '<p class="muted">Loading names…</p>';
  dialog.showModal();
  const { members } = await api('members');
  if (!members.length) { list.innerHTML = '<p class="muted">No names yet. Ask whoever runs the game to add you.</p>'; return new Promise(() => {}); }
  list.innerHTML = members.map(m => `<button type="button" role="listitem" data-member="${escape(m.id)}">${escape(m.name)}</button>`).join('');
  return new Promise(resolve => {
    list.onclick = async e => {
      const b = e.target.closest('[data-member]'); if (!b) return;
      list.querySelectorAll('button').forEach(x => x.disabled = true); b.setAttribute('aria-pressed', 'true');
      try { const { member } = await api('member', { memberId: b.dataset.member }); dialog.close(); resolve(member); }
      catch (err) { $('who-status').textContent = err.message; list.querySelectorAll('button').forEach(x => x.disabled = false); b.removeAttribute('aria-pressed'); }
    };
  });
}
function tick() {
  if (game && ['preview', 'answering'].includes(phase) && !paused) {
    const remaining = game.roundStart + ROUND_MS - now();
    if (now() < game.roundStart) {
      const count = Math.max(1, Math.ceil((game.roundStart - now()) / 1000));
      $('preview-label').textContent = `descending · the clock starts in ${count}`; $('timer-number').textContent = count; document.documentElement.style.setProperty('--time', 1);
    } else {
      if (phase === 'preview') { setPhase('answering'); $('answer').disabled = false; $('preview-label').textContent = ''; $('answer').focus({ preventScroll: true }); }
      $('submit-btn').disabled = busy || !$('answer').value.trim();
      const seconds = Math.max(0, Math.ceil(remaining / 1000));
      document.body.classList.toggle('timer-hot', remaining <= 3050); $('timer-number').textContent = seconds;
      document.documentElement.style.setProperty('--time', Math.max(0, remaining / ROUND_MS));
      document.documentElement.style.setProperty('--urgency', seconds <= 3 && !scene.reduced ? (1 - seconds / 4) * (.35 + Math.sin(Date.now() * .012) * .2) : 0);
      if (seconds > 0 && seconds <= 3 && seconds !== lastTick) { sound.event('tick'); lastTick = seconds; }
      if (remaining <= 0 && !autoSent && !busy) { autoSent = true; void submit(true); }
    }
  } else document.documentElement.style.setProperty('--urgency', 0);
  if ($('reset-countdown') && game) { const d = Math.max(0, (game.resetsAt - now()) / 1000), h = Math.floor(d / 3600), m = Math.floor(d % 3600 / 60), s = Math.floor(d % 60); $('reset-countdown').textContent = `next dive in ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
  if (game) $('depth').textContent = Math.round(scene.depth).toLocaleString('en-US') + 'm';
}
$('start-btn').addEventListener('click', () => begin(false)); $('practice-btn').addEventListener('click', () => begin(true));
$('menu-btn').addEventListener('click', () => openDialog('menu-dialog')); $('settings-btn').addEventListener('click', () => openDialog('settings-dialog'));
$('wardrobe-btn').addEventListener('click', openWardrobe); $('logbook-btn').addEventListener('click', openLogbook); $('next-btn').addEventListener('click', next);
$('mute-btn').addEventListener('click', async () => { await sound.init(); settings.muted = !settings.muted; write('settings', settings); applySettings(); });
$('mascot').addEventListener('click', async () => { await sound.init(); sound.event('blub'); $('mascot').classList.remove('poked'); void $('mascot').offsetWidth; $('mascot').classList.add('poked'); setTimeout(() => $('mascot').classList.remove('poked'), 1000); });
$('answer-form').addEventListener('submit', e => { e.preventDefault(); void submit(false); });
$('answer').addEventListener('input', () => { const r = $('answer').getBoundingClientRect(); scene.typeAt(r.left + 14 + Math.min(11 * $('answer').value.length, r.width - 28), r.top + 5); write('draft:' + game.runId + ':' + game.round, $('answer').value); if (correction !== $('answer').value) { correction = null; $('answer-status').textContent = ''; } tick(); });
document.addEventListener('click', e => {
  const close = e.target.closest('[data-close]'); if (close) close.closest('dialog').close();
  const action = e.target.closest('[data-action]'); if (action) doAction(action.dataset.action);
  const r = e.target.closest('[data-review]'); if (r) void expandReview(r);
  const copy = e.target.closest('#copy-result'); if (copy) void copyResult(copy);
  if (e.target.closest('#native-share')) navigator.share?.({ text: resultText() }).catch(() => {});
  const buddy = e.target.closest('[data-buddy]'); if (buddy) { settings.buddy = buddy.dataset.buddy; write('settings', settings); applySettings(); openWardrobe(); }
});
document.addEventListener('change', e => { if (e.target.matches('[data-setting]')) { settings[e.target.dataset.setting] = e.target.checked; write('settings', settings); applySettings(); } });
document.addEventListener('input', e => { if (e.target.matches('.search-answers')) { const text = e.target.value.toLowerCase(); e.target.nextElementSibling.querySelectorAll('li').forEach(li => li.hidden = !li.dataset.answer.includes(text)); } });
$('who-dialog').addEventListener('cancel', e => e.preventDefault());
document.querySelectorAll('dialog').forEach(d => { d.addEventListener('close', () => void resumeGame()); d.addEventListener('click', e => { if (e.target === d && d.id !== 'who-dialog') { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } }); });
document.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'f' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !e.ctrlKey && !e.metaKey) { if (document.fullscreenElement) document.exitFullscreen?.(); else $('game').requestFullscreen?.().catch(() => {}); } });
function viewport() { const height = window.visualViewport?.height || innerHeight; document.documentElement.style.setProperty('--vh', height + 'px'); }
viewport(); window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport);
setInterval(tick, 80);
(async () => {
  try {
    const session = await api('session');
    if (!session.authenticated) { location.reload(); return; }
    csrf = session.csrf;
    const member = session.member || await pickMember();
    scope = member.id + ':';
    $('who-name').textContent = member.name; $('who-line').hidden = false;
    applySettings();
    today = await api('today'); $('day-number').textContent = 'DIVE #' + today.dayNumber;
    const saved = read('run', null);
    if (saved?.date === today.date && saved?.runId) {
      try { setGame(await api('state?run=' + encodeURIComponent(saved.runId))); if (game.pausedAt) setGame(await api('pause', { runId: game.runId, paused: false })); await resumeView(); }
      catch { write('run', null); }
    }
  } catch (e) { $('boot-error').textContent = e.message; $('boot-error').hidden = false; }
})();
