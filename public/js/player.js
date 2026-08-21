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
  if (currentGameType === 'hearts') return renderHearts(s);
  show(appEl);
  hide($('heartsView'));
  hide($('heartsPopup'));
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

// Profilbild nachträglich ändern (Lobby / laufendes Spiel, beide Spiele)
$('lobbyChangePhotoBtn').addEventListener('click', () => openAvatarPicker('change'));
$('htChangePhotoBtn').addEventListener('click', () => openAvatarPicker('change'));

// Lobby / Spiel verlassen
function leaveLobby() {
  if (!confirm('Willst du das Spiel wirklich verlassen?')) return;
  socket.emit('player:leave', {}, () => resetToJoin());
}
$('lobbyLeaveBtn').addEventListener('click', leaveLobby);
$('htLeaveBtn').addEventListener('click', leaveLobby);

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
  hide($('gameView'));
  hide($('heartsView'));
  hide($('heartsPopup'));
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

  $('htRoundInfo').textContent = s.phase === 'lobby' ? 'Lobby' : 'Runde ' + s.round;
  $('htPhaseInfo').textContent = HT_PHASE[s.phase] || s.phase;
  $('htSdBadge').classList.toggle('hidden', !s.suddenDeath);
  const meCell = (s.board || []).find((c) => c.id === s.myId);
  $('htMyHearts').innerHTML = meCell ? HeartsBoard.heartsHtml(meCell.hearts, meCell.maxHearts) : '';

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

  if (s.myQuestion) {
    $('heartsPopupText').textContent = s.myQuestion;
    show($('heartsPopup'));
  } else {
    hide($('heartsPopup'));
  }

  $('heartsHint').innerHTML = heartsHintText(s);
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
  // Abstimmung zuerst, damit ausgeschiedene Zuschauer im Sudden Death voten können.
  if (s.phase === 'voting') {
    if (s.canVote) {
      if (s.myVote) {
        const name = ((s.board || []).find((c) => c.id === s.myVote) || {}).name || '';
        return `✅ Deine Wahl: <b>${GM.escapeHtml(name)}</b> — du kannst sie noch ändern, bis der Gamemaster sperrt.`;
      }
      if (s.suddenDeath) return '☠️ SUDDEN DEATH! Du entscheidest: Wähle den Spieler, der rausfliegen soll.';
      return s.isRunoff
        ? '⚖️ Stichwahl! Wähle einen der markierten Spieler.'
        : 'Wähle den Spieler, der am dümmsten war!';
    }
    if (s.suddenDeath) return '☠️ SUDDEN DEATH! Die ausgeschiedenen Spieler entscheiden jetzt über dich.';
    return s.myEliminated ? 'Du bist raus und stimmst nicht mehr ab.' : 'Warte, bis der Gamemaster auswertet …';
  }

  if (s.myEliminated && s.phase !== 'finished') return '💀 Du bist ausgeschieden – schau weiter zu!';

  switch (s.phase) {
    case 'lobby':
      return 'Warte, bis der Gamemaster das Spiel startet …';
    case 'question':
      if (s.suddenDeath) {
        return s.myQuestion
          ? '☠️ SUDDEN DEATH! Beantworte deine Frage laut!'
          : '☠️ SUDDEN DEATH – nur noch ihr zwei! Beantwortet eure Fragen.';
      }
      return s.myQuestion
        ? 'Du bist dran – beantworte deine Frage laut!'
        : 'Der Gamemaster stellt Fragen. Pass auf, wann du dran bist!';
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

function heartsResultText(s) {
  if (!s.lastResult) return 'Runde vorbei.';
  const name = ((s.board || []).find((c) => c.id === s.lastResult.loserId) || {}).name || '';
  let t = '💔 ' + name + ' verliert ein Herz.';
  if (s.lastResult.eliminatedId) t += ' Ausgeschieden!';
  return t;
}

// ------------------------------------------------------------- Socket
socket.on('avatars', (map) => {
  if (!state.playerId) return; // nach Verlassen/Rauswurf ignorieren
  avatars = map || {};
  if (currentGameType === 'hearts') {
    if (lastState) renderHearts(lastState);
  } else {
    renderAvatarBar();
  }
});
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
