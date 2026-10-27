/* IRL-Modus – Moderator-Panel für den Admin.
 *
 * Spieler ohne Gerät werden hier angelegt; ihre Eingaben macht der Moderator
 * stellvertretend (gleiche Spielregeln wie bei Handy-Spielern). Das Panel passt
 * sich an Spiel und Phase an. Nutzt die globalen Helfer aus admin.js
 * (socket, $, toast, escapeHtml, lastState, render).
 */
(function () {
  let muted = true; // Ton am Moderator-Gerät aus – der Projektor spielt ab
  let revealing = false; // Wellenlänge: Geheimzahl gerade sichtbar
  const drafts = {}; // Eingaben überleben Neu-Rendern
  const estSent = {}; // Schätzfrage: bereits eingetragene Werte (lokal)
  let lastHtml = '';
  let lastEstQ = null;
  let prevPhase = null; // um den Auf-/Zu-Zustand der Abschnitte sinnvoll zu merken

  const esc = (t) => escapeHtml(String(t == null ? '' : t));

  function act(event, payload, okMsg) {
    socket.emit(event, payload || {}, (res) => {
      if (res && !res.ok) return toast(res.error, true);
      if (okMsg) toast(okMsg);
    });
  }
  const irlAct = (playerId, action, payload, okMsg) => act('irl:act', { playerId, action, payload }, okMsg);
  const screenUrl = (code) => `${location.origin}/screen?code=${code}`;

  // ------------------------------------------------------------ Bausteine
  function headHtml(s) {
    return `<div class="irl-head">
      <b class="irl-title">🎭 IRL-Moderator</b>
      <div class="irl-head-btns">
        <button class="btn sm accent" data-irl="screen" title="Projektor-Ansicht in neuem Fenster öffnen">📺 Projektor</button>
        <button class="btn sm" data-irl="copyscreen" title="Projektor-Link kopieren">🔗</button>
        <button class="btn sm" data-irl="mute" title="Ton/Medien auf diesem Gerät">${muted ? '🔇' : '🔊'}</button>
      </div>
    </div>`;
  }

  function playersHtml(s) {
    const irl = (s.irlRoster || []).filter((p) => p.irl);
    const chips = irl.length
      ? irl
          .map(
            (p) => `<span class="irl-chip">${esc(p.name)}<button class="irl-x" data-irl="kick" data-pid="${p.id}" title="Entfernen">✕</button></span>`
          )
          .join('')
      : '<span class="hint">Noch keine IRL-Spieler.</span>';
    const phones = (s.irlRoster || []).filter((p) => !p.irl).length;
    const body = `<div class="irl-add">
        <input type="text" maxlength="24" placeholder="Name des Spielers" data-draft="newName" data-enter="add" />
        <button class="btn sm accent" data-irl="add">➕ Spieler</button>
      </div>
      <div class="irl-chips">${chips}</div>
      ${phones ? `<p class="hint">+ ${phones} per Handy beigetreten</p>` : ''}`;
    // In der Lobby offen, im Spiel eingeklappt (Platz sparen).
    const open = s.phase === 'lobby' ? ' open' : '';
    return `<details class="irl-sec"${open}><summary>👥 Spieler (${irl.length} IRL)</summary>${body}</details>`;
  }

  // ------------------------------------------------------------ Bluff-Quiz
  function bluffHtml(s) {
    const out = [];
    const roster = s.irlRoster || [];
    if (s.phase === 'answering') {
      const status = Object.fromEntries((s.answerStatus || []).map((a) => [a.id, a.answered]));
      const rows = roster
        .filter((p) => p.irl)
        .map((p) =>
          status[p.id]
            ? `<div class="irl-row"><span class="irl-name">${esc(p.name)}</span><span class="irl-done">✓ abgegeben</span></div>`
            : `<div class="irl-row"><span class="irl-name">${esc(p.name)}</span>
                 <input type="text" maxlength="200" placeholder="Antwort vom Zettel" data-draft="ans-${p.id}" data-enter="answer" data-pid="${p.id}" />
                 <button class="btn sm" data-irl="answer" data-pid="${p.id}">✓</button></div>`
        )
        .join('');
      out.push(`<div class="irl-sec-static"><h4>✍️ Antworten eintragen</h4>
        <p class="hint">Optional: Abgetippte Antworten erscheinen gemischt & nummeriert am Projektor.</p>
        ${rows || '<p class="hint">Keine IRL-Spieler.</p>'}</div>`);
    }
    if (['answering', 'voting', 'reveal'].includes(s.phase)) {
      const rows = roster
        .map(
          (p) => `<div class="irl-row"><span class="irl-name">${esc(p.name)}</span>
            <b class="irl-score">${p.score}</b>
            <button class="btn sm" data-irl="bpts" data-pid="${p.id}" data-d="-1">−1</button>
            <button class="btn sm" data-irl="bpts" data-pid="${p.id}" data-d="1">+1</button></div>`
        )
        .join('');
      out.push(`<div class="irl-sec-static"><h4>🏅 Punkte vergeben</h4>${rows}
        <button class="btn primary block mt" data-irl="bnext">✅ Frage abschließen → nächste Frage</button></div>`);
    }
    return out.join('');
  }

  // ------------------------------------------------------- Der dümmste fliegt
  function heartsHtml(s) {
    const board = s.board || [];
    const living = board.filter((p) => !p.eliminated);
    if (s.phase === 'voting' || s.phase === 'reveal') {
      const cand = s.votingCandidates ? living.filter((p) => s.votingCandidates.includes(p.id)) : living;
      const btns = cand
        .map((p) => `<button class="btn irl-pick" data-irl="hdecide" data-pid="${p.id}" data-name="${esc(p.name)}">💔 ${esc(p.name)}</button>`)
        .join('');
      return `<div class="irl-sec-static"><h4>⚖️ Ergebnis festlegen</h4>
        <p class="hint">Abstimmung per Handzeichen – wähle, wer ein Herz verliert.</p>
        <div class="irl-picks">${btns}</div></div>`;
    }
    if (s.phase === 'estimate' && s.estimate && s.estimate.question && !s.estimate.revealed) {
      if (lastEstQ !== s.estimate.question) {
        lastEstQ = s.estimate.question;
        for (const k of Object.keys(estSent)) delete estSent[k];
      }
      const rows = living
        .map(
          (p) => `<div class="irl-row"><span class="irl-name">${esc(p.name)}</span>
            ${estSent[p.id] != null ? `<span class="irl-done">✓ ${esc(estSent[p.id])}</span>` : ''}
            <input type="number" step="any" placeholder="Schätzung" data-draft="est-${p.id}" data-enter="est" data-pid="${p.id}" />
            <button class="btn sm" data-irl="est" data-pid="${p.id}">✓</button></div>`
        )
        .join('');
      return `<div class="irl-sec-static"><h4>🔢 Schätzungen eintragen</h4>
        <p class="hint">${s.estimate.guessCount || 0}/${living.length} eingetragen</p>${rows}</div>`;
    }
    if (s.phase === 'question') {
      return `<p class="hint irl-note">Antworten wertest du wie gewohnt unten. Für die Abstimmung bekommst du hier gleich die Ergebnis-Auswahl.</p>`;
    }
    return '';
  }

  // ------------------------------------------------------------ Wellenlänge
  function waveHtml(s) {
    const t = s.turn || {};
    const out = [];
    if (s.phase === 'clue' || s.phase === 'guess') {
      out.push(`<button class="btn block irl-hold" data-hold="secret">👁 Geheimzahl zeigen <small>(gedrückt halten)</small></button>
        <p class="hint">Zeig sie kurz dem Hinweisgeber: <b>${esc(t.clueGiverName || '–')}</b></p>`);
    }
    if (s.phase === 'clue') {
      out.push(`<div class="irl-sec-static"><h4>💬 Hinweis</h4>
        <div class="irl-row"><input type="text" maxlength="60" placeholder="Hinweis (erscheint am Projektor)" data-draft="clue" data-enter="clue" />
        <button class="btn sm accent" data-irl="clue">📢</button></div>
        <button class="btn block sm mt" data-irl="clueoral">🗣️ Hinweis wurde mündlich gegeben</button></div>`);
    }
    if (s.phase === 'guess') {
      const max = s.scaleMax || 10;
      const btns = Array.from({ length: max + 1 }, (_, i) => `<button class="btn irl-num" data-irl="guess" data-v="${i}">${i}</button>`).join('');
      out.push(`<div class="irl-sec-static"><h4>🎯 Tipp von ${esc(t.teamName || 'Team')}</h4><div class="irl-nums">${btns}</div></div>`);
    }
    return out.join('');
  }

  // ------------------------------------------------------------ Quiz-Duell
  function jeopardyHtml(s) {
    const teams = s.teams || [];
    const name = (id) => (teams.find((t) => t.id === id) || {}).name || '?';
    const out = [];
    if (s.phase === 'board') {
      const active = teams.find((t) => t.id === s.activeTeamId);
      out.push(`<p class="hint irl-note">👆 Kachel auf dem Board anklicken – die Frage öffnet sich für <b>${esc(active ? active.name : '–')}</b>.</p>`);
      const jk = [];
      if (active && (active.jokers.allOrNothing || 0) > 0 && !active.armedAoN) {
        jk.push(`<button class="btn sm" data-irl="jaon" data-team="${active.id}">🎲 Alles-oder-Nichts für ${esc(active.name)}</button>`);
      }
      const coffeeUsers = teams.filter((t) => t.id !== s.activeTeamId && (t.jokers.coffee || 0) > 0);
      const targets = teams.filter((t) => t.id !== s.activeTeamId && !t.onCoffee);
      if (coffeeUsers.length && targets.length > 1) {
        const opt = (list) => list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
        jk.push(`<div class="irl-row irl-coffee">☕ <select data-draft="cfrom">${opt(coffeeUsers)}</select> →
          <select data-draft="cto">${opt(targets)}</select>
          <button class="btn sm" data-irl="jcoffee">OK</button></div>`);
      }
      if (jk.length) out.push(`<div class="irl-sec-static"><h4>🃏 Joker</h4>${jk.join('')}</div>`);
    }
    if (s.phase === 'question' && s.current) {
      const c = s.current;
      if (c.stage === 'stealOpen') {
        const tried = c.attemptedTeamIds || [];
        const elig = teams.filter((t) => !tried.includes(t.id) && !t.onCoffee && t.players && t.players.length);
        const btns = elig.map((t) => `<button class="btn irl-pick" data-irl="jbuzz" data-team="${t.id}" style="--tc:${t.color}">🔔 ${esc(t.name)}</button>`).join('');
        out.push(`<div class="irl-sec-static"><h4>🔔 Wer hat gebuzzert?</h4><div class="irl-picks">${btns || '<span class="hint">Kein Team mehr übrig.</span>'}</div></div>`);
      }
      if (['answering', 'stealAnswering'].includes(c.stage)) {
        const t = teams.find((x) => x.id === c.answeringTeamId);
        if (t && (t.jokers.noRisk || 0) > 0 && c.noRiskTeamId !== t.id) {
          out.push(`<button class="btn sm block" data-irl="jnorisk" data-team="${t.id}">🛡️ Kein-Risiko für ${esc(name(t.id))}</button>`);
        }
      }
    }
    return out.join('');
  }

  // ------------------------------------------------------------ Rendern
  function render(s) {
    document.body.classList.toggle('irl-room', !!(s && s.irl));
    const main = $('irlPanel');
    const jp = $('irlPanelJp');
    if (!s || !s.irl) {
      main.classList.add('hidden');
      if (jp) jp.classList.add('hidden');
      return;
    }
    if (window.JeopardyUI && JeopardyUI.setMuted) JeopardyUI.setMuted(muted);
    const el = s.gameType === 'jeopardy' && jp ? jp : main;
    (el === jp ? main : jp).classList.add('hidden');
    el.classList.remove('hidden');

    const game =
      s.gameType === 'hearts' ? heartsHtml(s) : s.gameType === 'wave' ? waveHtml(s) : s.gameType === 'jeopardy' ? jeopardyHtml(s) : bluffHtml(s);
    const html = headHtml(s) + playersHtml(s) + game;
    if (html === lastHtml && el.innerHTML) return; // nichts geändert -> Eingaben bleiben unberührt

    // Fokus + Entwürfe über das Neu-Rendern retten
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.draft : null;
    const openSecs = [...el.querySelectorAll('details.irl-sec')].map((d) => d.open);
    lastHtml = html;
    el.innerHTML = html;
    el.querySelectorAll('[data-draft]').forEach((inp) => {
      if (drafts[inp.dataset.draft] != null) inp.value = drafts[inp.dataset.draft];
    });
    // Vom Nutzer aufgeklappte Abschnitte offen lassen – aber beim Verlassen der
    // Lobby (dort automatisch offen) wieder einklappen.
    if (s.phase !== 'lobby' && prevPhase !== 'lobby') {
      el.querySelectorAll('details.irl-sec').forEach((d, i) => { if (openSecs[i]) d.open = true; });
    }
    prevPhase = s.phase;
    if (focused) {
      const f = el.querySelector(`[data-draft="${focused}"]`);
      if (f) f.focus();
    }
    el._irlState = s;
  }

  function draftVal(el, key) {
    const inp = el.querySelector(`[data-draft="${key}"]`);
    return inp ? inp.value.trim() : '';
  }
  function clearDraft(key) {
    delete drafts[key];
  }

  function handle(el, cmd, btn) {
    const s = lastState;
    if (!s) return;
    const pid = btn && btn.dataset.pid;
    switch (cmd) {
      case 'screen':
        window.open(screenUrl(s.code), `screen-${s.code}`);
        break;
      case 'copyscreen': {
        const link = screenUrl(s.code);
        navigator.clipboard.writeText(link).then(() => toast('Projektor-Link kopiert!'), () => prompt('Projektor-Link:', link));
        break;
      }
      case 'mute':
        muted = !muted;
        if (window.JeopardyUI && JeopardyUI.setMuted) JeopardyUI.setMuted(muted);
        toast(muted ? 'Ton am Moderator-Gerät aus' : 'Ton am Moderator-Gerät an');
        render(s);
        break;
      case 'add': {
        const n = draftVal(el, 'newName');
        if (!n) return toast('Bitte einen Namen eingeben.', true);
        socket.emit('irl:addPlayer', { name: n }, (res) => {
          if (!res.ok) return toast(res.error, true);
          clearDraft('newName');
          const inp = el.querySelector('[data-draft="newName"]');
          if (inp) { inp.value = ''; inp.focus(); }
        });
        break;
      }
      case 'kick': {
        const p = (s.irlRoster || []).find((x) => x.id === pid);
        if (p && confirm(`${p.name} entfernen?`)) act('admin:kickPlayer', { playerId: pid });
        break;
      }
      case 'answer': {
        const text = draftVal(el, `ans-${pid}`);
        if (!text) return toast('Antwort ist leer.', true);
        socket.emit('irl:act', { playerId: pid, action: 'player:submitAnswer', payload: { text } }, (res) => {
          if (!res.ok) return toast(res.error, true);
          clearDraft(`ans-${pid}`);
        });
        break;
      }
      case 'bpts':
        act('bluff:adjustScore', { playerId: pid, delta: parseInt(btn.dataset.d, 10) });
        break;
      case 'bnext':
        if (confirm('Frage abschließen und zur nächsten Frage?')) act('admin:nextQuestion');
        break;
      case 'hdecide':
        if (confirm(`${btn.dataset.name} verliert ein Herz?`)) act('hearts:irlDecide', { playerId: pid });
        break;
      case 'est': {
        const v = draftVal(el, `est-${pid}`);
        if (v === '' || !Number.isFinite(Number(v))) return toast('Bitte eine Zahl eingeben.', true);
        socket.emit('irl:act', { playerId: pid, action: 'hearts:estimateGuess', payload: { value: Number(v) } }, (res) => {
          if (!res.ok) return toast(res.error, true);
          estSent[pid] = v;
          clearDraft(`est-${pid}`);
          lastHtml = '';
          render(lastState);
        });
        break;
      }
      case 'clue': {
        const text = draftVal(el, 'clue');
        if (!text) return toast('Hinweis ist leer.', true);
        socket.emit('wave:irlClue', { text }, (res) => {
          if (!res.ok) return toast(res.error, true);
          clearDraft('clue');
        });
        break;
      }
      case 'clueoral':
        act('wave:irlClue', { text: '🗣️ mündlich' });
        break;
      case 'guess':
        act('wave:irlGuess', { value: parseInt(btn.dataset.v, 10) });
        break;
      case 'jaon':
        act('jeopardy:irlJoker', { teamId: btn.dataset.team, type: 'allOrNothing' }, 'Alles-oder-Nichts aktiv');
        break;
      case 'jnorisk':
        act('jeopardy:irlJoker', { teamId: btn.dataset.team, type: 'noRisk' }, 'Kein-Risiko aktiv');
        break;
      case 'jcoffee': {
        const from = el.querySelector('[data-draft="cfrom"]').value;
        const to = el.querySelector('[data-draft="cto"]').value;
        if (from === to) return toast('Ein Team kann sich nicht selbst pausieren.', true);
        act('jeopardy:irlJoker', { teamId: from, type: 'coffee', targetTeamId: to }, 'Kaffeepause gesetzt');
        break;
      }
      case 'jbuzz':
        act('jeopardy:irlBuzz', { teamId: btn.dataset.team });
        break;
    }
  }

  function wire(el) {
    if (!el) return;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-irl]');
      if (btn) handle(el, btn.dataset.irl, btn);
    });
    el.addEventListener('input', (e) => {
      const k = e.target.dataset && e.target.dataset.draft;
      if (k) drafts[k] = e.target.value;
    });
    el.addEventListener('change', (e) => {
      const k = e.target.dataset && e.target.dataset.draft;
      if (k) drafts[k] = e.target.value;
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.dataset.enter) return;
      e.preventDefault();
      handle(el, e.target.dataset.enter, e.target);
    });
    // Wellenlänge: Geheimzahl nur sichtbar, solange gedrückt gehalten wird.
    const setReveal = (on) => {
      if (revealing === on) return;
      revealing = on;
      if (lastState) window.render(lastState); // admin.js-Render (zeichnet Zielzahl ein/aus)
    };
    el.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-hold="secret"]')) setReveal(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, () => setReveal(false)));
    window.addEventListener('blur', () => setReveal(false));
  }

  wire($('irlPanel'));
  wire($('irlPanelJp'));

  window.IRL = {
    render,
    isRevealing: () => revealing,
  };
})();
