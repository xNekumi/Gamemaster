/* global io */
const socket = io();

const state = {
  playerId: null,
  token: localStorage.getItem('gm_token') || null,
  code: null,
  name: null,
  selectedAnswerId: null,
  pendingAvatar: null, // vor dem Beitritt gewähltes Bild
};

// Avatar-Cache (id -> data-URL) und letzte Roster-Liste, gemeinsam für alle Ansichten.
let avatars = {};
let lastRoster = [];
const rosterMap = () => Object.fromEntries(lastRoster.map((p) => [p.id, p]));

function brief(id, fallbackName) {
  const p = rosterMap()[id];
  return { id, name: (p && p.name) || fallbackName || '?', avatar: avatars[id] || null };
}

// ------------------------------------------------------------- Helfer
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

function showOnly(activeId) {
  ['lobby', 'answering', 'voting', 'reveal', 'finished'].forEach((id) => {
    hide($(id));
  });
  if (activeId) show($(activeId));
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ------------------------------------------------------------- Beitritt
function attemptJoin(name, code, token) {
  socket.emit('player:join', { name, code, token }, (res) => {
    if (!res.ok) {
      // Reconnect mit altem Token fehlgeschlagen -> Token verwerfen
      if (token && !name) {
        localStorage.removeItem('gm_token');
        localStorage.removeItem('gm_code');
        return;
      }
      const err = $('joinError');
      err.textContent = res.error;
      show(err);
      return;
    }
    state.playerId = res.playerId;
    state.token = res.token;
    state.name = res.name;
    state.code = res.state.code;
    localStorage.setItem('gm_token', res.token);
    localStorage.setItem('gm_code', res.state.code);

    hide($('joinView'));
    show($('gameView'));
    $('roomPillCode').textContent = res.state.code;
    show($('roomPill'));
    $('lobbyName').textContent = res.name;

    // Beim Beitritt gewähltes Profilbild an den Server senden.
    if (state.pendingAvatar) {
      avatars[state.playerId] = state.pendingAvatar;
      socket.emit('player:setAvatar', { dataUrl: state.pendingAvatar }, () => {});
      state.pendingAvatar = null;
    }
    render(res.state);
  });
}

$('joinBtn').addEventListener('click', () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  hide($('joinError'));
  if (!name) return toast('Bitte gib einen Namen ein.', true);
  if (!code) return toast('Bitte gib den Raum-Code ein.', true);
  attemptJoin(name, code, null);
});

$('codeInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});
['nameInput', 'codeInput'].forEach((id) =>
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('joinBtn').click();
  })
);

// Vorbelegung aus URL (?code=XXXX) für geteilte Links
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('codeInput').value = urlCode.toUpperCase();

// Automatischer Reconnect
const savedCode = localStorage.getItem('gm_code');
if (state.token && savedCode) {
  attemptJoin(null, savedCode, state.token);
}

// ------------------------------------------------------------- Antwort
$('answerBtn').addEventListener('click', () => {
  const text = $('answerInput').value.trim();
  if (!text) return toast('Bitte gib eine Antwort ein.', true);
  $('answerBtn').disabled = true;
  socket.emit('player:submitAnswer', { text }, (res) => {
    $('answerBtn').disabled = false;
    if (!res.ok) return toast(res.error, true);
    toast('Antwort abgeschickt!');
  });
});

// ------------------------------------------------------------- Rendern
const appEl = document.querySelector('.app');
let currentGameType = 'bluff';
let lastState = null;

// Dispatcher: wählt die passende Spiel-Ansicht.
function render(s) {
  if (!s) return;
  lastState = s;
  currentGameType = s.gameType || 'bluff';
  document.body.classList.toggle('hearts-active', currentGameType === 'hearts');
  document.body.classList.toggle('wave-active', currentGameType === 'wave');
  document.body.classList.toggle('jeopardy-active', currentGameType === 'jeopardy');
  if (currentGameType === 'hearts') return renderHearts(s);
  if (currentGameType === 'wave') return renderWave(s);
  if (currentGameType === 'jeopardy') return renderJeopardy(s);
  show(appEl);
  hide($('heartsView'));
  hide($('heartsPopup'));
  hide($('waveView'));
  hide($('jeopardyView'));
  renderBluff(s);
}

function renderBluff(s) {
  if (!s) return;
  if (s.code) $('roomPillCode').textContent = s.code;
  if (s.roster) {
    lastRoster = s.roster;
    renderAvatarBar();
  }
  renderScoreboard(s);

  switch (s.phase) {
    case 'lobby':
      showOnly('lobby');
      hide($('scoreCard'));
      renderLobbyPlayers(s);
      break;

    case 'answering':
      showOnly('answering');
      hide($('scoreCard'));
      $('answerRound').textContent = s.round;
      $('answerQuestion').textContent = s.question;
      if (s.hasAnswered) {
        hide($('answerForm'));
        show($('answerWaiting'));
      } else {
        show($('answerForm'));
        hide($('answerWaiting'));
      }
      break;

    case 'voting':
      showOnly('voting');
      show($('scoreCard'));
      $('voteQuestion').textContent = s.question;
      renderVoteAnswers(s);
      break;

    case 'reveal':
      showOnly('reveal');
      show($('scoreCard'));
      $('revealQuestion').textContent = s.question;
      renderRevealAnswers(s);
      break;

    case 'finished':
      showOnly('finished');
      hide($('scoreCard'));
      renderFinal(s);
      break;
  }
}

function renderLobbyPlayers(s) {
  const el = $('lobbyPlayers');
  el.innerHTML = (s.scoreboard || [])
    .map(
      (p) =>
        `<span class="chip ${p.connected ? '' : 'off'}"><span class="dot"></span>${escapeHtml(
          p.name
        )}</span>`
    )
    .join('');
}

function renderVoteAnswers(s) {
  const el = $('voteAnswers');
  const open = s.votingOpen;
  const locked = s.hasVoted;
  const answers = s.answers || [];

  // Hinweistext je nach Zustand
  const hint = $('voteHint');
  if (!open) {
    hint.innerHTML = '🎭 Der Gamemaster blendet die Antworten nacheinander ein – gleich könnt ihr abstimmen.';
  } else if (locked) {
    hint.innerHTML = '';
  } else {
    hint.innerHTML =
      'Wähle die Antwort, die du für die <b>echte</b> Lösung hältst. Deine eigene Antwort kannst du nicht wählen.';
  }
  hint.style.display = hint.innerHTML ? '' : 'none';

  if (!answers.length) {
    el.innerHTML = '<p class="hint center pulse">Warte auf die erste Antwort …</p>';
  } else {
    el.innerHTML = '';
    answers.forEach((a) => {
      const clickable = open && !a.isOwn && !locked;
      const row = document.createElement('div');
      row.className =
        'rev-row voting-row' +
        (a.isOwn ? ' own' : '') +
        (s.myVote === a.id ? ' selected' : '') +
        (clickable ? ' clickable' : '');
      const right = s.myVote === a.id ? '<span class="tag">✓ Deine Stimme</span>' : '';
      row.innerHTML = `
        <div class="rev-left"><div class="av-circle locked">🔒</div></div>
        <div class="rev-mid"><div class="rev-text">${escapeHtml(a.text)}${
        a.isOwn ? ' <span class="tag author">Deine Antwort</span>' : ''
      }</div></div>
        <div class="rev-right">${right}</div>`;
      if (clickable) row.addEventListener('click', () => castVote(a.id, row));
      el.appendChild(row);
    });
  }

  if (locked) show($('voteWaiting'));
  else hide($('voteWaiting'));
}

function castVote(answerId, div) {
  document.querySelectorAll('#voteAnswers .rev-row').forEach((d) => d.classList.remove('selected'));
  div.classList.add('selected');
  socket.emit('player:vote', { answerId }, (res) => {
    if (!res.ok) {
      div.classList.remove('selected');
      return toast(res.error, true);
    }
    toast('Stimme abgegeben!');
  });
}

function renderRevealAnswers(s) {
  $('revealAnswers').innerHTML = revealRowsHtml(s.answers || [], state.playerId);
}

// Gemeinsame Zeilen-Darstellung der Auflösung: links Autor, rechts Wähler.
function revealRowsHtml(answers, meId) {
  return answers
    .map((a) => {
      // Autor-Spalte
      let author;
      if (!a.revealed) {
        author = '<div class="av-circle locked">🔒</div>';
      } else if (a.isTruth) {
        author = '<div class="av-circle truth-circle">✅</div>';
      } else {
        const b = brief(a.authorId, a.authorName);
        author = GM.avatarCircle(b.name, b.avatar);
      }

      // Wähler-Spalte
      let voters = '';
      if (a.revealed) {
        const ids = a.voterIds || [];
        voters = ids.length
          ? ids
              .map((id, i) => {
                const b = brief(id, (a.voters || [])[i]);
                return GM.avatarCircle(b.name, b.avatar, 'sm');
              })
              .join('')
          : '<span class="rev-novote">keine Stimmen</span>';
      }

      const cls = [
        'rev-row',
        a.revealed && a.isTruth ? 'truth' : '',
        a.isOwn ? 'own' : '',
        !a.revealed ? 'covered' : '',
      ].join(' ');

      const authorLabel = a.revealed && !a.isTruth ? `<span class="rev-author-name">${GM.escapeHtml(brief(a.authorId, a.authorName).name)}</span>` : '';

      return `<div class="${cls}">
        <div class="rev-left">${author}</div>
        <div class="rev-mid">
          <div class="rev-text">${GM.escapeHtml(a.text)}${a.isOwn ? ' <span class="tag author">Du</span>' : ''}${
        a.revealed && a.isTruth ? ' <span class="tag truth">richtige Antwort</span>' : ''
      }</div>
          ${authorLabel}
        </div>
        <div class="rev-right">${voters}</div>
      </div>`;
    })
    .join('');
}

function renderScoreboard(s) {
  if (!s.scoreboard || s.phase === 'lobby' || s.phase === 'finished') return;
  $('scoreboard').innerHTML = scoreboardHtml(s.scoreboard, s.playerId);
}

function scoreboardHtml(list, meId) {
  return list
    .map(
      (p, i) => `
    <div class="score-row ${i === 0 && p.score > 0 ? 'top1' : ''}">
      <div class="rank">${i === 0 && p.score > 0 ? '👑' : i + 1}</div>
      <div class="name">${escapeHtml(p.name)}${p.id === meId ? ' <span class="badge">Du</span>' : ''}</div>
      <div class="pts">${p.score}</div>
    </div>`
    )
    .join('');
}

function renderFinal(s) {
  $('finalScoreboard').innerHTML = scoreboardHtml(s.scoreboard || [], s.playerId);
}

// ------------------------------------------------------------- Avatar-Leiste
function renderAvatarBar() {
  const bar = $('avatarBar');
  if (!lastRoster.length) {
    hide(bar);
    return;
  }
  if (state.playerId) show(bar);
  bar.innerHTML = lastRoster
    .map((p) => {
      const isSelf = p.id === state.playerId;
      return `<div class="av-tile ${p.connected ? '' : 'off'} ${isSelf ? 'self' : ''}" data-self="${isSelf}">
        <div class="av-media">${GM.avatarInner(p.name, avatars[p.id])}</div>
        <div class="av-score" title="Punkte">${p.score}</div>
        <div class="av-name">${GM.escapeHtml(p.name)}${isSelf ? ' (Du)' : ''}</div>
        ${isSelf ? '<div class="av-edit" title="Bild ändern">📷</div>' : ''}
      </div>`;
    })
    .join('');
  const selfTile = bar.querySelector('.av-tile.self');
  if (selfTile) selfTile.addEventListener('click', () => openAvatarPicker('change'));
}

// ------------------------------------------------------------- Avatar wählen
let avatarMode = 'join'; // 'join' (vor Beitritt) oder 'change' (im Spiel)

function openAvatarPicker(mode) {
  avatarMode = mode;
  $('avatarInput').click();
}

$('pickAvatarBtn').addEventListener('click', () => openAvatarPicker('join'));
$('removeAvatarBtn').addEventListener('click', () => {
  state.pendingAvatar = null;
  updateJoinPreview();
});

// Profilbild nachträglich ändern (Lobby / laufendes Spiel, alle Spiele)
$('lobbyChangePhotoBtn').addEventListener('click', () => openAvatarPicker('change'));
$('htChangePhotoBtn').addEventListener('click', () => openAvatarPicker('change'));
$('wvChangePhotoBtn').addEventListener('click', () => openAvatarPicker('change'));
$('jpChangePhotoBtn').addEventListener('click', () => openAvatarPicker('change'));

// Lobby / Spiel verlassen
function leaveLobby() {
  if (!confirm('Willst du das Spiel wirklich verlassen?')) return;
  socket.emit('player:leave', {}, () => resetToJoin());
}
$('lobbyLeaveBtn').addEventListener('click', leaveLobby);
$('htLeaveBtn').addEventListener('click', leaveLobby);
$('wvLeaveBtn').addEventListener('click', leaveLobby);
$('jpLeaveBtn').addEventListener('click', leaveLobby);

// Zurück zum Beitritts-Bildschirm (nach Verlassen oder Rauswurf)
function resetToJoin(msg) {
  localStorage.removeItem('gm_token');
  localStorage.removeItem('gm_code');
  state.playerId = null;
  state.token = null;
  state.code = null;
  lastState = null;
  currentGameType = 'bluff';
  document.body.classList.remove('hearts-active');
  document.body.classList.remove('wave-active');
  document.body.classList.remove('jeopardy-active');
  hide($('gameView'));
  hide($('heartsView'));
  hide($('heartsPopup'));
  hide($('waveView'));
  hide($('jeopardyView'));
  hide($('avatarBar'));
  hide($('roomPill'));
  show(appEl);
  show($('joinView'));
  const err = $('joinError');
  if (msg) {
    err.textContent = msg;
    show(err);
  } else {
    hide(err);
  }
}

$('avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // erlaubt erneutes Wählen derselben Datei
  if (!file) return;
  try {
    const dataUrl = await GM.fileToAvatar(file);
    if (avatarMode === 'join') {
      state.pendingAvatar = dataUrl;
      updateJoinPreview();
    } else {
      // Sofortiges optimistisches Update + an Server senden
      avatars[state.playerId] = dataUrl;
      if (currentGameType === 'hearts') {
        if (lastState) renderHearts(lastState);
      } else {
        renderAvatarBar();
      }
      socket.emit('player:setAvatar', { dataUrl }, (res) => {
        if (res && !res.ok) toast(res.error, true);
        else toast('Profilbild aktualisiert!');
      });
    }
  } catch {
    toast('Bild konnte nicht verarbeitet werden.', true);
  }
});

function updateJoinPreview() {
  const prev = $('joinAvatarPreview');
  if (state.pendingAvatar) {
    prev.innerHTML = `<img class="av-img" src="${state.pendingAvatar}" alt="">`;
    show($('removeAvatarBtn'));
  } else {
    prev.innerHTML = '<span class="join-avatar-hint">📷</span>';
    hide($('removeAvatarBtn'));
  }
}

// ------------------------------------------------- "Der dümmste fliegt"
const HT_PHASE = {
  lobby: 'Lobby',
  question: 'Fragerunde',
  voting: 'Abstimmung',
  reveal: 'Auflösung',
  roundEnd: 'Rundenende',
  estimate: 'Schätzfrage',
  finale: 'Finale',
  finished: 'Ende',
};

// Erkennt Spieler, die gerade ein Herz verloren haben (für die Animation).
let htPrevHearts = {};
function heartsHurtIds(s) {
  const hurt = [];
  (s.board || []).forEach((c) => {
    if (htPrevHearts[c.id] !== undefined && c.hearts < htPrevHearts[c.id]) hurt.push(c.id);
    htPrevHearts[c.id] = c.hearts;
  });
  return hurt;
}

function renderHearts(s) {
  hide(appEl);
  hide($('avatarBar'));
  show($('heartsView'));

  const inFinale = s.phase === 'finale' || (s.finale && s.phase === 'finished');
  $('htRoundInfo').textContent =
    s.phase === 'lobby' ? 'Lobby' : inFinale ? 'Finale' : 'Runde ' + s.round;
  $('htPhaseInfo').textContent = HT_PHASE[s.phase] || s.phase;
  $('htFinaleBadge').classList.toggle('hidden', s.phase !== 'finale');
  const meCell = (s.board || []).find((c) => c.id === s.myId);
  $('htMyHearts').innerHTML = meCell ? HeartsBoard.heartsHtml(meCell.hearts, meCell.maxHearts) : '';

  // Timer (für alle sichtbar) – nur in relevanten Phasen anzeigen.
  htRenderTimer(s);

  // Wahl bleibt änderbar, solange die Abstimmung läuft (bis der Admin sperrt).
  const canVoteNow = s.phase === 'voting' && s.canVote;
  const votable = canVoteNow ? s.votableIds || [] : [];
  HeartsBoard.render($('heartsBoard'), s, avatars, {
    myId: s.myId,
    myVote: s.myVote,
    votableIds: votable,
    onTileClick: votable.length ? castHeartsVote : null,
    hurtIds: heartsHurtIds(s),
    fit: true,
  });

  // Aktuelle Frage für ALLE anzeigen (ausgegraut, wenn man nicht dran ist).
  htRenderQuestionBanner(s);
  // Schätzfrage-Bereich
  htRenderEstimate(s);

  // Das alte Popup nur noch für den aktiven Spieler in normalen Fragerunden nutzen wir nicht mehr –
  // die Frage steht jetzt im Banner. Popup ausblenden.
  hide($('heartsPopup'));

  $('heartsHint').innerHTML = heartsHintText(s);
}

// Zeigt die aktuelle Frage als Banner für alle; hervorgehoben, wenn man dran ist.
function htRenderQuestionBanner(s) {
  const el = $('htQuestionBanner');
  const showPhases = s.phase === 'question' || s.phase === 'finale';
  if (!showPhases || !s.currentQuestionText) {
    hide(el);
    return;
  }
  const mine = s.currentQuestionFor === s.myId;
  el.classList.toggle('mine', mine);
  el.classList.toggle('dim', !mine);
  const who = mine ? '🎤 Du bist dran!' : `Frage an ${GM.escapeHtml(s.currentQuestionForName || '')}`;
  el.innerHTML = `<div class="ht-qb-who">${who}</div><div class="ht-qb-text">${GM.escapeHtml(s.currentQuestionText)}</div>`;
  show(el);
}

// Timer-Anzeige (Wert wird per Intervall aktualisiert)
function htRenderTimer(s) {
  const el = $('htTimer');
  const t = s.timer;
  const relevant = ['question', 'finale', 'estimate'].includes(s.phase);
  if (!t || !relevant) { hide(el); return; }
  show(el);
  const secs = Math.ceil((HeartsTimer.remaining(t)) / 1000);
  el.querySelector('.ht-timer-val').textContent = secs;
  el.classList.toggle('running', !!t.running);
  el.classList.toggle('low', secs <= 5 && secs > 0);
  el.classList.toggle('zero', secs === 0);
}

// Schätzfrage-Bereich (Spieler)
function htRenderEstimate(s) {
  const el = $('htEstimate');
  if (s.phase !== 'estimate' || !s.estimate) { hide(el); return; }
  show(el);
  const e = s.estimate;
  if (!e.question) {
    $('htEstimateQ').textContent = 'Der Gamemaster bereitet eine Schätzfrage vor …';
    hide($('htEstimateForm'));
    $('htEstimateResult').innerHTML = '';
    return;
  }
  $('htEstimateQ').innerHTML = `<b>Schätzfrage:</b> ${GM.escapeHtml(e.question)}`;
  // Formular nur, wenn ich schätzen darf und noch nicht aufgelöst
  const canGuess = e.canGuess && !e.revealed && !s.myEliminated;
  $('htEstimateForm').classList.toggle('hidden', !canGuess);
  if (e.myGuess != null && !$('htEstimateInput').value) $('htEstimateInput').value = e.myGuess;

  if (e.revealed && e.result) {
    const rows = e.result.byPlayer
      .map((p) => `<div class="ht-est-row ${p.loser ? 'loser' : ''}">
        <span>${GM.escapeHtml(p.name)}</span>
        <span>${p.guess == null ? '—' : p.guess}</span>
        <small>Δ ${p.distance == null ? '∞' : p.distance}</small>
      </div>`)
      .join('');
    $('htEstimateResult').innerHTML =
      `<div class="ht-est-answer">Lösung: <b>${e.answer}</b></div>${rows}` +
      (e.tie ? '<div class="hint">Gleichstand – es folgt eine weitere Schätzfrage.</div>' : '');
  } else {
    $('htEstimateResult').innerHTML = e.myGuess != null ? '<span class="hint">Schätzung abgegeben ✓</span>' : '';
  }
}

function castHeartsVote(targetId) {
  socket.emit('hearts:vote', { targetId }, (res) => {
    if (res && !res.ok) return toast(res.error, true);
    toast('Stimme abgegeben!');
  });
}

// Bei Größenänderung des Fensters das Board neu einpassen.
let resizeTimer;
window.addEventListener('resize', () => {
  if (currentGameType !== 'hearts') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastState) HeartsBoard.fit($('heartsBoard'), (lastState.board || []).length || 1);
  }, 120);
});

function heartsHintText(s) {
  // Finale-Phase zuerst.
  if (s.phase === 'finale') return heartsFinaleHint(s);

  if (s.phase === 'voting') {
    if (s.canVote) {
      if (s.myVote) {
        const name = ((s.board || []).find((c) => c.id === s.myVote) || {}).name || '';
        return `✅ Deine Wahl: <b>${GM.escapeHtml(name)}</b> — du kannst sie noch ändern, bis der Gamemaster sperrt.`;
      }
      return s.isRunoff
        ? '⚖️ Stichwahl! Wähle einen der markierten Spieler.'
        : 'Wähle den Spieler, der am dümmsten war!';
    }
    return s.myEliminated ? 'Du bist raus und stimmst nicht mehr ab.' : 'Warte, bis der Gamemaster auswertet …';
  }

  if (s.myEliminated && s.phase !== 'finished' && s.phase !== 'estimate') return '💀 Du bist ausgeschieden – schau weiter zu!';

  switch (s.phase) {
    case 'lobby':
      return 'Warte, bis der Gamemaster das Spiel startet …';
    case 'question':
      return s.myQuestion
        ? 'Du bist dran – beantworte deine Frage laut!'
        : 'Der Gamemaster stellt Fragen. Pass auf, wann du dran bist!';
    case 'estimate':
      return '🎯 Alle waren perfekt! Schätzfrage: Wer am weitesten daneben liegt, verliert ein Herz.';
    case 'reveal':
      return 'Der Gamemaster deckt die Stimmen auf …';
    case 'roundEnd':
      return heartsResultText(s);
    case 'finished':
      return s.winnerId ? '🏆 ' + (s.winnerName || '') + ' gewinnt das Spiel!' : 'Spiel beendet.';
    default:
      return '';
  }
}

function heartsFinaleHint(s) {
  const f = s.finale || {};
  const total = f.blockSize || 10;
  const no = f.questionNo || 1;
  const block = f.block > 1 ? ` (Stechen ${f.block - 1})` : '';
  if (f.stage === 'reveal') {
    return heartsFinaleRevealHtml(s, f);
  }
  // Aktive Antwort-Phase
  if (s.amFinalist) {
    if (s.myQuestion) {
      return `🏆 FINALE${block} · Frage ${no}/${total} — beantworte sie laut! (Punkte bleiben geheim)`;
    }
    return `🏆 FINALE${block} — warte, bis du an der Reihe bist. Deine Punkte bleiben bis zum Schluss geheim.`;
  }
  // Zuschauer
  const activeName = ((s.board || []).find((c) => c.id === f.activeId) || {}).name || '';
  return `🏆 FINALE${block} · Frage ${no}/${total}${
    activeName ? ` — ${GM.escapeHtml(activeName)} ist dran` : ''
  }. Du siehst den Punktestand live mit!`;
}

// Spannende Auflösung: pro Frage aufgedeckt, mit laufendem Punktestand.
function heartsFinaleRevealHtml(s, f) {
  const names = f.finalistNames || ['?', '?'];
  const sc = f.scores || {};
  const a = f.finalists[0], b = f.finalists[1];
  const head = `<div class="ht-fr-head">
      <span class="ht-fr-name">${GM.escapeHtml(names[0])}</span>
      <span class="ht-fr-score"><b>${sc[a] ?? 0}</b> : <b>${sc[b] ?? 0}</b></span>
      <span class="ht-fr-name">${GM.escapeHtml(names[1])}</span>
    </div>`;
  const rows = (f.revealLog || [])
    .map(
      (r) => `<div class="ht-fr-row">
        <span class="ht-fr-mark ${r.r0 ? 'ok' : 'no'}">${r.r0 ? '✓' : '✗'}</span>
        <span class="ht-fr-q" title="${GM.escapeHtml('Lösung: ' + (r.answer || '—'))}">${r.no}. ${GM.escapeHtml(r.question)}</span>
        <span class="ht-fr-mark ${r.r1 ? 'ok' : 'no'}">${r.r1 ? '✓' : '✗'}</span>
      </div>`
    )
    .join('');
  let foot = '';
  if (f.fullyRevealed) {
    foot = f.tie
      ? '<div class="ht-fr-foot tie">⚖️ Gleichstand – es folgt ein Stechen!</div>'
      : `<div class="ht-fr-foot win">🏆 ${GM.escapeHtml(names[f.leaderId === a ? 0 : 1])} gewinnt das Finale!</div>`;
  } else {
    foot = '<div class="ht-fr-foot">Der Gamemaster deckt Frage für Frage auf …</div>';
  }
  return `<div class="ht-finale-reveal">${head}<div class="ht-fr-log">${rows}</div>${foot}</div>`;
}

function heartsResultText(s) {
  if (!s.lastResult) return 'Runde vorbei.';
  const name = ((s.board || []).find((c) => c.id === s.lastResult.loserId) || {}).name || '';
  const via = s.lastResult.estimate ? ' (Schätzfrage)' : '';
  let t = '💔 ' + name + ' verliert ein Herz' + via + '.';
  if (s.lastResult.eliminatedId) t += ' Ausgeschieden!';
  return t;
}

// Schätzung abgeben
$('htEstimateSubmit').addEventListener('click', () => {
  const v = $('htEstimateInput').value;
  if (v === '' || isNaN(Number(v))) return toast('Bitte eine Zahl eingeben.', true);
  socket.emit('hearts:estimateGuess', { value: Number(v) }, (res) => {
    if (res && !res.ok) toast(res.error, true);
    else toast('Schätzung abgegeben!');
  });
});

// Hearts-Timer laufend aktualisieren.
setInterval(() => {
  if (lastState && lastState.gameType === 'hearts') htRenderTimer(lastState);
}, 250);

// ------------------------------------------------- "Wellenlänge"
const WV_PHASE = {
  lobby: 'Lobby',
  clue: 'Hinweis',
  guess: 'Raten',
  reveal: 'Auflösung',
  finished: 'Ende',
};

let wvSelectedGuess = null;
let wvGuessRound = null;

function submitWaveClue() {
  const text = $('wvClueInput').value.trim();
  if (!text) return toast('Bitte einen Hinweis eingeben.', true);
  socket.emit('wave:submitClue', { text }, (res) => {
    if (res && !res.ok) return toast(res.error, true);
    $('wvClueInput').value = '';
  });
}
$('wvClueSubmit').addEventListener('click', submitWaveClue);
$('wvClueInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitWaveClue();
});
$('wvGuessSubmit').addEventListener('click', () => {
  if (wvSelectedGuess === null) return toast('Bitte einen Wert auf der Skala wählen.', true);
  socket.emit('wave:submitGuess', { value: wvSelectedGuess }, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
});

function renderWave(s) {
  hide(appEl);
  hide($('avatarBar'));
  hide($('heartsView'));
  hide($('heartsPopup'));
  show($('waveView'));

  $('wvMyTeam').textContent = s.myTeamName ? '👥 ' + s.myTeamName : 'ohne Team';
  $('wvPhaseInfo').textContent = WV_PHASE[s.phase] || s.phase;

  const t = s.turn || {};
  const stage = $('wvStagePlayer');

  // Auswahl zurücksetzen, wenn eine neue Runde beginnt.
  if (s.round !== wvGuessRound) {
    wvSelectedGuess = null;
    wvGuessRound = s.round;
  }

  if (s.phase === 'lobby') {
    stage.innerHTML = `<div class="wv-stage-empty">${
      s.myTeamName
        ? 'Dein Team: <b>' + escapeHtml(s.myTeamName) + '</b><br>Warte, bis der Gamemaster startet …'
        : 'Der Gamemaster teilt gleich die Teams ein …'
    }</div>`;
    hide($('wvClueForm'));
    hide($('wvGuessBar'));
    $('wvHint').textContent = 'Zweier-Teams: einer gibt einen Hinweis, der andere rät die Zahl.';
    return;
  }

  if (s.phase === 'finished') {
    stage.innerHTML = `<div class="wv-stage-empty">${
      s.winnerTeamName ? '🏆 <b>' + escapeHtml(s.winnerTeamName) + '</b> gewinnt!' : 'Spiel beendet.'
    }</div>`;
    hide($('wvClueForm'));
    hide($('wvGuessBar'));
    $('wvHint').innerHTML = renderWaveStandingsText(s);
    return;
  }

  const selectable = s.awaitingGuess === true;

  WaveScale.render(stage, {
    scaleMax: s.scaleMax,
    topic: t.category ? t.category.topic : '',
    low: t.category ? t.category.low : '',
    high: t.category ? t.category.high : '',
    target: t.target, // vom Server nur gesetzt, wenn ich es sehen darf
    guess: t.guess,
    clue: t.clue,
    selectable,
    selected: selectable ? wvSelectedGuess : null,
    onSelect: (v) => {
      wvSelectedGuess = v;
      $('wvGuessSubmit').disabled = false;
      renderWave(lastState); // neu zeichnen für Markierung
    },
  });

  // Hinweis-Formular (nur aktiver Hinweisgeber in clue-Phase)
  $('wvClueForm').classList.toggle('hidden', !s.awaitingClue);
  // Rate-Leiste (nur aktiver Ratender in guess-Phase)
  $('wvGuessBar').classList.toggle('hidden', !selectable);
  $('wvGuessSubmit').disabled = wvSelectedGuess === null;

  $('wvHint').innerHTML = waveHintText(s);
}

function waveHintText(s) {
  const t = s.turn || {};
  const role = s.myRole; // 'clue' | 'guess' | 'teammate' | 'spectator'

  if (s.phase === 'reveal') {
    if (t.revealed) {
      const pts = t.points === 3 ? '3 Punkte 🎯' : t.points === 1 ? '1 Punkt' : '0 Punkte';
      return `Zielzahl war <b>${t.target}</b>, getippt wurde <b>${t.guess}</b> (Abstand ${t.distance}) → <b>${pts}</b> für ${escapeHtml(t.teamName)}.`;
    }
    if (t.guessShown) {
      return `Tipp: <b>${t.guess}</b>. Der Gamemaster löst gleich auf …`;
    }
    return 'Der Gamemaster zeigt gleich den Tipp …';
  }
  if (role === 'clue') {
    if (s.awaitingClue)
      return `🎤 Du bist dran! Deine geheime Zahl ist <b>${t.target}</b>. Gib EIN Wort ein, mit dem dein Team sie errät.`;
    return `Hinweis „<b>${escapeHtml(t.clue || '')}</b>" gesendet. Warte, bis ${escapeHtml(t.guesserName)} tippt …`;
  }
  if (role === 'guess') {
    if (s.awaitingGuess)
      return `🤔 Du tippst für dein Team! Hinweis: „<b>${escapeHtml(t.clue || '')}</b>". Wähle einen Wert auf der Skala.`;
    return `Dein:e Hinweisgeber:in ${escapeHtml(t.clueGiverName)} überlegt sich einen Hinweis …`;
  }
  if (role === 'teammate') {
    if (s.phase === 'clue')
      return `Dein Team ist dran – ${escapeHtml(t.clueGiverName)} überlegt sich einen Hinweis …`;
    return `Beratet euch! Hinweis: „<b>${escapeHtml(t.clue || '')}</b>". <b>${escapeHtml(t.guesserName)}</b> gibt für euer Team den Tipp ab.`;
  }
  // Zuschauer (anderes Team)
  return `👀 <b>${escapeHtml(t.teamName)}</b> ist dran (${escapeHtml(t.clueGiverName)} gibt den Hinweis, ${escapeHtml(t.guesserName)} tippt).`;
}

function renderWaveStandingsText(s) {
  const st = s.standings || [];
  if (!st.length) return '';
  return (
    'Endstand: ' +
    st.map((t) => `${escapeHtml(t.name)} <b>${t.score}</b>`).join(' · ')
  );
}

// ------------------------------------------------- "Quiz-Duell" (Jeopardy)
const JP_PHASE = { lobby: 'Lobby', board: 'Board', question: 'Frage', finished: 'Ende' };

$('jpRenameBtn').addEventListener('click', () => {
  const cur = (lastState && lastState.myTeamName) || '';
  const name = prompt('Neuer Teamname:', cur);
  if (name && name.trim()) socket.emit('jeopardy:renameMyTeam', { name: name.trim() }, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
});

function jpEmit(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
}

// Buzzer per Leertaste (zusätzlich zum Klick).
document.addEventListener('keydown', (e) => {
  if (currentGameType !== 'jeopardy') return;
  if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const c = lastState && lastState.current;
  if (c && c.canBuzz) {
    e.preventDefault();
    jpEmit('jeopardy:buzz');
  }
});

function renderJeopardy(s) {
  hide(appEl);
  hide($('avatarBar'));
  hide($('heartsView'));
  hide($('heartsPopup'));
  hide($('waveView'));
  show($('jeopardyView'));

  $('jpMyTeam').textContent = s.myTeamName ? '👥 ' + s.myTeamName : 'ohne Team';
  $('jpMyTeam').style.background = s.myTeamColor || '';
  $('jpMyTeam').style.color = s.myTeamColor ? '#fff' : '';
  $('jpPhaseInfo').textContent = JP_PHASE[s.phase] || s.phase;
  $('jpRenameBtn').classList.toggle('hidden', !(s.phase === 'lobby' && s.myTeamId));

  JeopardyUI.renderSidePlayers($('jpLeft'), $('jpRight'), s, avatars);
  JeopardyUI.renderScoreboard($('jpScoreboard'), s);

  if (s.phase === 'lobby') {
    $('jpBoardInfo').innerHTML = '';
    $('jpBoard').innerHTML = `<div class="jp-lobby-msg">${
      s.myTeamName
        ? 'Dein Team: <b>' + escapeHtml(s.myTeamName) + '</b><br>Warte, bis der Gamemaster startet …'
        : 'Der Gamemaster teilt gleich die Teams ein …'
    }</div>`;
    show($('jpBoard')); hide($('jpQuestion')); JeopardyUI.stopMedia($('jpQuestion'));
    $('jpActions').innerHTML = '';
    $('jpHint').textContent = 'Quiz-Duell: Team wählt Fragen, buzzern zum Klauen, Joker clever einsetzen!';
    return;
  }

  if (s.phase === 'finished') {
    $('jpBoardInfo').innerHTML = '';
    $('jpBoard').innerHTML = `<div class="jp-lobby-msg jp-winner-msg">${
      s.winnerTeamName ? '🏆 <b>' + escapeHtml(s.winnerTeamName) + '</b> gewinnt!' : 'Spiel beendet.'
    }</div>`;
    show($('jpBoard')); hide($('jpQuestion')); JeopardyUI.stopMedia($('jpQuestion'));
    $('jpActions').innerHTML = '';
    $('jpHint').innerHTML = (s.standings || [])
      .map((t) => `${escapeHtml(t.name)}: <b>${t.score}</b> (${t.answered} richtig)`)
      .join(' · ');
    return;
  }

  // board / question
  $('jpBoardInfo').innerHTML = `<span class="jp-round">${escapeHtml(s.boardName || ('Board ' + s.round))}</span>
    <span class="badge">Board ${s.round}/${s.boardCount}</span>
    ${s.multiplierActive > 1 ? `<span class="badge wait">×${s.multiplierActive}</span>` : ''}`;

  if (s.phase === 'question' && s.current) {
    hide($('jpBoard'));
    show($('jpQuestion'));
    JeopardyUI.renderQuestion($('jpQuestion'), s, { admin: false });
  } else {
    JeopardyUI.stopMedia($('jpQuestion'));
    show($('jpBoard'));
    hide($('jpQuestion'));
    JeopardyUI.renderBoard($('jpBoard'), s, {
      clickable: !!s.canPick,
      onPick: (ci, qi) => jpEmit('jeopardy:select', { bi: s.round - 1, ci, qi }),
    });
  }

  renderJpActions(s);
}

function renderJpActions(s) {
  const el = $('jpActions');
  const btns = [];
  const c = s.current;

  // Buzzer
  if (c && c.canBuzz) {
    btns.push('<button class="btn danger lg jp-buzz" data-act="buzz">🔴 BUZZER <span class="jp-buzz-key">Leertaste</span></button>');
  }
  // Kein-Risiko (während eigener Antwort)
  if (c && c.canNoRisk) {
    btns.push('<button class="btn lg" data-act="joker" data-type="noRisk">🛡️ Kein-Risiko</button>');
  }
  // Vor-der-Frage-Joker (nur eigenes Team am Zug bzw. Kaffeepause auf andere), nur in Board-Phase
  if (s.phase === 'board' && s.myTeamId) {
    const mj = s.myJokers || {};
    const iAmActive = s.activeTeamId === s.myTeamId;
    if (iAmActive && (mj.allOrNothing || 0) > 0) {
      btns.push('<button class="btn lg" data-act="joker" data-type="allOrNothing">🎲 Alles-oder-Nichts</button>');
    }
    if (!iAmActive && (mj.coffee || 0) > 0) {
      btns.push('<button class="btn lg" data-act="coffee">☕ Kaffeepause</button>');
    }
  }

  el.innerHTML = btns.join('');
  const buzz = el.querySelector('[data-act="buzz"]');
  if (buzz) buzz.addEventListener('click', () => jpEmit('jeopardy:buzz'));
  el.querySelectorAll('[data-act="joker"]').forEach((b) =>
    b.addEventListener('click', () => jpEmit('jeopardy:useJoker', { type: b.dataset.type }))
  );
  const coffee = el.querySelector('[data-act="coffee"]');
  if (coffee) coffee.addEventListener('click', () => jpCoffeePrompt(s));

  // Hinweistext
  $('jpHint').innerHTML = jpHintText(s);
}

function jpCoffeePrompt(s) {
  const targets = (s.teams || []).filter((t) => t.id !== s.myTeamId && t.id !== s.activeTeamId);
  if (!targets.length) return toast('Kein gültiges Zielteam.', true);
  // Einfache Auswahl per prompt (Zahl)
  const list = targets.map((t, i) => `${i + 1}) ${t.name}`).join('\n');
  const pick = prompt('Kaffeepause auf welches Team?\n' + list, '1');
  const idx = parseInt(pick, 10) - 1;
  if (idx >= 0 && idx < targets.length) {
    jpEmit('jeopardy:useJoker', { type: 'coffee', targetTeamId: targets[idx].id });
  }
}

function jpHintText(s) {
  const c = s.current;
  if (s.phase === 'question' && c) {
    if (c.lastOutcome) {
      return c.lastOutcome.correct
        ? `✅ Richtig! ${escapeHtml(c.lastOutcome.teamName)} ${c.lastOutcome.delta > 0 ? '+' : ''}${c.lastOutcome.delta}`
        : `❌ Falsch – ${escapeHtml(c.lastOutcome.teamName)} ${c.lastOutcome.delta}`;
    }
    if (c.iAmAnswering) return '🎤 Ihr seid dran – antwortet laut! Der Gamemaster wertet.';
    if (c.canBuzz) return '🔴 Falsch beantwortet – jetzt könnt ihr klauen! Buzzern!';
    if (c.stage === 'stealOpen') return 'Buzzer offen für die anderen Teams …';
    return 'Der Gamemaster wertet die Antwort aus …';
  }
  if (s.phase === 'board') {
    if (s.canPick) return '🎯 Ihr seid am Zug – wählt eine Frage auf dem Board!';
    const at = (s.teams || []).find((t) => t.id === s.activeTeamId);
    return at ? `${escapeHtml(at.name)} ist am Zug …` : 'Warte auf das nächste Team …';
  }
  return '';
}

// Timer-Ticken (Spieler)
let jpTimerInt = null;
function jpTick() {
  if (!lastState || lastState.gameType !== 'jeopardy' || !lastState.current) return;
  const el = $('jpQuestion').querySelector('.jp-timer');
  if (!el) return;
  const rem = JeopardyUI.timerRemaining(lastState.current.timer);
  const secs = Math.ceil(rem / 1000);
  const v = el.querySelector('.jp-timer-val');
  if (v) v.textContent = secs;
  el.classList.toggle('low', secs <= 5 && secs > 0);
  el.classList.toggle('zero', secs === 0);
}

// ------------------------------------------------------------- Socket
socket.on('avatars', (map) => {
  if (!state.playerId) return; // nach Verlassen/Rauswurf ignorieren
  avatars = map || {};
  if (currentGameType === 'hearts') {
    if (lastState) renderHearts(lastState);
  } else if (currentGameType === 'wave') {
    // Wellenlänge nutzt keine Avatare – nichts zu tun.
  } else if (currentGameType === 'jeopardy') {
    if (lastState) renderJeopardy(lastState);
  } else {
    renderAvatarBar();
  }
});
if (!jpTimerInt) jpTimerInt = setInterval(jpTick, 250);
socket.on('state', render);
socket.on('kicked', (info) => {
  resetToJoin((info && info.reason) || 'Du wurdest vom Gamemaster entfernt.');
});
socket.on('connect', () => {
  // Bei Reconnect erneut anmelden
  if (state.token && state.code) {
    attemptJoin(null, state.code, state.token);
  }
});
