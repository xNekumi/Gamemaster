/* Gemeinsame Darstellung für "Quiz-Duell" (Jeopardy) – Admin- und Spieler-Ansicht. */
(function () {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  function avatarInner(name, url) {
    if (window.GM && GM.avatarInner) return GM.avatarInner(name, url);
    const initials = String(name || '?').trim().slice(0, 2).toUpperCase();
    return url
      ? `<img class="av-img" src="${url}" alt="">`
      : `<div class="av-fallback">${esc(initials)}</div>`;
  }

  function fmt(n) {
    return (n > 0 ? '+' : '') + n;
  }

  // ---- Spieler links/rechts um das Board (nach Teams gruppiert)
  function teamColHtml(team, avatars) {
    const players = (team.players || [])
      .map(
        (p) => `<div class="jp-player" title="${esc(p.name)}">
          <div class="jp-player-ava" style="border-color:${team.color}">${avatarInner(p.name, (avatars || {})[p.id])}</div>
          <span class="jp-player-name">${esc(p.name)}</span>
        </div>`
      )
      .join('');
    const badges = [];
    if (team.isCurrent) badges.push('<span class="jp-badge turn">am Zug</span>');
    if (team.onCoffee) badges.push('<span class="jp-badge coffee">☕ Pause</span>');
    return `<div class="jp-team-col ${team.isCurrent ? 'is-current' : ''}" style="--tc:${team.color}">
      <div class="jp-team-col-head" style="background:${team.color}">
        <span class="jp-team-col-name">${esc(team.name)}</span>
        <span class="jp-team-col-score">${team.score}</span>
      </div>
      <div class="jp-team-col-badges">${badges.join('')}</div>
      <div class="jp-team-players">${players || '<span class="jp-empty">–</span>'}</div>
    </div>`;
  }

  function renderSidePlayers(leftEl, rightEl, state, avatars) {
    const teams = state.teams || [];
    const mid = Math.ceil(teams.length / 2);
    const left = teams.slice(0, mid);
    const right = teams.slice(mid);
    leftEl.innerHTML = left.map((t) => teamColHtml(t, avatars)).join('');
    rightEl.innerHTML = right.map((t) => teamColHtml(t, avatars)).join('');
    rightEl.classList.toggle('hidden', right.length === 0);
  }

  // ---- Scoreboard unter dem Board
  function renderScoreboard(el, state) {
    const st = state.standings || state.teams || [];
    el.innerHTML = st
      .map(
        (t, i) => `<div class="jp-score-chip ${t.isCurrent ? 'current' : ''}" style="--tc:${t.color}">
          <span class="jp-score-rank">${i + 1}</span>
          <span class="jp-score-dot" style="background:${t.color}"></span>
          <span class="jp-score-name">${esc(t.name)}</span>
          <b class="jp-score-val">${t.score}</b>
        </div>`
      )
      .join('');
  }

  // ---- Board (Kacheln)
  function renderBoard(el, state, opts = {}) {
    const board = state.board;
    if (!board) { el.innerHTML = ''; return; }
    const pend = state.pendingSelection || null;
    const cols = board.categories
      .map((cat) => {
        const tiles = cat.questions
          .map((q) => {
            const cls = ['jp-tile'];
            if (q.done) cls.push('done');
            else if (opts.clickable) cls.push('pickable');
            const isPend = pend && pend.ci === q.ci && pend.qi === q.qi;
            if (isPend) cls.push('pending');
            const style = isPend && pend.teamColor ? ` style="--tc:${pend.teamColor}"` : '';
            const label = isPend
              ? `<span class="jp-tile-pick" style="background:${pend.teamColor || 'var(--primary)'}">${esc(pend.teamName || '')} wählt…</span>`
              : '';
            return `<button type="button" class="${cls.join(' ')}"${style} data-ci="${q.ci}" data-qi="${q.qi}" ${
              q.done || !opts.clickable ? 'disabled' : ''
            }>${q.done ? '' : q.value}${label}</button>`;
          })
          .join('');
        return `<div class="jp-col">
          <div class="jp-cat">${esc(cat.name)}</div>
          ${tiles}
        </div>`;
      })
      .join('');
    el.innerHTML = `<div class="jp-board-inner" style="--cols:${board.categories.length}">${cols}</div>`;
    if (opts.clickable && typeof opts.onPick === 'function') {
      el.querySelectorAll('.jp-tile.pickable').forEach((b) =>
        b.addEventListener('click', () => opts.onPick(Number(b.dataset.ci), Number(b.dataset.qi)))
      );
    }
  }

  // ---- Offene Frage (großes Karten-Overlay)
  function renderQuestion(el, state, opts = {}) {
    const c = state.current;
    if (!c) { el.innerHTML = ''; return; }
    const t = state.timer || (c.timer || {});
    const answering = c.answeringTeamColor
      ? `<div class="jp-answering" style="--tc:${c.answeringTeamColor}">
           <span class="jp-answering-dot" style="background:${c.answeringTeamColor}"></span>
           ${esc(c.answeringTeamName)} ${c.stage === 'stealAnswering' ? '<span class="jp-steal-tag">geklaut!</span>' : ''}
         </div>`
      : '';
    let stageNote = '';
    if (c.stage === 'stealOpen') stageNote = '<div class="jp-stage-note buzz">🚨 Buzzer offen – klauen möglich!</div>';
    const jokerTags = [];
    if (c.aonTeamId) jokerTags.push('<span class="jp-joker-tag aon">🎲 Alles oder Nichts</span>');
    if (c.noRiskTeamId) jokerTags.push('<span class="jp-joker-tag norisk">🛡️ Kein Risiko</span>');

    const outcome = c.lastOutcome
      ? `<div class="jp-outcome ${c.lastOutcome.correct ? 'correct' : 'wrong'}">
           ${c.lastOutcome.correct ? '✅ Richtig' : '❌ Falsch'} ·
           <b>${esc(c.lastOutcome.teamName)}</b> ${fmt(c.lastOutcome.delta)}
         </div>`
      : '';

    const answerHtml = opts.admin && c.answer !== undefined
      ? `<div class="jp-answer">✅ Lösung: <b>${esc(c.answer)}</b></div>`
      : '';

    const secs = Math.ceil((t.remainingMs || 0) / 1000);
    el.innerHTML = `
      <div class="jp-qcard">
        <div class="jp-qcard-top">
          <span class="jp-qcat">${esc(c.category)}</span>
          <span class="jp-qval">${c.value}</span>
        </div>
        <div class="jp-qtext">${esc(c.question)}</div>
        ${answerHtml}
        <div class="jp-qmeta">
          ${answering}
          <div class="jp-timer ${t.running ? 'running' : ''} ${secs <= 5 && secs > 0 ? 'low' : ''} ${secs === 0 ? 'zero' : ''}"
               data-ends="${t.running ? t.endsAt || '' : ''}" data-remaining="${t.remainingMs || 0}">
            <span class="jp-timer-val">${secs}</span><small>s</small>
          </div>
        </div>
        ${jokerTags.length ? `<div class="jp-joker-tags">${jokerTags.join('')}</div>` : ''}
        ${stageNote}
        ${outcome}
      </div>`;
  }

  // Verbleibende ms aus einem timer-View berechnen (fürs Ticken).
  function timerRemaining(timer) {
    if (!timer) return 0;
    if (timer.running && timer.endsAt) return Math.max(0, timer.endsAt - Date.now());
    return timer.remainingMs || 0;
  }

  window.JeopardyUI = {
    renderSidePlayers,
    renderScoreboard,
    renderBoard,
    renderQuestion,
    timerRemaining,
    esc,
  };
})();
