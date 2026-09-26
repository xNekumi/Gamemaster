/* global io */
const socket = io();

// Ein per "Neue Lobby" geöffneter Tab erbt die sessionStorage-Kopie des
// Opener-Tabs. Damit wirklich eine neue Lobby entsteht, verwerfen wir bei
// ?new=1 die kopierte Admin-Sitzung, bevor sie gelesen wird.
if (new URLSearchParams(location.search).get('new') === '1') {
  sessionStorage.removeItem('gm_admin_code');
  sessionStorage.removeItem('gm_admin_token');
  history.replaceState(null, '', '/admin');
}

const state = {
  code: sessionStorage.getItem('gm_admin_code') || null,
  adminToken: sessionStorage.getItem('gm_admin_token') || null,
};

let avatars = {};
let lastRoster = [];
const rosterMap = () => Object.fromEntries(lastRoster.map((p) => [p.id, p]));
function brief(id, fallbackName) {
  const p = rosterMap()[id];
  return { id, name: (p && p.name) || fallbackName || '?', avatar: avatars[id] || null };
}

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

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

const PHASE_LABELS = {
  lobby: 'Lobby',
  answering: 'Antworten',
  voting: 'Abstimmung',
  reveal: 'Auflösung',
  finished: 'Beendet',
};
const GAME_NAMES = { bluff: 'Bluff-Quiz', hearts: 'Der dümmste fliegt', wave: 'Wellenlänge', jeopardy: 'Quiz-Duell' };

let currentGameType = 'bluff';

// ---------------------------------------------------------- Spielauswahl
let selectedGame = 'bluff';
$('gameChoice')
  .querySelectorAll('.game-opt')
  .forEach((btn) =>
    btn.addEventListener('click', () => {
      selectedGame = btn.dataset.game;
      $('gameChoice')
        .querySelectorAll('.game-opt')
        .forEach((b) => b.classList.toggle('selected', b === btn));
    })
  );

// ---------------------------------------------------------- Login
$('createBtn').addEventListener('click', () => {
  const password = $('pwInput').value;
  hide($('loginError'));
  $('createBtn').disabled = true;
  socket.emit('admin:createGame', { password, gameType: selectedGame }, (res) => {
    $('createBtn').disabled = false;
    if (!res.ok) {
      const e = $('loginError');
      e.textContent = res.error;
      show(e);
      return;
    }
    state.code = res.code;
    state.adminToken = res.adminToken;
    sessionStorage.setItem('gm_admin_code', res.code);
    sessionStorage.setItem('gm_admin_token', res.adminToken);
    enterControl(res.state);
  });
});
$('pwInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('createBtn').click();
});

function enterControl(s) {
  hide($('loginView'));
  show($('controlView'));
  $('roomPillCode').textContent = s.code;
  show($('roomPill'));
  $('bigCode').textContent = s.code;
  const link = `${location.origin}/?code=${s.code}`;
  $('joinLink').textContent = link;
  $('joinLink').href = link;
  render(s);
}

// Neue Lobby in einem neuen Tab öffnen (eigene Admin-Sitzung pro Tab -> parallel möglich)
$('newLobbyBtn').addEventListener('click', () => {
  window.open('/admin?new=1', '_blank');
});

$('copyLinkBtn').addEventListener('click', async () => {
  const link = $('joinLink').textContent;
  try {
    await navigator.clipboard.writeText(link);
    toast('Einladungslink kopiert!');
  } catch {
    prompt('Einladungslink (manuell kopieren):', link);
  }
});

// ---------------------------------------------------------- Aktionen
function emitAction(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
}
$('startBtn').addEventListener('click', () => emitAction('admin:startRound'));
$('startVotingBtn').addEventListener('click', () => emitAction('admin:startVoting'));
$('showAllBtn').addEventListener('click', () => emitAction('admin:showAllAnswers'));
$('openVotingBtn').addEventListener('click', () => emitAction('admin:openVoting'));
$('showResultsBtn').addEventListener('click', () => emitAction('admin:showResults'));
$('revealAllBtn').addEventListener('click', () => emitAction('admin:revealAll'));
$('nextQuestionBtn').addEventListener('click', () => emitAction('admin:nextQuestion'));
$('endGameBtn').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden und Endstand anzeigen?')) emitAction('admin:endGame');
});
$('restartBtn').addEventListener('click', () => emitAction('admin:backToLobby'));

// ---------------------------------------------------------- Rendern
let lastState = null;

// Dispatcher: wählt die Steuerung passend zum Spieltyp.
function render(s) {
  if (!s) return;
  lastState = s;
  currentGameType = s.gameType || 'bluff';
  $('roomPillCode').textContent = s.code;
  $('bigCode').textContent = s.code;
  $('statGame').textContent = GAME_NAMES[currentGameType] || currentGameType;
  $('statPlayers').textContent = s.playerCount ?? (s.board || s.scoreboard || []).length;
  $('statRound').textContent = s.round;

  document.body.classList.toggle('hearts-active', currentGameType === 'hearts');
  document.body.classList.toggle('wave-active', currentGameType === 'wave');
  document.body.classList.toggle('jeopardy-active', currentGameType === 'jeopardy');
  if (currentGameType === 'hearts') {
    hide($('bluffControl'));
    hide($('waveControl'));
    hide($('jeopardyControl'));
    hide($('avatarBar'));
    show($('heartsControl'));
    $('statPhase').textContent = HT_PHASE_LABELS[s.phase] || s.phase;
    renderHeartsAdmin(s);
  } else if (currentGameType === 'wave') {
    hide($('bluffControl'));
    hide($('heartsControl'));
    hide($('jeopardyControl'));
    hide($('avatarBar'));
    show($('waveControl'));
    $('statPhase').textContent = WV_PHASE_LABELS[s.phase] || s.phase;
    renderWaveAdmin(s);
  } else if (currentGameType === 'jeopardy') {
    hide($('bluffControl'));
    hide($('heartsControl'));
    hide($('waveControl'));
    hide($('avatarBar'));
    show($('jeopardyControl'));
    $('statPhase').textContent = JP_PHASE_LABELS[s.phase] || s.phase;
    renderJeopardyAdmin(s);
  } else {
    show($('bluffControl'));
    hide($('heartsControl'));
    hide($('waveControl'));
    hide($('jeopardyControl'));
    $('statPhase').textContent = PHASE_LABELS[s.phase] || s.phase;
    renderBluff(s);
  }
}

function renderBluff(s) {
  $('statPhase').textContent = PHASE_LABELS[s.phase] || s.phase;

  if (s.roster) {
    lastRoster = s.roster;
    renderAvatarBar();
  }
  renderAdminPlayers(s);
  renderAdminScoreboard(s);

  ['phaseLobby', 'phaseAnswering', 'phaseVoting', 'phaseReveal', 'phaseFinished'].forEach((id) =>
    hide($(id))
  );

  switch (s.phase) {
    case 'lobby':
      show($('phaseLobby'));
      $('startBtn').disabled = (s.scoreboard || []).length === 0;
      break;
    case 'answering':
      show($('phaseAnswering'));
      $('adminQuestion').textContent = s.question;
      $('correctAnswerAns').textContent = s.correctAnswer;
      $('answeredCount').textContent = s.answeredCount ?? 0;
      $('answeredTotal').textContent = s.connectedCount ?? 0;
      renderQcAnswers(s);
      break;
    case 'voting': {
      show($('phaseVoting'));
      $('adminQuestionV').textContent = s.question;
      $('correctAnswerV').textContent = s.correctAnswer;
      const open = !!s.votingOpen;
      $('votingBadge').textContent = open ? '🗳️ Spieler stimmen ab' : '🎭 Antworten präsentieren';
      $('votingStat').innerHTML = open
        ? `<span>${s.votedCount ?? 0}</span>/<span>${s.connectedCount ?? 0}</span><small>gestimmt</small>`
        : `<span>${s.shownCount ?? 0}</span>/<span>${(s.answers || []).length}</span><small>eingeblendet</small>`;
      $('presentHint').style.display = open ? 'none' : '';
      $('presentControls').classList.toggle('hidden', open);
      $('voteControls').classList.toggle('hidden', !open);
      renderVotingAnswers(s, open);
      break;
    }
    case 'reveal':
      show($('phaseReveal'));
      $('adminQuestionR').textContent = s.question;
      renderAdminReveal(s);
      break;
    case 'finished':
      show($('phaseFinished'));
      break;
  }
}

// ---- Antwort-Phase: editierbare QC-Liste ----------------------------
function renderQcAnswers(s) {
  const el = $('qcAnswers');
  const answers = (s.answers || []).filter((a) => !a.isTruth);
  $('qcEmpty').style.display = answers.length ? 'none' : 'block';

  // Nur neu aufbauen, wenn sich Anzahl geändert hat (damit Tippen nicht unterbrochen wird)
  const signature = answers.map((a) => a.id).join(',');
  if (el.dataset.sig === signature) return;
  el.dataset.sig = signature;

  el.innerHTML = '';
  answers.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'qc-row';
    row.innerHTML = `
      <span class="qc-author">${escapeHtml(a.authorName)}</span>
      <input type="text" class="qc-input" maxlength="200" value="${escapeHtml(a.text)}" />
      <span class="qc-saved">✓</span>`;
    const input = row.querySelector('.qc-input');
    const saved = row.querySelector('.qc-saved');
    const commit = () => {
      const text = input.value.trim();
      if (!text || text === a.text) return;
      socket.emit('admin:editAnswer', { answerId: a.id, text }, (res) => {
        if (!res.ok) return toast(res.error, true);
        a.text = text;
        saved.classList.add('show');
        setTimeout(() => saved.classList.remove('show'), 1200);
      });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    el.appendChild(row);
  });
}

// Avatar-Kreise für eine Wähler-Liste (IDs -> kleine Kreise).
function voterCircles(a) {
  const ids = a.voterIds || [];
  if (!ids.length) return '<span class="rev-novote">keine Stimmen</span>';
  return ids
    .map((id, i) => {
      const b = brief(id, (a.voters || [])[i]);
      return GM.avatarCircle(b.name, b.avatar, 'sm');
    })
    .join('');
}

// ---- Präsentation & Abstimmung: einblenden + Live-Stimmen -----------
function renderVotingAnswers(s, open) {
  const el = $('adminVotingAnswers');
  el.innerHTML = '';
  (s.answers || []).forEach((a) => {
    const covered = !a.shown;
    const row = document.createElement('div');
    row.className = 'rev-row ' + (a.isTruth ? 'truth ' : '') + (covered ? 'covered clickable' : '');

    let author, midLabel, right;
    if (covered) {
      author = '<div class="av-circle locked">👁️</div>';
      midLabel = '<span class="rev-author-name dim">verdeckt · klicken zum Einblenden</span>';
      right = '<span class="tag">einblenden</span>';
    } else {
      const b = brief(a.authorId, a.authorName);
      author = a.isTruth
        ? '<div class="av-circle truth-circle">✅</div>'
        : GM.avatarCircle(b.name, b.avatar);
      midLabel = `<span class="rev-author-name">${a.isTruth ? 'Richtige Antwort' : GM.escapeHtml(b.name)}</span>`;
      right = open ? voterCircles(a) : '';
    }

    row.innerHTML = `
      <div class="rev-left">${author}</div>
      <div class="rev-mid"><div class="rev-text">${escapeHtml(a.text)}</div>${midLabel}</div>
      <div class="rev-right">${right}</div>`;
    if (covered) row.addEventListener('click', () => emitAction('admin:showAnswer', { answerId: a.id }));
    el.appendChild(row);
  });
}

// ---- Auflösung ------------------------------------------------------
function renderAdminReveal(s) {
  const el = $('adminRevealAnswers');
  el.innerHTML = '';
  (s.answers || []).forEach((a) => {
    const row = document.createElement('div');
    row.className = `rev-row ${a.revealed && a.isTruth ? 'truth' : ''} ${a.revealed ? '' : 'covered clickable'}`;

    let author;
    if (!a.revealed) author = `<div class="av-circle locked">${a.voteCount}</div>`;
    else if (a.isTruth) author = '<div class="av-circle truth-circle">✅</div>';
    else author = GM.avatarCircle(brief(a.authorId, a.authorName).name, brief(a.authorId, a.authorName).avatar);

    const midLabel = !a.revealed
      ? `<span class="rev-author-name dim">${a.voteCount} Stimme(n) · klicken zum Aufdecken</span>`
      : a.isTruth
      ? '<span class="rev-author-name">Richtige Antwort</span>'
      : `<span class="rev-author-name">${GM.escapeHtml(brief(a.authorId, a.authorName).name)}</span>`;

    row.innerHTML = `
      <div class="rev-left">${author}</div>
      <div class="rev-mid"><div class="rev-text">${escapeHtml(a.text)}</div>${midLabel}</div>
      <div class="rev-right">${a.revealed ? voterCircles(a) : ''}</div>`;
    if (!a.revealed) {
      row.addEventListener('click', () => emitAction('admin:revealAnswer', { answerId: a.id }));
    }
    el.appendChild(row);
  });
}

// ---- Avatar-Leiste --------------------------------------------------
function renderAvatarBar() {
  const bar = $('avatarBar');
  if (!lastRoster.length) {
    hide(bar);
    return;
  }
  show(bar);
  bar.innerHTML = lastRoster
    .map(
      (p) => `<div class="av-tile ${p.connected ? '' : 'off'}">
        <div class="av-media">${GM.avatarInner(p.name, avatars[p.id])}</div>
        <div class="av-score" title="Punkte">${p.score}</div>
        <div class="av-name">${GM.escapeHtml(p.name)}</div>
      </div>`
    )
    .join('');
}

// ---- Seitenleiste ---------------------------------------------------
function renderAdminPlayers(s) {
  const players = s.answerStatus || s.scoreboard || [];
  $('playerCountBadge').textContent = `${players.length}`;
  const el = $('adminPlayers');
  el.innerHTML = players
    .map((p) => {
      let status = '';
      if (s.phase === 'answering') status = p.answered ? '<span class="chip-status ok">✅</span>' : '<span class="chip-status">…</span>';
      else if (s.phase === 'voting') status = p.voted ? '<span class="chip-status ok">🗳️</span>' : '<span class="chip-status">…</span>';
      return `<span class="chip ${p.connected === false ? 'off' : ''}">
        <span class="dot"></span><span class="chip-name">${escapeHtml(p.name)}</span>${status}
        <span class="x" data-id="${p.id}" title="Entfernen">✕</span>
      </span>`;
    })
    .join('');
  $('noPlayers').style.display = players.length ? 'none' : 'block';

  el.querySelectorAll('.x').forEach((x) =>
    x.addEventListener('click', () => {
      if (confirm('Spieler wirklich entfernen?'))
        emitAction('admin:kickPlayer', { playerId: x.dataset.id });
    })
  );
}

function renderAdminScoreboard(s) {
  const list = s.scoreboard || [];
  $('adminScoreboard').innerHTML = list.length
    ? list
        .map(
          (p, i) => `
      <div class="score-row ${i === 0 && p.score > 0 ? 'top1' : ''}">
        <div class="rank">${i === 0 && p.score > 0 ? '👑' : i + 1}</div>
        <div class="name">${escapeHtml(p.name)}${p.connected === false ? ' <span class="badge off">off</span>' : ''}</div>
        <div class="pts">${p.score}</div>
      </div>`
        )
        .join('')
    : '<p class="hint">Noch keine Spieler.</p>';
}

// ==================================================================
//  "Der dümmste fliegt" – Admin-Steuerung
// ==================================================================
const HT_PHASE_LABELS = {
  lobby: 'Lobby',
  question: 'Fragerunde',
  voting: 'Abstimmung',
  reveal: 'Auflösung',
  roundEnd: 'Rundenende',
  estimate: 'Schätzfrage',
  finale: 'Finale',
  finished: 'Beendet',
};

let htPendingCorrect = null; // null | true | false

function heartsAction(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
}

// ---- Buttons verdrahten
$('htStartGameBtn').addEventListener('click', () => heartsAction('hearts:startGame'));
$('htNextActiveBtn').addEventListener('click', () => heartsAction('hearts:nextActive'));
$('htAskBtn').addEventListener('click', () => heartsAction('hearts:askQuestion'));
$('htAskCustomBtn').addEventListener('click', () => {
  const text = $('htCustomQuestion').value.trim();
  if (!text) return toast('Bitte eine Frage eingeben.', true);
  heartsAction('hearts:askQuestion', { text });
  $('htCustomQuestion').value = '';
});
$('htCorrectBtn').addEventListener('click', () => setPendingCorrect(true));
$('htWrongBtn').addEventListener('click', () => setPendingCorrect(false));
$('htSubmitAnswerBtn').addEventListener('click', () => {
  const text = $('htAnswerInput').value.trim();
  if (!text) return toast('Bitte die Antwort eintragen.', true);
  socket.emit('hearts:submitAnswer', { text, correct: htPendingCorrect }, (res) => {
    if (res && !res.ok) return toast(res.error, true);
    $('htAnswerInput').value = '';
    setPendingCorrect(null);
  });
});
$('htStartVotingBtn').addEventListener('click', () => heartsAction('hearts:startVoting'));
$('htGoRevealBtn').addEventListener('click', () => heartsAction('hearts:goToReveal'));
$('htRevealAllBtn').addEventListener('click', () => heartsAction('hearts:revealAllVotes'));
$('htConfirmBtn').addEventListener('click', () => heartsAction('hearts:confirmResult'));
$('htNextRoundBtn').addEventListener('click', () => heartsAction('hearts:nextRound'));
const skipRound = () => {
  if (confirm('Runde ohne Abstimmung überspringen? Niemand verliert ein Herz.')) heartsAction('hearts:skipRound');
};
$('htSkipRoundBtn').addEventListener('click', skipRound);
$('htSkipVotingBtn').addEventListener('click', skipRound);
$('htMoreQuestionsBtn').addEventListener('click', () => heartsAction('hearts:continueQuestions'));
$('htToVotingBtn').addEventListener('click', () => heartsAction('hearts:startVoting'));

// Abstimmung verwerfen -> Admin entscheidet manuell (roundEnd)
const closeVoting = () => {
  if (confirm('Abstimmung verwerfen? Du entscheidest danach selbst, wer ein Leben verliert.'))
    heartsAction('hearts:closeVoting');
};
$('htCloseVotingBtn').addEventListener('click', closeVoting);
$('htCloseVotingRevealBtn').addEventListener('click', closeVoting);

// Finale-Bewertung
$('htFinaleCorrectBtn').addEventListener('click', () => heartsAction('hearts:finaleAnswer', { correct: true }));
$('htFinaleWrongBtn').addEventListener('click', () => heartsAction('hearts:finaleAnswer', { correct: false }));
$('htFinaleRevealNextBtn').addEventListener('click', () => heartsAction('hearts:finaleRevealNext'));
$('htFinaleFinishBtn').addEventListener('click', () => heartsAction('hearts:finaleFinish'));
$('htFinaleTiebreakBtn').addEventListener('click', () => heartsAction('hearts:finaleTiebreak'));

// Timer-Steuerung
$('htTimerStartBtn').addEventListener('click', () => heartsAction('hearts:startTimer'));
$('htTimerStopBtn').addEventListener('click', () => heartsAction('hearts:stopTimer'));
$('htTimerResetBtn').addEventListener('click', () => heartsAction('hearts:resetTimer'));
$('htTimerSeconds').addEventListener('change', () =>
  heartsAction('hearts:setTimerSeconds', { seconds: parseInt($('htTimerSeconds').value, 10) || 30 })
);
$('htTimerAuto').addEventListener('change', () =>
  heartsAction('hearts:setTimerAutoStart', { on: $('htTimerAuto').checked })
);

// Schätzfrage
$('htEstAskBtn').addEventListener('click', () => {
  const question = $('htEstQuestion').value.trim();
  const answer = $('htEstAnswer').value;
  if (!question) return toast('Bitte eine Frage eingeben.', true);
  if (answer === '' || isNaN(Number(answer))) return toast('Bitte eine Zahl als Lösung eingeben.', true);
  heartsAction('hearts:setEstimateQuestion', { question, answer: Number(answer) });
});
$('htEstNewBtn').addEventListener('click', () => {
  $('htEstQuestion').value = '';
  $('htEstAnswer').value = '';
  // Setup wieder zeigen, indem estimate ohne Frage bleibt -> render blendet Setup ein.
  // Trick: erneut Auflösen ist blockiert; Admin gibt neue Frage direkt ein.
  $('htEstRunning').classList.add('hidden');
  $('htEstimateSetup').classList.remove('hidden');
});
$('htEstRevealBtn').addEventListener('click', () => heartsAction('hearts:revealEstimate'));
$('htEstConfirmBtn').addEventListener('click', () => heartsAction('hearts:confirmEstimate'));

// Timer-Anzeige laufend aktualisieren (Admin)
setInterval(() => {
  if (lastState && lastState.gameType === 'hearts') htAdminTick(lastState);
}, 250);
function htAdminTick(s) {
  const t = s.timer;
  if (!t) return;
  const secs = Math.ceil(HeartsTimer.remaining(t) / 1000);
  const el = $('htTimerVal');
  if (el) el.textContent = secs;
  const panel = $('htTimerPanel');
  if (panel) {
    panel.classList.toggle('low', secs <= 5 && secs > 0);
    panel.classList.toggle('zero', secs === 0);
    panel.classList.toggle('running', !!t.running);
  }
}

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
$('htBackLobbyBtn').addEventListener('click', () => heartsAction('hearts:backToLobby'));
$('htEndGameBtn').addEventListener('click', () => {
  if (confirm('Spiel wirklich abbrechen?')) heartsAction('hearts:endGame');
});

function setPendingCorrect(v) {
  htPendingCorrect = v;
  $('htCorrectBtn').classList.toggle('on', v === true);
  $('htWrongBtn').classList.toggle('on', v === false);
}

// ---- Board & Panel rendern
function renderHeartsAdmin(s) {
  // Board (Admin klickt Kachel, um den Hot-Seat zu setzen bzw. in Reveal Stimmen aufzudecken)
  const clickable =
    s.phase === 'question' ? (s.board || []).filter((c) => !c.eliminated).map((c) => c.id) : [];
  HeartsBoard.render($('heartsAdminBoard'), s, avatars, {
    votableIds: clickable,
    onTileClick: clickable.length ? (id) => heartsAction('hearts:setActive', { playerId: id }) : null,
    hurtIds: heartsHurtIds(s),
  });

  // Entscheidungs-Popup: alle hatten ihre Fragen -> weitere Runde oder Voting
  $('htDecision').classList.toggle('hidden', !(s.phase === 'question' && s.decisionPending));
  // Finale-Banner
  $('htFinaleNote').classList.toggle('hidden', s.phase !== 'finale');
  // Leben-manuell-abziehen-Panel (in allen aktiven Phasen außer Lobby/Finale/Ende)
  renderLifePanel(s);
  // Timer-Panel nur in relevanten Phasen
  renderHeartsTimerPanel(s);

  ['htLobby', 'htQuestion', 'htVoting', 'htReveal', 'htRoundEnd', 'htFinale', 'htEstimate', 'htFinished'].forEach((id) =>
    hide($(id))
  );
  hide($('htEndRow'));

  switch (s.phase) {
    case 'lobby':
      show($('htLobby'));
      $('htStartGameBtn').disabled = (s.board || []).length < 2;
      renderHeartsLobbyPlayers(s);
      break;
    case 'question':
      show($('htQuestion'));
      show($('htEndRow'));
      renderHeartsQuestion(s);
      break;
    case 'voting':
      show($('htVoting'));
      show($('htEndRow'));
      $('htRunoffBadge').classList.toggle('hidden', !s.isRunoff);
      $('htVotedCount').textContent = Object.keys(s.allVotes || {}).length;
      $('htVotersTotal').textContent = (s.voters || []).length;
      // Sperren ist jederzeit möglich (der Admin entscheidet); Zähler zeigt den Stand.
      $('htGoRevealBtn').disabled = false;
      break;
    case 'reveal':
      show($('htReveal'));
      show($('htEndRow'));
      renderHeartsReveal(s);
      break;
    case 'finale':
      show($('htFinale'));
      show($('htEndRow'));
      renderHeartsFinale(s);
      break;
    case 'estimate':
      show($('htEstimate'));
      show($('htEndRow'));
      renderHeartsEstimate(s);
      break;
    case 'roundEnd':
      show($('htRoundEnd'));
      show($('htEndRow'));
      renderHeartsRoundEnd(s);
      break;
    case 'finished':
      show($('htFinished'));
      $('htWinnerText').textContent = s.winnerName ? '🏆 ' + s.winnerName + ' gewinnt!' : '🏁 Spiel beendet';
      break;
  }
}

// Rundenende: entweder Ergebnis + „Nächste Runde", oder (nach verworfenem
// Voting) die manuelle Auswahl, wer ein Leben verliert.
function renderHeartsRoundEnd(s) {
  const manual = s.manualPick && !s.lastResult;
  $('htManualPick').classList.toggle('hidden', !manual);
  $('htResultText').innerHTML = manual
    ? '✖️ <b>Abstimmung verworfen.</b> Du entscheidest.'
    : heartsAdminResult(s);

  const nextBtn = $('htNextRoundBtn');
  nextBtn.classList.toggle('hidden', manual);
  nextBtn.textContent = s.finaleNext ? '🏆 Zum Finale →' : 'Nächste Runde →';

  if (manual) {
    const living = (s.board || []).filter((c) => !c.eliminated);
    $('htManualPickList').innerHTML = living
      .map((c) => `<button class="btn danger" data-id="${c.id}">💔 ${escapeHtml(c.name)}</button>`)
      .join('');
    $('htManualPickList')
      .querySelectorAll('button')
      .forEach((b) =>
        b.addEventListener('click', () => heartsAction('hearts:removeLife', { playerId: b.dataset.id }))
      );
  }
}

// Leben-manuell-abziehen-Panel (Sicherheitsnetz für den Admin).
function renderLifePanel(s) {
  const panel = $('htLifePanel');
  const usable = ['question', 'voting', 'reveal', 'roundEnd'].includes(s.phase);
  panel.classList.toggle('hidden', !usable);
  if (!usable) return;
  const living = (s.board || []).filter((c) => !c.eliminated);
  $('htLifeList').innerHTML = living
    .map(
      (c) =>
        `<button class="btn sm danger" data-id="${c.id}">💔 ${escapeHtml(c.name)} (${c.hearts})</button>`
    )
    .join('');
  $('htLifeList')
    .querySelectorAll('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const name = (s.board.find((c) => c.id === b.dataset.id) || {}).name || '';
        if (confirm(`${name} wirklich 1 Leben abziehen?`))
          heartsAction('hearts:removeLife', { playerId: b.dataset.id });
      })
    );
}

// Finale-Steuerung (Admin sieht Fragen, Punktestand und bewertet).
function renderHeartsFinale(s) {
  const f = s.finale || {};
  const nameOf = (id) => ((s.board || []).find((c) => c.id === id) || {}).name || '?';
  const answering = f.stage === 'answering';

  $('htFinaleAnswering').classList.toggle('hidden', !answering);
  $('htFinaleReveal').classList.toggle('hidden', answering);

  const blockLabel = f.block > 1 ? `Stechen ${f.block - 1} · ` : '';
  $('htFinaleProgress').textContent = `${blockLabel}Frage ${f.questionNo || 1}/${f.blockSize || 10}`;
  $('htFinaleActive').textContent = f.activeId ? nameOf(f.activeId) : '–';

  if (answering) {
    $('htFinaleQuestion').textContent = s.currentQuestion ? s.currentQuestion.text : '–';
    $('htFinaleAnswer').querySelector('b').textContent =
      s.currentQuestion && s.currentQuestion.answer ? s.currentQuestion.answer : '– (keine hinterlegt)';
  } else {
    // Spannende Auflösung – Frage für Frage
    const fully = f.fullyRevealed;
    $('htFinaleRevealTitle').textContent = !fully
      ? `Auflösung – Frage ${f.revealIndex || 0}/${f.blockSize}`
      : f.tie
      ? '⚖️ Gleichstand!'
      : '🏆 ' + nameOf(f.leaderId) + ' gewinnt!';
    $('htFinaleRevealNextBtn').classList.toggle('hidden', fully);
    $('htFinaleFinishBtn').classList.toggle('hidden', !fully || f.tie);
    $('htFinaleTiebreakBtn').classList.toggle('hidden', !fully || !f.tie);
    // Aufdeck-Log
    const names = f.finalistNames || ['?', '?'];
    const rows = (f.revealLog || [])
      .map(
        (r) => `<div class="ht-fr-row">
          <span class="ht-fr-mark ${r.r0 ? 'ok' : 'no'}">${r.r0 ? '✓' : '✗'}</span>
          <span class="ht-fr-q" title="${escapeHtml('Lösung: ' + (r.answer || '—'))}">${r.no}. ${escapeHtml(r.question)}</span>
          <span class="ht-fr-mark ${r.r1 ? 'ok' : 'no'}">${r.r1 ? '✓' : '✗'}</span>
        </div>`
      )
      .join('');
    $('htFinaleRevealLog').innerHTML =
      `<div class="ht-fr-head"><span>${escapeHtml(names[0])}</span><span>Frage</span><span>${escapeHtml(names[1])}</span></div>` +
      rows;
    $('htFinaleScores').innerHTML = finaleScoresHtml(f, nameOf, true);
  }

  // Live-Punktestand (immer sichtbar für den Admin)
  $('htFinaleLive').innerHTML = finaleScoresHtml(f, nameOf, false);
}

function finaleScoresHtml(f, nameOf, big) {
  const scores = f.scores || {};
  return (f.finalists || [])
    .map((id) => {
      const lead = f.leaderId === id ? ' lead' : '';
      return `<div class="ht-finale-score-row${lead}${big ? ' big' : ''}">
        <span>${escapeHtml(nameOf(id))}</span><b>${scores[id] || 0}</b>
      </div>`;
    })
    .join('');
}

function renderHeartsTimerPanel(s) {
  const relevant = ['question', 'finale', 'estimate'].includes(s.phase);
  $('htTimerPanel').classList.toggle('hidden', !relevant);
  if (!relevant) return;
  if (document.activeElement !== $('htTimerSeconds')) {
    $('htTimerSeconds').value = s.timer ? s.timer.seconds : 30;
  }
  $('htTimerAuto').checked = !!s.timerAutoStart;
  const secs = s.timer ? Math.ceil(HeartsTimer.remaining(s.timer) / 1000) : 0;
  $('htTimerVal').textContent = secs;
}

function renderHeartsEstimate(s) {
  const e = s.estimate;
  const posed = !!(e && e.question);
  $('htEstimateSetup').classList.toggle('hidden', posed);
  $('htEstRunning').classList.toggle('hidden', !posed);
  if (!posed) return;
  $('htEstQText').textContent = e.question;
  $('htEstAText').textContent = e.answer;
  $('htEstGuessCount').textContent = e.guessCount || 0;
  $('htEstLiving').textContent = e.livingCount || 0;
  const revealed = e.revealed;
  $('htEstRevealBtn').classList.toggle('hidden', revealed);
  $('htEstConfirmBtn').classList.toggle('hidden', !(revealed && !e.tie));
  $('htEstNewBtn').classList.toggle('hidden', !(revealed && e.tie));
  if (revealed && e.result) {
    $('htEstResultAdmin').innerHTML =
      e.result.byPlayer
        .map(
          (p) =>
            `<div class="ht-est-row ${p.loser ? 'loser' : ''}"><span>${escapeHtml(p.name)}</span><span>${
              p.guess == null ? '—' : p.guess
            }</span><small>Δ ${p.distance == null ? '∞' : p.distance}</small></div>`
        )
        .join('') + (e.tie ? '<div class="hint">Gleichstand – bitte eine neue Schätzfrage stellen.</div>' : '');
  } else {
    $('htEstResultAdmin').innerHTML = '';
  }
}

function renderHeartsLobbyPlayers(s) {
  const players = s.board || [];
  $('htLobbyCount').textContent = players.length;
  const el = $('htLobbyPlayers');
  el.innerHTML = players
    .map(
      (p) => `<span class="chip">
        <span class="dot"></span><span class="chip-name">${escapeHtml(p.name)}</span>
        <span class="x" data-id="${p.id}" title="Entfernen">✕</span>
      </span>`
    )
    .join('');
  $('htLobbyEmpty').style.display = players.length ? 'none' : 'block';
  el.querySelectorAll('.x').forEach((x) =>
    x.addEventListener('click', () => {
      if (confirm('Spieler wirklich aus der Lobby entfernen?'))
        emitAction('admin:kickPlayer', { playerId: x.dataset.id });
    })
  );
}

function renderHeartsQuestion(s) {
  const active = (s.board || []).find((c) => c.id === s.activePlayerId);
  $('htActiveName').textContent = active ? active.name : '– (Spieler wählen)';
  $('htCurrentQuestion').textContent = s.currentQuestion ? s.currentQuestion.text : '– (noch keine Frage gestellt)';
  // Richtige Antwort immer sichtbar (nur Admin) – zum Abgleich mit der Spielerantwort
  const sol = s.currentQuestion ? (s.currentQuestion.answer || '– (keine hinterlegt)') : '–';
  $('htCurrentAnswer').querySelector('b').textContent = sol;

  // Antwortliste dieser Runde
  const list = $('htAnswerList');
  const answers = s.answers || [];
  list.innerHTML = answers.length
    ? answers
        .map((a) => {
          const name = (s.board.find((c) => c.id === a.playerId) || {}).name || '?';
          const tip = `Frage: ${a.question || '—'}\nLösung: ${a.solution || '—'}`;
          return `<div class="ht-answer-row" data-id="${a.id}" title="${escapeHtml(tip)}">
            <span class="ht-a-name">${escapeHtml(name)}</span>
            <span class="ht-a-text">${escapeHtml(a.text)}</span>
            <span class="ht-a-actions">
              <button class="ht-mini ${a.correct === true ? 'on-ok' : ''}" data-act="ok" title="richtig">🟢</button>
              <button class="ht-mini ${a.correct === false ? 'on-no' : ''}" data-act="no" title="falsch">🔴</button>
              <button class="ht-mini" data-act="del" title="entfernen">✕</button>
            </span>
          </div>`;
        })
        .join('')
    : '<p class="hint">Noch keine Antworten eingetragen.</p>';
  list.querySelectorAll('.ht-answer-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-act="ok"]').addEventListener('click', () =>
      heartsAction('hearts:setCorrect', { answerId: id, correct: true })
    );
    row.querySelector('[data-act="no"]').addEventListener('click', () =>
      heartsAction('hearts:setCorrect', { answerId: id, correct: false })
    );
    row.querySelector('[data-act="del"]').addEventListener('click', () =>
      heartsAction('hearts:removeAnswer', { answerId: id })
    );
  });

  // Voting-Gate
  const target = s.questionTarget || s.minQuestions;
  $('htStartVotingBtn').disabled = !s.canStartVoting;
  const counts = (s.board || [])
    .filter((c) => !c.eliminated)
    .map((c) => `${c.name}: ${(s.questionCount || {})[c.id] || 0}/${target}`)
    .join(' · ');
  $('htVotingHint').textContent = s.canStartVoting
    ? 'Alle haben genug Fragen gehabt – Voting kann starten.'
    : 'Fragen pro Spieler: ' + counts;
  $('htVotingGate').textContent = s.canStartVoting ? '✅ bereit' : '⏳ Fragen offen';
}

function renderHeartsReveal(s) {
  const list = $('htRevealList');
  const voters = s.voters || [];
  const allVotes = s.allVotes || {};
  list.innerHTML = voters
    .map((vid) => {
      const name = (s.board.find((c) => c.id === vid) || {}).name || '?';
      const target = allVotes[vid];
      const revealed = (s.votesByTarget[target] || []).includes(vid);
      const targetName = target ? (s.board.find((c) => c.id === target) || {}).name || '?' : '—';
      return `<div class="ht-reveal-row">
        <span class="ht-a-name">${escapeHtml(name)}</span>
        ${
          revealed
            ? `<span class="ht-rv-target">→ ${escapeHtml(targetName)}</span>`
            : `<button class="btn sm ht-reveal-btn" data-v="${vid}">aufdecken</button>`
        }
      </div>`;
    })
    .join('');
  list.querySelectorAll('.ht-reveal-btn').forEach((b) =>
    b.addEventListener('click', () => heartsAction('hearts:revealVote', { voterId: b.dataset.v }))
  );

  // Tally
  const counts = s.voteCounts || {};
  const rows = Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .map((id) => {
      const name = (s.board.find((c) => c.id === id) || {}).name || '?';
      return `<div class="ht-tally-row"><span>${escapeHtml(name)}</span><b>${counts[id]}</b></div>`;
    })
    .join('');
  $('htTally').innerHTML = rows || '<span class="hint">Noch keine Stimmen.</span>';
}

function heartsAdminResult(s) {
  if (!s.lastResult) return 'Runde vorbei.';
  const name = (s.board.find((c) => c.id === s.lastResult.loserId) || {}).name || '';
  let t = `💔 <b>${escapeHtml(name)}</b> verliert ein Herz.`;
  if (s.lastResult.eliminatedId) t += ' <span class="badge danger">Ausgeschieden</span>';
  return t;
}

// ============================================================ WELLENLÄNGE
const WV_PHASE_LABELS = {
  lobby: 'Lobby',
  clue: 'Hinweis',
  guess: 'Raten',
  reveal: 'Auflösung',
  finished: 'Beendet',
};

function waveAction(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
}

// ---- Buttons verdrahten
$('wvAddTeamBtn').addEventListener('click', () => waveAction('wave:addTeam'));
$('wvSetPointsBtn').addEventListener('click', () => {
  const v = parseInt($('wvPointsInput').value, 10);
  if (!v || v < 1) return toast('Bitte ein gültiges Punkteziel angeben.', true);
  waveAction('wave:setPointsToWin', { points: v });
});
$('wvStartBtn').addEventListener('click', () => waveAction('wave:startGame'));
$('wvShowGuessBtn').addEventListener('click', () => waveAction('wave:showGuess'));
$('wvRevealBtn').addEventListener('click', () => waveAction('wave:revealResult'));
$('wvNextTurnBtn').addEventListener('click', () => waveAction('wave:nextTurn'));
$('wvSkipBtn').addEventListener('click', () => {
  if (confirm('Runde ohne Wertung überspringen?')) waveAction('wave:skipTurn');
});
$('wvClueSaveBtn').addEventListener('click', () => {
  const text = $('wvClueEdit').value.trim();
  if (text) waveAction('wave:editClue', { text });
});
$('wvBackLobbyBtn').addEventListener('click', () => waveAction('wave:backToLobby'));
$('wvEndGameBtn').addEventListener('click', () => {
  if (confirm('Spiel wirklich abbrechen?')) waveAction('wave:endGame');
});

function renderWaveAdmin(s) {
  ['wvLobby', 'wvTurn', 'wvFinished'].forEach((id) => hide($(id)));
  hide($('wvEndRow'));

  // Bühne (Kategorie + Skala) – im Spielverlauf sichtbar
  if (s.phase !== 'lobby') {
    const t = s.turn || {};
    WaveScale.render($('wvStage'), {
      scaleMax: s.scaleMax,
      topic: t.category ? t.category.topic : '',
      low: t.category ? t.category.low : '',
      high: t.category ? t.category.high : '',
      target: t.target,
      guess: t.guess,
      clue: t.clue,
      selectable: false,
    });
    show($('wvStage'));
  } else {
    $('wvStage').innerHTML = '<div class="wv-stage-empty">Teams einteilen und Spiel starten …</div>';
    show($('wvStage'));
  }

  renderWaveStandings(s);

  if (s.phase === 'lobby') {
    show($('wvLobby'));
    $('wvPointsInput').value = s.pointsToWin;
    renderWaveLobby(s);
    return;
  }
  if (s.phase === 'finished') {
    show($('wvFinished'));
    $('wvWinnerText').textContent = s.winnerTeamName
      ? '🏆 ' + s.winnerTeamName + ' gewinnt!'
      : '🏁 Spiel beendet';
    return;
  }

  // clue / guess / reveal
  show($('wvTurn'));
  show($('wvEndRow'));
  renderWaveTurn(s);
}

function renderWaveLobby(s) {
  const teams = s.teams || [];
  const list = $('wvTeamList');
  list.innerHTML = teams
    .map((t) => {
      const members = t.players
        .map(
          (p) =>
            `<span class="wv-member">${escapeHtml(p.name)}<button class="wv-x" data-unassign="${p.id}" title="Aus Team nehmen">✕</button></span>`
        )
        .join('');
      const slot = t.players.length < 2 ? '<span class="wv-slot">braucht noch Spieler</span>' : '';
      return `<div class="wv-team ${t.full ? 'full' : ''}">
        <div class="wv-team-head">
          <b>${escapeHtml(t.name)}</b>
          <span class="wv-team-count">${t.players.length} Spieler</span>
          <button class="wv-team-del" data-delteam="${t.id}" title="Team entfernen">🗑️</button>
        </div>
        <div class="wv-team-members">${members}${slot}</div>
      </div>`;
    })
    .join('');
  if (!teams.length) list.innerHTML = '<p class="hint">Noch keine Teams. Lege mindestens zwei an.</p>';

  // Unassigned players with assign dropdown
  const un = s.unassigned || [];
  $('wvUnassignedCount').textContent = un.length;
  $('wvUnassignedEmpty').style.display = un.length ? 'none' : 'block';
  $('wvUnassigned').innerHTML = un
    .map((p) => {
      const opts = teams
        .map((t) => `<button class="btn sm" data-assign="${p.id}" data-team="${t.id}">→ ${escapeHtml(t.name)}</button>`)
        .join('');
      return `<div class="wv-unassigned-row">
        <span class="wv-member">${escapeHtml(p.name)}</span>
        <div class="wv-assign-opts">${opts || '<span class="hint">Erst ein Team anlegen</span>'}</div>
      </div>`;
    })
    .join('');

  // Wire buttons
  list.querySelectorAll('[data-delteam]').forEach((b) =>
    b.addEventListener('click', () => waveAction('wave:removeTeam', { teamId: b.dataset.delteam }))
  );
  list.querySelectorAll('[data-unassign]').forEach((b) =>
    b.addEventListener('click', () => waveAction('wave:assignPlayer', { playerId: b.dataset.unassign, teamId: null }))
  );
  $('wvUnassigned')
    .querySelectorAll('[data-assign]')
    .forEach((b) =>
      b.addEventListener('click', () =>
        waveAction('wave:assignPlayer', { playerId: b.dataset.assign, teamId: b.dataset.team })
      )
    );

  const fullCount = teams.filter((t) => t.full).length;
  $('wvStartBtn').disabled = !s.canStart;
  $('wvLobbyHint').textContent = s.canStart
    ? `${fullCount} spielfähige Teams – bereit zum Start.`
    : 'Mindestens 2 Teams mit je mindestens 2 Spielern nötig.';
}

function renderWaveTurn(s) {
  const t = s.turn || {};
  $('wvTurnTeam').textContent = t.teamName || '–';
  $('wvTurnPhase').textContent = WV_PHASE_LABELS[s.phase] || s.phase;
  $('wvClueGiver').textContent = t.clueGiverName || '–';
  $('wvGuesser').textContent = t.guesserName || '–';
  $('wvTarget').textContent = t.target != null ? t.target : '–';

  // Hinweis-Box (ab guess-Phase, solange nicht aufgedeckt)
  const showClue = t.clue != null && !t.revealed;
  $('wvClueBox').classList.toggle('hidden', !showClue);
  if (showClue && document.activeElement !== $('wvClueEdit')) $('wvClueEdit').value = t.clue;

  // Tipp
  const showGuess = t.guess != null;
  $('wvGuessBox').classList.toggle('hidden', !showGuess);
  if (showGuess) $('wvGuessVal').textContent = t.guess;

  // Auflösung
  const rev = $('wvRevealText');
  if (t.revealed) {
    rev.classList.remove('hidden');
    const pts = t.points === 3 ? '3 Punkte 🎯' : t.points === 1 ? '1 Punkt' : '0 Punkte';
    rev.innerHTML = `Zielzahl <b>${t.target}</b> · Tipp <b>${t.guess}</b> · Abstand <b>${t.distance}</b> → <b>${pts}</b>`;
  } else {
    rev.classList.add('hidden');
  }

  // Buttons je Phase (zweistufige Auflösung)
  const inReveal = s.phase === 'reveal';
  $('wvShowGuessBtn').classList.toggle('hidden', !(inReveal && !t.guessShown));
  $('wvRevealBtn').classList.toggle('hidden', !(inReveal && t.guessShown && !t.revealed));
  $('wvNextTurnBtn').classList.toggle('hidden', !(inReveal && t.revealed));
}

function renderWaveStandings(s) {
  const st = s.standings || [];
  $('wvStandings').innerHTML = st.length
    ? st
        .map(
          (t) =>
            `<div class="wv-standing-row ${t.isCurrent ? 'current' : ''}">
              <span>${escapeHtml(t.name)}</span><b>${t.score}</b>
            </div>`
        )
        .join('')
    : '<span class="hint">Noch keine Teams.</span>';
}

// ============================================================ QUIZ-DUELL
const JP_PHASE_LABELS = { lobby: 'Lobby', board: 'Board', question: 'Frage', finished: 'Beendet' };

function jpAction(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
}

// ---- Buttons verdrahten
$('jaAddTeamBtn').addEventListener('click', () => {
  const name = $('jaTeamName').value.trim();
  jpAction('jeopardy:addTeam', { name });
  $('jaTeamName').value = '';
});
$('jaMultiplier').addEventListener('change', () =>
  jpAction('jeopardy:setBoardMultiplier', { multiplier: parseInt($('jaMultiplier').value, 10) || 2 })
);
$('jaTimer').addEventListener('change', () =>
  jpAction('jeopardy:setTimerSeconds', { seconds: parseInt($('jaTimer').value, 10) || 30 })
);
$('jaStartBtn').addEventListener('click', () => jpAction('jeopardy:startGame'));
$('jaConfirmSelBtn').addEventListener('click', () => jpAction('jeopardy:confirmSelection'));
$('jaCancelSelBtn').addEventListener('click', () => jpAction('jeopardy:cancelSelection'));
$('jaTimerStart').addEventListener('click', () => jpAction('jeopardy:startTimer'));
$('jaTimerStop').addEventListener('click', () => jpAction('jeopardy:stopTimer'));
$('jaTimerReset').addEventListener('click', () => jpAction('jeopardy:resetTimer'));
$('jaCorrectBtn').addEventListener('click', () => jpAction('jeopardy:judge', { correct: true }));
$('jaWrongBtn').addEventListener('click', () => jpAction('jeopardy:judge', { correct: false }));
$('jaOpenStealBtn').addEventListener('click', () => jpAction('jeopardy:openSteal'));
$('jaCloseQBtn').addEventListener('click', () => jpAction('jeopardy:closeQuestion'));
$('jaMediaPlayBtn').addEventListener('click', () => jpAction('jeopardy:mediaPlay'));
$('jaMediaPauseBtn').addEventListener('click', () => jpAction('jeopardy:mediaPause'));
$('jaMediaRestartBtn').addEventListener('click', () => jpAction('jeopardy:mediaRestart'));
$('jaClearEffectsBtn').addEventListener('click', () => jpAction('jeopardy:clearJokerEffects'));
$('jaBackLobbyBtn').addEventListener('click', () => jpAction('jeopardy:backToLobby'));
$('jaEndGameBtn').addEventListener('click', () => {
  if (confirm('Spiel wirklich abbrechen?')) jpAction('jeopardy:endGame');
});

const JOKER_LABELS = { noRisk: '🛡️ Kein-Risiko', allOrNothing: '🎲 Alles-oder-Nichts', coffee: '☕ Kaffeepause' };

// ---- Timer-Ticken (Admin)
let jpTimerInt = null;
function jpTickTimer() {
  if (!lastState || lastState.gameType !== 'jeopardy' || !lastState.current) return;
  const el = $('jaQuestion').querySelector('.jp-timer');
  if (!el) return;
  const rem = JeopardyUI.timerRemaining(lastState.current.timer);
  const secs = Math.ceil(rem / 1000);
  const v = el.querySelector('.jp-timer-val');
  if (v) v.textContent = secs;
  el.classList.toggle('low', secs <= 5 && secs > 0);
  el.classList.toggle('zero', secs === 0);
}

function renderJeopardyAdmin(s) {
  // Bühne (Spieler + Board/Frage + Scoreboard)
  JeopardyUI.renderSidePlayers($('jaLeft'), $('jaRight'), s, avatars);
  JeopardyUI.renderScoreboard($('jaScoreboard'), s);

  const inGame = s.phase === 'board' || s.phase === 'question';
  $('jaBoardInfo').innerHTML = inGame
    ? `<span class="jp-round">${JeopardyUI.esc(s.boardName || ('Board ' + s.round))}</span>
       <span class="badge">Board ${s.round}/${s.boardCount}</span>
       ${s.multiplierActive > 1 ? `<span class="badge wait">×${s.multiplierActive} Punkte</span>` : ''}`
    : '';

  // Board vs. Frage
  if (s.phase === 'question' && s.current) {
    hide($('jaBoard'));
    show($('jaQuestion'));
    JeopardyUI.renderQuestion($('jaQuestion'), s, { admin: true });
  } else {
    JeopardyUI.stopMedia($('jaQuestion'));
    show($('jaBoard'));
    hide($('jaQuestion'));
    if (s.board) JeopardyUI.renderBoard($('jaBoard'), s, { clickable: false });
    else $('jaBoard').innerHTML = '';
  }

  // Panels umschalten
  ['jaLobby', 'jaGame', 'jaFinished'].forEach((id) => hide($(id)));
  hide($('jaEndRow'));

  if (s.phase === 'lobby') {
    show($('jaLobby'));
    $('jaMultiplier').value = s.boardMultiplier;
    $('jaTimer').value = s.timerSeconds;
    renderJpLobby(s);
    return;
  }
  if (s.phase === 'finished') {
    show($('jaFinished'));
    $('jaWinnerText').textContent = s.winnerTeamName ? '🏆 ' + s.winnerTeamName + ' gewinnt!' : '🏁 Spiel beendet';
    $('jaStats').innerHTML = (s.standings || [])
      .map(
        (t) =>
          `<div class="jp-stat-row" style="--tc:${t.color}"><span class="jp-score-dot" style="background:${t.color}"></span>
           <span>${escapeHtml(t.name)}</span><b>${t.score} Pkt</b><small>${t.answered} richtig</small></div>`
      )
      .join('');
    return;
  }

  // board / question
  show($('jaGame'));
  show($('jaEndRow'));
  renderJpGame(s);
}

function renderJpLobby(s) {
  const teams = s.teams || [];
  $('jaTeamList').innerHTML = teams
    .map((t) => {
      const members = t.players
        .map(
          (p) =>
            `<span class="jp-chip">${escapeHtml(p.name)}<button class="wv-x" data-unassign="${p.id}" title="Aus Team nehmen">✕</button></span>`
        )
        .join('');
      return `<div class="jp-team-row" style="--tc:${t.color}">
        <div class="jp-team-row-head">
          <span class="jp-color-dot" style="background:${t.color}"></span>
          <b>${escapeHtml(t.name)}</b>
          <button class="wv-team-del" data-delteam="${t.id}" title="Team entfernen">🗑️</button>
        </div>
        <div class="jp-team-row-members">${members || '<span class="hint">keine Spieler</span>'}</div>
      </div>`;
    })
    .join('');
  if (!teams.length) $('jaTeamList').innerHTML = '<p class="hint">Noch keine Teams. Lege mindestens zwei an.</p>';

  const un = s.unassigned || [];
  $('jaUnassignedCount').textContent = un.length;
  $('jaUnassigned').innerHTML = un
    .map((p) => {
      const opts = teams
        .map((t) => `<button class="btn sm" data-assign="${p.id}" data-team="${t.id}" style="border-color:${t.color}">→ ${escapeHtml(t.name)}</button>`)
        .join('');
      return `<div class="wv-unassigned-row"><span class="wv-member">${escapeHtml(p.name)}</span>
        <div class="wv-assign-opts">${opts || '<span class="hint">Erst ein Team anlegen</span>'}</div></div>`;
    })
    .join('');

  $('jaTeamList').querySelectorAll('[data-delteam]').forEach((b) =>
    b.addEventListener('click', () => jpAction('jeopardy:removeTeam', { teamId: b.dataset.delteam }))
  );
  $('jaTeamList').querySelectorAll('[data-unassign]').forEach((b) =>
    b.addEventListener('click', () => jpAction('jeopardy:assignPlayer', { playerId: b.dataset.unassign, teamId: null }))
  );
  $('jaUnassigned').querySelectorAll('[data-assign]').forEach((b) =>
    b.addEventListener('click', () => jpAction('jeopardy:assignPlayer', { playerId: b.dataset.assign, teamId: b.dataset.team }))
  );

  $('jaStartBtn').disabled = !s.canStart;
  $('jaLobbyHint').textContent = s.canStart ? 'Bereit zum Start.' : 'Mindestens 2 Teams mit je einem Spieler nötig.';
}

function renderJpGame(s) {
  // Auswahl-Bestätigung
  const ps = s.pendingSelection;
  $('jaPending').classList.toggle('hidden', !ps);
  if (ps) {
    const cat = s.board?.categories?.[ps.ci];
    const q = cat?.questions?.[ps.qi];
    $('jaPendingText').innerHTML = `<b>${escapeHtml(ps.teamName || '')}</b> wählt <b>${escapeHtml(cat?.name || '')}</b> für <b>${q ? q.value : ''}</b> Punkte.`;
  }

  // Frage-Steuerung
  const q = s.phase === 'question' && s.current;
  $('jaQControls').classList.toggle('hidden', !q);
  if (q) {
    $('jaAnswerBox').innerHTML = `✅ Lösung: <b>${escapeHtml(s.current.answer || '–')}</b>`;
    const canJudge = ['answering', 'stealAnswering'].includes(s.current.stage);
    $('jaCorrectBtn').disabled = !canJudge;
    $('jaWrongBtn').disabled = !canJudge;
    // Medien-Steuerung (nur bei Audio/Video)
    const m = s.current.media;
    const playable = m && (m.type === 'audio' || m.type === 'video');
    $('jaMediaControls').classList.toggle('hidden', !playable);
    if (playable) {
      $('jaMediaState').textContent = s.current.mediaPlaying ? '▶️ läuft' : '⏸️ pausiert';
    }
  }

  // Turn-Info (Board-Phase ohne Auswahl)
  const idle = s.phase === 'board' && !ps;
  $('jaTurnInfo').classList.toggle('hidden', !idle);
  if (idle) {
    const at = (s.teams || []).find((t) => t.id === s.activeTeamId);
    $('jaTurnInfo').innerHTML = at
      ? `<span class="jp-color-dot" style="background:${at.color}"></span> <b>${escapeHtml(at.name)}</b> ist am Zug und wählt eine Frage.`
      : '';
  }

  // Joker-Anträge
  const reqs = s.pendingJokers || [];
  $('jaJokerReqs').innerHTML = reqs.length
    ? '<h4 class="section-label">Joker-Anträge</h4>' +
      reqs
        .map(
          (r) => `<div class="jp-joker-req">
        <span>${escapeHtml(r.teamName)}: ${JOKER_LABELS[r.type] || r.type}${r.targetTeamName ? ' → ' + escapeHtml(r.targetTeamName) : ''}</span>
        <span class="btn-row">
          <button class="btn sm accent" data-jok-ok="${r.id}">✔️</button>
          <button class="btn sm" data-jok-no="${r.id}">✕</button>
        </span>
      </div>`
        )
        .join('')
    : '';
  $('jaJokerReqs').querySelectorAll('[data-jok-ok]').forEach((b) =>
    b.addEventListener('click', () => jpAction('jeopardy:confirmJoker', { reqId: b.dataset.jokOk }))
  );
  $('jaJokerReqs').querySelectorAll('[data-jok-no]').forEach((b) =>
    b.addEventListener('click', () => jpAction('jeopardy:rejectJoker', { reqId: b.dataset.jokNo }))
  );

  // Joker-Verwaltung
  $('jaJokerAdmin').innerHTML = (s.teams || [])
    .map((t) => {
      const cells = ['noRisk', 'allOrNothing', 'coffee']
        .map(
          (type) => `<span class="jp-jok-adjust">${JOKER_LABELS[type].slice(0, 2)}
            <button class="btn sm" data-adj="${t.id}" data-type="${type}" data-d="-1">−</button>
            <b>${t.jokers[type] || 0}</b>
            <button class="btn sm" data-adj="${t.id}" data-type="${type}" data-d="1">+</button></span>`
        )
        .join('');
      return `<div class="jp-jok-team"><span class="jp-color-dot" style="background:${t.color}"></span><b>${escapeHtml(t.name)}</b><div class="jp-jok-cells">${cells}</div></div>`;
    })
    .join('');
  $('jaJokerAdmin').querySelectorAll('[data-adj]').forEach((b) =>
    b.addEventListener('click', () =>
      jpAction('jeopardy:adjustJoker', { teamId: b.dataset.adj, type: b.dataset.type, delta: parseInt(b.dataset.d, 10) })
    )
  );
}

// ---------------------------------------------------------- Socket
socket.on('avatars', (map) => {
  avatars = map || {};
  if (currentGameType === 'hearts') {
    if (lastState) renderHeartsAdmin(lastState);
  } else if (currentGameType === 'wave') {
    if (lastState) renderWaveAdmin(lastState);
  } else if (currentGameType === 'jeopardy') {
    if (lastState) renderJeopardyAdmin(lastState);
  } else {
    renderAvatarBar();
  }
});
if (!jpTimerInt) jpTimerInt = setInterval(jpTickTimer, 250);
socket.on('state', render);

function reconnectAdmin() {
  if (!state.code || !state.adminToken) return;
  socket.emit('admin:reconnect', { code: state.code, adminToken: state.adminToken }, (res) => {
    if (res.ok) {
      enterControl(res.state);
    } else {
      sessionStorage.removeItem('gm_admin_code');
      sessionStorage.removeItem('gm_admin_token');
      state.code = null;
      state.adminToken = null;
    }
  });
}
socket.on('connect', reconnectAdmin);
