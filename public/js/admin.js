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
    case 'voting':
      show($('phaseVoting'));
      $('adminQuestionV').textContent = s.question;
      $('correctAnswerV').textContent = s.correctAnswer;
      $('votedCount').textContent = s.votedCount ?? 0;
      $('votedTotal').textContent = s.connectedCount ?? 0;
      renderVotingAnswers(s);
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

// ---- Abstimmungs-Phase: Antworten mit Autor + Live-Stimmen ----------
function renderVotingAnswers(s) {
  const el = $('adminVotingAnswers');
  el.innerHTML = (s.answers || [])
    .map((a) => {
      const author = a.isTruth
        ? '<div class="av-circle truth-circle">✅</div>'
        : GM.avatarCircle(brief(a.authorId, a.authorName).name, brief(a.authorId, a.authorName).avatar);
      return `<div class="rev-row ${a.isTruth ? 'truth' : ''}">
        <div class="rev-left">${author}</div>
        <div class="rev-mid"><div class="rev-text">${escapeHtml(a.text)}</div>
          <span class="rev-author-name">${a.isTruth ? 'Richtige Antwort' : GM.escapeHtml(brief(a.authorId, a.authorName).name)}</span></div>
        <div class="rev-right">${voterCircles(a)}</div>
      </div>`;
    })
    .join('');
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

// ---------------------------------------------------------- Socket
socket.on('avatars', (map) => {
  avatars = map || {};
  renderAvatarBar();
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
