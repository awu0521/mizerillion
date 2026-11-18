// Page shell, adapted from OpenKrillion's src/html.mjs (MIT). Contains no prompt or answer data.
import { GAME } from '../public/site.mjs';

export const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function head(title) {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#050a14"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="icon" href="/assets/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"><link rel="preload" href="/assets/vt323-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/style.css">`;
}
const heroWord = name => [...name.toUpperCase()].map((ch, i) => `<span style="--letter:${i}">${esc(ch)}</span>`).join('');
const settings = [
  ['lowPower', 'Low-power mode', 'Lighter graphics and fewer background animations.'],
  ['colorblind', 'Colorblind mode', 'Brighter text and more separated tier colors.'],
  ['corrections', 'Answer corrections', 'Preview corrected answers before scoring.'],
  ['clearRejected', 'Clear rejected entries', 'Empty the answer box after a failed attempt.'],
];

export function gamePage(env = {}) {
  const name = GAME.name;
  return `<!doctype html><html lang="en"><head>${head(name + ' — the daily dive')}</head><body data-phase="intro"><main id="game" aria-label="${esc(name)} daily trivia game"><canvas id="ocean" aria-label="Animated pixel ocean, depth increases downward"></canvas><div class="vignette" aria-hidden="true"></div><div class="danger-glow" aria-hidden="true"></div><div class="crt" aria-hidden="true"></div><div class="flash" aria-hidden="true"></div>
  <button id="menu-btn" class="square menu-btn" aria-label="Open menu" aria-haspopup="dialog">☰</button>
  <div class="utility"><button class="square" id="mute-btn" aria-label="Turn sound off" aria-pressed="false">◀Ⅰ</button><button class="square" id="settings-btn" aria-label="Open settings" aria-haspopup="dialog">⚙</button><button class="square" id="wardrobe-btn" aria-label="Open wardrobe" aria-haspopup="dialog"><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M6 2h2v2h4V2h2v2h2v2h2v4h-4v8H6v-8H2V6h2V4h2z"/></svg></button></div>
  <header class="hero" id="hero"><h1 aria-label="${esc(name)}"><span class="open-label">THE GROUP CHAT · KRILLION</span><span class="hero-word">${heroWord(name)}</span></h1><p class="tagline">THE DAILY DIVE</p><p class="subline">7 prompts · 25 seconds each · rarer answers sink deeper</p></header>
  <section class="hud" aria-label="Dive progress"><div class="hud-pod pixel-frame"><span>DEPTH</span><strong id="depth">0m</strong></div><div class="round-progress"><div id="round-dots">${Array.from({ length: 7 }, (_, i) => `<i data-round="${i}"></i>`).join('')}</div><span id="round-label">SURFACE</span></div><div class="hud-pod pixel-frame"><span>SCORE</span><strong id="score">0</strong></div></section>
  <button id="mascot" class="mascot" aria-label="Poke your dive buddy" title="a friend"><img src="/assets/krill.svg" width="56" height="56" alt="Pixel krill"><span>blub!</span></button>
  <section id="prompt-card" class="prompt-card pixel-frame" aria-live="polite" hidden><p class="eyebrow" id="prompt-number">PROMPT 1 OF 7</p><h2 id="prompt-text"></h2><p class="hint">▼ rarer answers sink deeper ▼</p></section>
  <section id="landing" class="landing pixel-frame" aria-live="polite" hidden><img id="land-icon" class="land-icon" src="/assets/plankton.svg" alt="" width="88" height="88"><p class="eyebrow" id="land-tier"></p><h2 id="land-answer"></h2><p id="land-points"></p><p id="land-quip"></p></section>
  <div id="falling-answer" class="falling-answer" hidden></div><div id="tier-ladder" class="tier-ladder" aria-hidden="true" hidden></div>
  <div class="intro" id="intro"><details class="how-to"><summary>HOW TO PLAY</summary><ul><li>7 prompts a day, pulled from the chat. same for everyone.</li><li>25 seconds to name one thing.</li><li>rare answers score big. obvious ones float.</li><li>wrong guesses cost nothing. keep trying until the clock runs out.</li><li>every point sinks you 10 metres. 700 is the trench.</li><li>one daily dive. practice whenever you like.</li></ul></details><p class="who-line" id="who-line" hidden>diving as <b id="who-name"></b> · <button class="text-button" data-action="switch">not you? switch</button></p><button id="start-btn" class="begin-btn">▼ BEGIN DESCENT ▼</button><div class="intro-meta"><span id="day-number">DIVE …</span><nav><button id="logbook-btn">LOGBOOK ⟲</button><button id="practice-btn">PRACTICE ∞</button></nav></div><p id="boot-error" class="error" hidden></p></div>
  <div id="answer-dock" class="answer-dock" hidden><div class="answer-status" role="status" id="answer-status"></div><form id="answer-form" autocomplete="off"><div class="timer" aria-label="Seconds remaining"><span id="timer-number">25</span><svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="25"/><circle class="timer-ring" cx="30" cy="30" r="25"/></svg></div><div class="input-wrap"><label class="sr-only" for="answer">Your answer</label><input id="answer" name="answer" placeholder="type one answer…" maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="send"><div class="time-bar"></div></div><button id="submit-btn" type="submit">DIVE</button></form></div><p class="preview-label pixel-frame" id="preview-label" hidden></p>
  <div class="next-wrap" id="next-wrap" hidden><button class="next-btn" id="next-btn">DESCEND ▼</button></div>
  <section class="results" id="results" aria-label="Dive results" hidden tabindex="-1"></section>
  <noscript><div class="noscript">${esc(name)} needs JavaScript for the animated game.</div></noscript></main>
  <dialog id="menu-dialog" class="panel"><button class="close" data-close aria-label="Close menu">×</button><p class="eyebrow">${esc(name.toUpperCase())}</p><h2>Menu</h2><p class="rule">DIVE IN</p><nav class="menu-nav"><button data-action="daily">↓ Daily dive</button><button data-action="practice">∞ Practice dive</button><button data-action="logbook">⟲ My logbook</button><button data-action="settings">⚙ Settings</button><button data-action="switch">⇄ Not you? Switch</button><button data-action="logout">⏏ Log out</button></nav><p class="panel-signoff">one in a ${esc(name.toLowerCase())}.</p></dialog>
  <dialog id="who-dialog" class="panel who-panel" aria-labelledby="who-title"><p class="eyebrow">MEMBERS ONLY</p><h2 id="who-title">Who’s diving?</h2><div id="member-list" class="member-list" role="list"></div><p class="muted" id="who-status">Your name is remembered on this device.</p>
    <details id="name-missing" class="name-missing"><summary>Name not here?</summary>
      <form id="add-me-form" autocomplete="off"><p class="muted">Ask whoever runs the game to add you, or add yourself with the admin password.</p>
        <input id="add-me-name" maxlength="40" placeholder="your name" aria-label="Your name" required>
        <input id="add-me-admin" type="password" maxlength="1024" placeholder="admin password" aria-label="Admin password" autocomplete="off" required>
        <button type="submit" class="quiet">Add me</button>
        <p id="add-me-status" class="error" role="alert" hidden></p></form></details>
    <p class="who-back"><button type="button" class="text-button" id="who-back">← Back to the password screen</button></p></dialog>
  <dialog id="settings-dialog" class="panel"><button class="close" data-close aria-label="Close settings">×</button><h2>Settings</h2>${settings.map(([key, title, help]) => `<label class="setting"><span><strong>${title}</strong><small>${help}</small></span><input type="checkbox" data-setting="${key}"><span class="toggle" aria-hidden="true"></span></label>`).join('')}<p class="rule">YOUR LOGBOOK</p><button class="quiet" data-action="logbook">My dives →</button><p class="muted">Settings are saved on this device.</p></dialog>
  <dialog id="wardrobe-dialog" class="panel"><button class="close" data-close aria-label="Close wardrobe">×</button><h2>Dive buddy</h2><div id="buddy-list" class="buddy-list"></div><p class="muted">Earn buddies with your best daily streak.</p></dialog>
  <dialog id="logbook-dialog" class="panel"><button class="close" data-close aria-label="Close logbook">×</button><p class="eyebrow">YOUR DIVER’S LOGBOOK</p><h2>My ${esc(name)}</h2><div id="logbook-content"></div><p class="muted">Daily dives extend streaks. Practice dives don’t.</p></dialog>
  <a href="/admin" class="admin-link" aria-label="Admin">Admin</a>
  <script id="runtime-config" type="application/json">${JSON.stringify({ local: env.LOCAL_DEVELOPMENT === 'true' }).replace(/</g, '\\u003c')}</script><script type="module" src="/app.mjs"></script></body></html>`;
}

// The only page shown without a player session: game name, ocean art and a password box.
// It contains no prompts, answers, scores or member names.
export function loginPage(env = {}) {
  const name = GAME.name;
  return `<!doctype html><html lang="en"><head>${head(name + ' — members only')}</head><body data-phase="intro" class="login-page"><main id="game" aria-label="${esc(name)}: members only"><canvas id="ocean" aria-hidden="true"></canvas><div class="vignette" aria-hidden="true"></div><div class="crt" aria-hidden="true"></div>
  <button id="mascot" class="mascot" aria-label="Poke the krill" title="a friend" type="button"><img src="/assets/krill.svg" width="56" height="56" alt="Pixel krill"><span>blub!</span></button>
  <header class="hero" id="hero"><h1 aria-label="${esc(name)}"><span class="open-label">THE GROUP CHAT · KRILLION</span><span class="hero-word">${heroWord(name)}</span></h1><p class="tagline">MEMBERS ONLY</p><p class="subline">the daily dive for one group chat</p></header>
  <div class="intro login" id="intro"><form id="login-form" class="login-form" autocomplete="on" novalidate><label for="password" class="login-label">PASSWORD</label><div class="login-row"><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" placeholder="the group password" enterkeyhint="go"><button id="login-btn" class="begin-btn" type="submit">DIVE IN ▼</button></div><p id="login-error" class="error" role="alert" hidden></p></form></div>
  <noscript><div class="noscript">${esc(name)} needs JavaScript.</div></noscript></main>
  <a href="/admin" class="admin-link" aria-label="Admin">Admin</a>
  <script type="module" src="/login.mjs"></script></body></html>`;
}

// Admin page: public HTML and JS; prompt and answer data load only with an admin session.
export function adminPage(env = {}, { signedIn = false } = {}) {
  const name = GAME.name, show = on => on ? '' : ' hidden';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(name)} — admin</title><link rel="icon" href="/assets/favicon.png" type="image/png"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/admin.css"></head>
<body class="admin-page" data-signed-in="${signedIn}">
  <header class="admin-bar" id="admin-bar"${show(signedIn)}><a class="admin-home" href="/">← ${esc(name.toUpperCase())}</a><h1>Admin</h1><span id="session-info" class="muted"></span><button id="logout-btn" class="quiet" type="button"${show(signedIn)}>Log out</button></header>
  <div id="idle-warning" class="idle-warning" role="alert" hidden><span id="idle-text"></span> <button id="stay-btn" type="button" class="quiet">Stay signed in</button></div>
  <section id="login-view" class="admin-login"${show(!signedIn)}><p class="admin-login-brand">${esc(name.toUpperCase())}</p><h2>Admin password</h2><form id="admin-login-form" novalidate><input id="admin-password" type="password"${signedIn ? '' : ' autofocus'} autocomplete="current-password" maxlength="1024" placeholder="admin password" aria-label="Admin password"><button id="admin-login-btn" type="submit">Sign in</button></form><p id="admin-login-error" class="error" role="alert" hidden></p><p class="muted" id="admin-login-note"></p><p><a class="admin-back" href="/">← back to the game</a></p></section>
  <nav id="admin-tabs" class="admin-tabs" role="tablist" aria-label="Admin sections"${show(signedIn)}><button type="button" role="tab" data-tab="prompts" aria-selected="true">Prompts</button><button type="button" role="tab" data-tab="members" aria-selected="false">Members</button><button type="button" role="tab" data-tab="settings" aria-selected="false">Settings</button></nav>
  <div class="tab-panel" id="panel-prompts" data-panel="prompts" role="tabpanel"${show(signedIn)}>
  <main id="editor-view" class="admin-editor">
    <button id="show-list-btn" class="show-list-btn" type="button" hidden aria-controls="list-pane">☰ Prompts</button>
    <aside class="prompt-list-pane" id="list-pane"><div class="list-head"><button id="new-prompt-btn" class="new-prompt-btn" type="button">+ New prompt</button><button id="hide-list-btn" class="quiet" type="button" aria-controls="list-pane" title="Hide the prompt list">◀ hide</button></div>
      <input id="prompt-search" type="search" placeholder="search prompts or answers…" aria-label="Search prompts">
      <div class="list-filters"><select id="filter-category" aria-label="Category"><option value="">All categories</option></select>
        <div class="status-filter" role="group" aria-label="Show"><button type="button" data-status="all" aria-pressed="true">All</button><button type="button" data-status="on" aria-pressed="false">On</button><button type="button" data-status="off" aria-pressed="false">Off</button><button type="button" data-status="review" aria-pressed="false" title="Needs review">Review</button><button type="button" data-status="warn" aria-pressed="false" title="Has a warning">⚠</button></div></div>
      <p id="prompt-count" class="muted">${signedIn ? 'Loading prompts…' : ''}</p><ul id="prompt-list" class="prompt-list"></ul></aside>
    <section id="prompt-pane" class="prompt-pane" aria-live="polite"><p class="muted">Pick a prompt from the list.</p></section>
  </main>
  <section class="admin-extras"><details open><summary>Upcoming prompts</summary><div id="preview"></div></details></section>
  </div>
  <div class="tab-panel" id="panel-members" data-panel="members" role="tabpanel" hidden>
    <section class="admin-extras members-panel"><h2>Members</h2><p class="muted">The names players pick after the password. Hiding a name removes it from the picker but keeps their past dives and scores.</p>
      <form id="add-member-form" class="add-member" autocomplete="off"><input id="new-member-name" maxlength="40" placeholder="Add a name…" aria-label="New member name" required><button type="submit" class="primary">Add</button></form>
      <p id="member-count" class="muted"></p><ul id="member-admin-list" class="member-admin-list"></ul></section>
  </div>
  <div class="tab-panel" id="panel-settings" data-panel="settings" role="tabpanel" hidden>
    <section class="admin-extras">
      <details open><summary>Launch date</summary><div id="launch"></div></details>
      <details open><summary>Login lockouts</summary><div id="lockouts"></div></details>
      <details open><summary>Audit log</summary><div id="audit"></div></details>
    </section>
  </div>
  <div id="tier-menu" class="tier-menu" role="listbox" hidden></div>
  <div id="toast" class="toast" role="status" hidden></div>
  <script type="module" src="/admin.mjs"></script>
</body></html>`;
}
