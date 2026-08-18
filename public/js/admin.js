/* global io */
const socket = io();

const state = {
  code: localStorage.getItem('gm_admin_code') || null,
  adminToken: localStorage.getItem('gm_admin_token') || null,
};

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

// ---------------------------------------------------------- Login
$('createBtn').addEventListener('click', () => {
  const password = $('pwInput').value;
  hide($('loginError'));
  $('createBtn').disabled = true;
  socket.emit('admin:createGame', { password }, (res) => {
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
    toast('Kopieren nicht möglich – Link manuell markieren.', true);
  }
});

// ---------------------------------------------------------- Aktionen
function emitAction(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (res && !res.ok) toast(res.error, true);
  });
}
$('startBtn').addEventListener('click', () => emitAction('admin:startRound'));
$('forceVotingBtn').addEventListener('click', () => emitAction('admin:forceVoting'));
$('showResultsBtn').addEventListener('click', () => emitAction('admin:showResults'));
$('revealAllBtn').addEventListener('click', () => emitAction('admin:revealAll'));
$('nextQuestionBtn').addEventListener('click', () => emitAction('admin:nextQuestion'));
$('endGameBtn').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden und Endstand anzeigen?')) emitAction('admin:endGame');
});
$('restartBtn').addEventListener('click', () => emitAction('admin:backToLobby'));

// ---------------------------------------------------------- Rendern
function render(s) {
  if (!s) return;
  $('roomPillCode').textContent = s.code;
  $('bigCode').textContent = s.code;
  $('statPlayers').textContent = s.playerCount ?? (s.scoreboard || []).length;
  $('statRound').textContent = s.round;
  $('statPhase').textContent = PHASE_LABELS[s.phase] || s.phase;

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
      break;
    case 'voting':
      show($('phaseVoting'));
      $('adminQuestionV').textContent = s.question;
      $('correctAnswerV').textContent = s.correctAnswer;
      $('votedCount').textContent = s.votedCount ?? 0;
      $('votedTotal').textContent = s.connectedCount ?? 0;
      break;
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

function renderAdminPlayers(s) {
  const players = s.answerStatus || s.scoreboard || [];
  const badge = $('playerCountBadge');
  badge.textContent = `${players.length}`;
  const el = $('adminPlayers');
  el.innerHTML = players
    .map((p) => {
      let status = '';
      if (s.phase === 'answering') status = p.answered ? ' ✅' : ' …';
      else if (s.phase === 'voting') status = p.voted ? ' 🗳️' : ' …';
      return `<span class="chip ${p.connected === false ? 'off' : ''}">
        <span class="dot"></span>${escapeHtml(p.name)}${status}
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

function renderAdminReveal(s) {
  const el = $('adminRevealAnswers');
  el.innerHTML = '';
  (s.answers || []).forEach((a) => {
    const div = document.createElement('div');
    div.className = 'answer';
    if (a.revealed && a.isTruth) div.classList.add('truth');
    if (!a.revealed) div.classList.add('pulse');

    let meta = '';
    if (a.revealed) {
      if (a.isTruth) meta += '<span class="tag truth">✅ Richtige Antwort</span>';
      else meta += `<span class="tag author">von ${escapeHtml(a.authorName)}</span>`;
      const voters = (a.voters || [])
        .map((v) => `<span class="voter">${escapeHtml(v)}</span>`)
        .join('');
      meta += voters
        ? `<div class="voters">${voters}</div>`
        : '<span class="tag">keine Stimmen</span>';
    } else {
      meta += `<span class="tag">${a.voteCount} Stimme(n) · klicken zum Aufdecken</span>`;
    }

    div.innerHTML = `<div class="text">${escapeHtml(a.text)}</div><div class="meta">${meta}</div>`;
    if (!a.revealed) {
      div.addEventListener('click', () => emitAction('admin:revealAnswer', { answerId: a.id }));
    }
    el.appendChild(div);
  });
}

function renderAdminScoreboard(s) {
  const list = s.scoreboard || [];
  $('adminScoreboard').innerHTML = list.length
    ? list
        .map(
          (p, i) => `
      <div class="score-row ${i === 0 && p.score > 0 ? 'top1' : ''}">
        <div class="rank">${i === 0 && p.score > 0 ? '👑' : i + 1}</div>
        <div class="name">${escapeHtml(p.name)}${p.connected === false ? ' <span class="badge off">offline</span>' : ''}</div>
        <div class="pts">${p.score}</div>
      </div>`
        )
        .join('')
    : '<p class="hint">Noch keine Spieler.</p>';
}

// ---------------------------------------------------------- Socket
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
