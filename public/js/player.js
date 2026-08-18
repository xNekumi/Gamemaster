/* global io */
const socket = io();

const state = {
  playerId: null,
  token: localStorage.getItem('gm_token') || null,
  code: null,
  name: null,
  selectedAnswerId: null,
};

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
function render(s) {
  if (!s) return;
  if (s.code) $('roomPillCode').textContent = s.code;
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
  const locked = s.hasVoted;
  el.innerHTML = '';

  (s.answers || []).forEach((a) => {
    const div = document.createElement('div');
    div.className = 'answer';
    if (a.isOwn) div.classList.add('own');
    if (locked) div.classList.add('disabled');
    if (s.myVote === a.id) div.classList.add('selected');

    div.innerHTML = `<div class="text">${escapeHtml(a.text)}</div>
      <div class="meta">${a.isOwn ? '<span class="tag author">Deine Antwort</span>' : ''}
      ${s.myVote === a.id ? '<span class="tag">✓ Deine Stimme</span>' : ''}</div>`;

    if (!a.isOwn && !locked) {
      div.addEventListener('click', () => castVote(a.id, div));
    }
    el.appendChild(div);
  });

  if (locked) {
    show($('voteWaiting'));
    hide($('voteHint'));
  } else {
    hide($('voteWaiting'));
    show($('voteHint'));
  }
}

function castVote(answerId, div) {
  document.querySelectorAll('#voteAnswers .answer').forEach((d) => d.classList.remove('selected'));
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
  const el = $('revealAnswers');
  el.innerHTML = '';
  (s.answers || []).forEach((a) => {
    const div = document.createElement('div');
    div.className = 'answer disabled reveal-answer';
    if (a.isOwn) div.classList.add('own');
    if (a.revealed && a.isTruth) div.classList.add('truth');

    // Kopfzeile: Autor / richtige Antwort
    let head = '';
    if (!a.revealed) {
      head = '<span class="tag">🔒 noch verdeckt</span>';
    } else if (a.isTruth) {
      head = '<span class="tag truth">✅ Das ist die richtige Antwort!</span>';
    } else {
      head = `<span class="reveal-author">✍️ Geschrieben von <b>${escapeHtml(a.authorName)}</b></span>`;
    }

    // Wähler-Zeile
    let votersBlock = '';
    if (a.revealed) {
      const voters = a.voters || [];
      if (voters.length) {
        votersBlock = `<div class="reveal-voters">
          <span class="reveal-voters-label">🗳️ Dafür gestimmt (${voters.length}):</span>
          <div class="voters">${voters.map((v) => `<span class="voter">${escapeHtml(v)}</span>`).join('')}</div>
        </div>`;
      } else {
        votersBlock = '<div class="reveal-voters"><span class="reveal-voters-label dim">🗳️ Niemand hat dafür gestimmt</span></div>';
      }
    }

    const ownTag = a.isOwn ? '<span class="tag author">Deine Antwort</span>' : '';

    div.innerHTML = `
      <div class="text">${escapeHtml(a.text)}</div>
      <div class="reveal-meta">
        <div class="reveal-head">${head} ${ownTag}</div>
        ${votersBlock}
      </div>`;
    el.appendChild(div);
  });
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

// ------------------------------------------------------------- Socket
socket.on('state', render);
socket.on('connect', () => {
  // Bei Reconnect erneut anmelden
  if (state.token && state.code) {
    attemptJoin(null, state.code, state.token);
  }
});
