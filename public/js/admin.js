/* global io */
const socket = io();

const state = {
  code: localStorage.getItem('gm_admin_code') || null,
  adminToken: localStorage.getItem('gm_admin_token') || null,
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
const GAME_NAMES = { bluff: 'Bluff-Quiz', hearts: 'Der dümmste fliegt' };

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
    localStorage.setItem('gm_admin_code', res.code);
    localStorage.setItem('gm_admin_token', res.adminToken);
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
  if (currentGameType === 'hearts') {
    hide($('bluffControl'));
    hide($('avatarBar'));
    show($('heartsControl'));
    $('statPhase').textContent = HT_PHASE_LABELS[s.phase] || s.phase;
    renderHeartsAdmin(s);
  } else {
    show($('bluffControl'));
    hide($('heartsControl'));
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

  ['htLobby', 'htQuestion', 'htVoting', 'htReveal', 'htRoundEnd', 'htFinished'].forEach((id) => hide($(id)));
  hide($('htEndRow'));

  switch (s.phase) {
    case 'lobby':
      show($('htLobby'));
      $('htStartGameBtn').disabled = (s.board || []).length < 2;
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
    case 'roundEnd':
      show($('htRoundEnd'));
      show($('htEndRow'));
      $('htResultText').innerHTML = heartsAdminResult(s);
      break;
    case 'finished':
      show($('htFinished'));
      $('htWinnerText').textContent = s.winnerName ? '🏆 ' + s.winnerName + ' gewinnt!' : '🏁 Spiel beendet';
      break;
  }
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
          return `<div class="ht-answer-row" data-id="${a.id}">
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

// ---------------------------------------------------------- Socket
socket.on('avatars', (map) => {
  avatars = map || {};
  if (currentGameType === 'hearts') {
    if (lastState) renderHeartsAdmin(lastState);
  } else {
    renderAvatarBar();
  }
});
socket.on('state', render);

function reconnectAdmin() {
  if (!state.code || !state.adminToken) return;
  socket.emit('admin:reconnect', { code: state.code, adminToken: state.adminToken }, (res) => {
    if (res.ok) {
      enterControl(res.state);
    } else {
      localStorage.removeItem('gm_admin_code');
      localStorage.removeItem('gm_admin_token');
      state.code = null;
      state.adminToken = null;
    }
  });
}
socket.on('connect', reconnectAdmin);
