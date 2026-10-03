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
          <div class="jp-player-ava">${avatarInner(p.name, (avatars || {})[p.id])}</div>
          <span class="jp-player-name">${esc(p.name)}</span>
        </div>`
      )
      .join('');
    const badges = [];
    if (team.isCurrent) badges.push('<span class="jp-badge turn">am Zug</span>');
    if (team.onCoffee) badges.push('<span class="jp-badge coffee">☕ Pause</span>');
    return `<div class="jp-team-col ${team.isCurrent ? 'is-current' : ''}" style="--tc:${team.color}">
      <div class="jp-team-col-head">
        <span class="jp-team-col-name"><span class="jp-team-swatch"></span>${esc(team.name)}</span>
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
    const anim = !!opts.animate; // gestaffelter Eintritt nur beim Einblenden des Boards
    const cols = board.categories
      .map((cat, ci2) => {
        const catDelay = anim ? ` style="animation-delay:${(0.04 + ci2 * 0.05).toFixed(2)}s"` : '';
        const tiles = cat.questions
          .map((q) => {
            const cls = ['jp-tile'];
            if (q.done) cls.push('done');
            else if (opts.clickable) cls.push('pickable');
            const isPend = pend && pend.ci === q.ci && pend.qi === q.qi;
            if (isPend) cls.push('pending');
            const styles = [];
            if (isPend && pend.teamColor) styles.push(`--tc:${pend.teamColor}`);
            if (anim) styles.push(`animation-delay:${(0.14 + ci2 * 0.05 + q.qi * 0.045).toFixed(2)}s`);
            const style = styles.length ? ` style="${styles.join(';')}"` : '';
            const label = isPend
              ? `<span class="jp-tile-pick" style="background:${pend.teamColor || 'var(--jp-accent, var(--primary))'}">${esc(pend.teamName || '')} wählt…</span>`
              : '';
            return `<button type="button" class="${cls.join(' ')}"${style} data-ci="${q.ci}" data-qi="${q.qi}" ${
              q.done || !opts.clickable ? 'disabled' : ''
            }>${q.done ? '' : q.value}${label}</button>`;
          })
          .join('');
        return `<div class="jp-col">
          <div class="jp-cat"${catDelay}>${esc(cat.name)}</div>
          ${tiles}
        </div>`;
      })
      .join('');
    el.innerHTML = `<div class="jp-board-inner${anim ? ' jp-anim-in' : ''}" style="--cols:${board.categories.length}">${cols}</div>`;
    if (opts.clickable && typeof opts.onPick === 'function') {
      el.querySelectorAll('.jp-tile.pickable').forEach((b) =>
        b.addEventListener('click', () => opts.onPick(Number(b.dataset.ci), Number(b.dataset.qi)))
      );
    }
  }

  // ---- Synchronisierte Medien-Wiedergabe (Bild/Audio/Video) --------------
  // Das Medien-Element lebt in einem eigenen Host-Container, damit es beim
  // Neu-Rendern der Fragekarte NICHT neu erzeugt wird (sonst würde die
  // Wiedergabe stocken/neu starten).
  function syncMedia(host, media, playing, positionMs, cmd) {
    if (!media || !media.url) { clearMedia(host); host.style.display = 'none'; return; }
    host.style.display = '';
    if (host._jpUrl !== media.url || host._jpType !== media.type) {
      clearMedia(host);
      host._jpUrl = media.url;
      host._jpType = media.type;
      host._jpCmd = -1;
      let elm;
      if (media.type === 'image') {
        elm = document.createElement('img');
        elm.className = 'jp-media-img';
        elm.src = media.url;
      } else {
        elm = document.createElement(media.type === 'audio' ? 'audio' : 'video');
        elm.className = 'jp-media-' + media.type;
        elm.src = media.url;
        elm.setAttribute('playsinline', '');
        elm.preload = 'auto';
        // Bewusst KEINE controls -> Spieler können nicht selbst steuern.
        if (media.type === 'audio') {
          elm.style.display = 'none';
          const viz = document.createElement('div');
          viz.className = 'jp-media-audio-viz';
          viz.innerHTML = '<span>🔊</span><i></i><i></i><i></i><i></i><i></i>';
          host.appendChild(viz);
        }
      }
      host.appendChild(elm);
      host._jpMedia = elm;
    }
    const elm = host._jpMedia;
    if (!elm || media.type === 'image') return;
    // Play/Pause/Seek nur anwenden, wenn sich das Kommando geändert hat
    // (verhindert Ruckeln bei sonstigen State-Updates).
    if (host._jpCmd !== cmd) {
      host._jpCmd = cmd;
      const target = (positionMs || 0) / 1000;
      try { if (Math.abs((elm.currentTime || 0) - target) > 0.4) elm.currentTime = target; } catch (e) {}
      if (playing) {
        const p = elm.play();
        if (p && p.catch) p.catch(() => showMediaTap(host));
      } else {
        try { elm.pause(); } catch (e) {}
      }
    }
    // Audio-Visualizer an Wiedergabe koppeln
    const viz = host.querySelector('.jp-media-audio-viz');
    if (viz) viz.classList.toggle('playing', !!playing);
  }
  function showMediaTap(host) {
    if (host.querySelector('.jp-media-tap')) return;
    const b = document.createElement('button');
    b.className = 'jp-media-tap';
    b.textContent = '🔊 Tippen, um Ton zu aktivieren';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = host._jpMedia;
      if (m) m.play().then(() => b.remove()).catch(() => {});
    });
    host.appendChild(b);
  }
  function clearMedia(host) {
    if (!host) return;
    if (host._jpMedia) { try { host._jpMedia.pause && host._jpMedia.pause(); } catch (e) {} }
    host.innerHTML = '';
    host._jpMedia = null;
    host._jpUrl = null;
    host._jpType = null;
    host._jpCmd = -1;
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
    const totalMs = (state.timerSeconds ? state.timerSeconds * 1000 : (t.remainingMs || 30000)) || 1;
    const C = 2 * Math.PI * 43;
    const frac = Math.max(0, Math.min(1, (t.remainingMs || 0) / totalMs));
    const dashoff = (C * (1 - frac)).toFixed(1);

    // Persistente Struktur: Medien-Host bleibt erhalten, nur die Karte wird neu gebaut.
    if (!el.querySelector('.jp-card-host')) {
      el.innerHTML = '<div class="jp-media-host"></div><div class="jp-card-host"></div>';
    }
    const mediaHost = el.querySelector('.jp-media-host');
    const cardHost = el.querySelector('.jp-card-host');
    syncMedia(mediaHost, c.media, c.mediaPlaying, c.mediaPositionMs, c.mediaCmd);

    cardHost.innerHTML = `
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
               data-total="${totalMs}" data-ends="${t.running ? t.endsAt || '' : ''}" data-remaining="${t.remainingMs || 0}">
            <svg class="jp-timer-ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle class="jp-timer-track" cx="50" cy="50" r="43"></circle>
              <circle class="jp-timer-prog" cx="50" cy="50" r="43" style="stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${dashoff}"></circle>
            </svg>
            <span class="jp-timer-center"><span class="jp-timer-val">${secs}</span><small>SEK</small></span>
          </div>
        </div>
        ${jokerTags.length ? `<div class="jp-joker-tags">${jokerTags.join('')}</div>` : ''}
        ${stageNote}
        ${outcome}
      </div>`;
  }

  // Medien anhalten/entfernen, wenn keine Frage mehr offen ist.
  function stopMedia(el) {
    if (!el) return;
    const host = el.querySelector('.jp-media-host');
    if (host) clearMedia(host);
  }

  // Verbleibende ms aus einem timer-View berechnen (fürs Ticken).
  function timerRemaining(timer) {
    if (!timer) return 0;
    if (timer.running && timer.endsAt) return Math.max(0, timer.endsAt - Date.now());
    return timer.remainingMs || 0;
  }

  // Timer-Anzeige (Zahl + Ring + Low/Zero-Zustand) aktualisieren – beim Ticken.
  function updateTimerEl(el, remMs, totalMs) {
    if (!el) return;
    const secs = Math.ceil((remMs || 0) / 1000);
    const v = el.querySelector('.jp-timer-val');
    if (v) v.textContent = secs;
    const total = totalMs || Number(el.dataset.total) || 1;
    const frac = Math.max(0, Math.min(1, (remMs || 0) / total));
    const prog = el.querySelector('.jp-timer-prog');
    if (prog) {
      const C = 2 * Math.PI * 43;
      prog.style.strokeDasharray = C.toFixed(1);
      prog.style.strokeDashoffset = (C * (1 - frac)).toFixed(1);
    }
    el.classList.toggle('low', secs <= 5 && secs > 0);
    el.classList.toggle('zero', secs === 0);
  }

  window.JeopardyUI = {
    renderSidePlayers,
    renderScoreboard,
    renderBoard,
    renderQuestion,
    stopMedia,
    timerRemaining,
    updateTimerEl,
    esc,
  };
})();
