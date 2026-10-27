import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GameManager } from './gameManager.js';
import { HeartsGame } from './heartsGame.js';
import { WaveGame } from './waveGame.js';
import { JeopardyGame } from './jeopardyGame.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT = process.env.PORT || 3000;
// Passwort, um eine neue Spielrunde zu erstellen (schützt die öffentliche Instanz).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gamemaster';

// ---------------------------------------------------------- Daten laden
async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

const questions = await loadJson(
  process.env.QUESTIONS_FILE || join(ROOT, 'data', 'questions.json')
);
const config = await loadJson(join(ROOT, 'config', 'config.json'));
const heartsQuestions = await loadJson(
  process.env.HEARTS_QUESTIONS_FILE || join(ROOT, 'data', 'questions-hearts.json'),
  []
);
const waveCategories = await loadJson(
  process.env.WAVE_CATEGORIES_FILE || join(ROOT, 'data', 'questions-wave.json'),
  []
);
const jeopardyData = await loadJson(
  process.env.JEOPARDY_FILE || join(ROOT, 'data', 'questions-jeopardy.json'),
  { boards: [] }
);

if (!Array.isArray(questions) || questions.length === 0) {
  console.error('Keine Fragen gefunden. Bitte data/questions.json prüfen.');
  process.exit(1);
}

const hearts = new HeartsGame({ questions: heartsQuestions, config });
const wave = new WaveGame({ categories: waveCategories, config });
const jeopardy = new JeopardyGame({ data: jeopardyData, config });
const gm = new GameManager({ questions, config, hearts, wave, jeopardy });

// -------------------------------------------------------------- Express
const app = express();
app.use(express.static(join(ROOT, 'public')));
app.get('/admin', (_req, res) => res.sendFile(join(ROOT, 'public', 'admin.html')));
// Projektor-/Zuschauer-Ansicht (IRL-Modus): gleiche Seite wie für Spieler, aber nur Anzeige.
app.get('/screen', (_req, res) => res.sendFile(join(ROOT, 'public', 'index.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: gm.rooms.size }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// -------------------------------------------------- Broadcast-Helfer
function broadcastRoom(room) {
  // Admins im Raum
  io.to(adminRoom(room.code)).emit('state', gm.buildState(room, { role: 'admin' }));
  // Projektor-/Zuschauer-Ansichten bekommen die öffentliche Sicht (keine Geheimnisse)
  io.to(displayRoom(room.code)).emit('state', gm.buildState(room, { role: 'display' }));
  // Jeder Spieler bekommt seine gefilterte Sicht
  for (const player of room.players.values()) {
    if (player.irl) continue; // IRL-Spieler haben kein Gerät
    io.to(playerSocketRoom(room.code, player.id)).emit(
      'state',
      gm.buildState(room, { role: 'player', playerId: player.id })
    );
  }
}

const adminRoom = (code) => `admin:${code}`;
const playerSocketRoom = (code, playerId) => `player:${code}:${playerId}`;
const gameRoom = (code) => `game:${code}`;
const displayRoom = (code) => `display:${code}`;

// Avatare ändern sich selten und sind vergleichsweise groß -> separat und nur
// bei Änderung an alle im Raum senden (nicht bei jedem State-Broadcast).
function broadcastAvatars(room) {
  io.to(gameRoom(room.code)).emit('avatars', gm.avatarMap(room));
}

function ok(cb, data = {}) {
  if (typeof cb === 'function') cb({ ok: true, ...data });
}
function fail(cb, error) {
  if (typeof cb === 'function') cb({ ok: false, error });
}

// ------------------------------------------------- Spieler-Aktionen
// Gemeinsame Tabelle: wird von echten Spielern (über ihren Socket) UND vom
// Moderator stellvertretend für IRL-Spieler (irl:act) genutzt – gleiche Regeln.
const PLAYER_ACTIONS = {
  'player:submitAnswer': { game: 'bluff', run: (room, pl, p) => gm.submitAnswer(room, pl, p.text) },
  'player:vote': { game: 'bluff', run: (room, pl, p) => gm.submitVote(room, pl, p.answerId) },
  'hearts:vote': {
    game: 'hearts',
    run: (room, pl, p) => gm.hearts.vote(room, pl, p.targetId),
    extra: (room) => ({ allVoted: gm.hearts.allVoted(room) }),
  },
  'hearts:estimateGuess': { game: 'hearts', run: (room, pl, p) => gm.hearts.estimateGuess(room, pl, p.value) },
  'wave:submitClue': { game: 'wave', run: (room, pl, p) => gm.wave.submitClue(room, pl, p.text) },
  'wave:submitGuess': { game: 'wave', run: (room, pl, p) => gm.wave.submitGuess(room, pl, p.value) },
  'jeopardy:renameMyTeam': { game: 'jeopardy', run: (room, pl, p) => gm.jeopardy.playerRenameTeam(room, pl, p.name) },
  'jeopardy:select': { game: 'jeopardy', run: (room, pl, p) => gm.jeopardy.selectQuestion(room, pl, p.bi, p.ci, p.qi) },
  'jeopardy:buzz': { game: 'jeopardy', run: (room, pl) => gm.jeopardy.buzz(room, pl) },
  'jeopardy:useCoffee': { game: 'jeopardy', run: (room, pl, p) => gm.jeopardy.useCoffee(room, pl, p.targetTeamId) },
  'jeopardy:useJoker': {
    game: 'jeopardy',
    run: (room, pl, p) => gm.jeopardy.requestJoker(room, pl, p.type, p.targetTeamId),
  },
};

function runPlayerAction(def, room, player, payload, cb) {
  if (room.gameType !== def.game) return fail(cb, 'Falscher Spieltyp.');
  let res;
  try {
    res = def.run(room, player, payload || {});
  } catch (err) {
    return fail(cb, err.message || 'Aktion fehlgeschlagen.');
  }
  if (res && res.ok === false) return fail(cb, res.error);
  broadcastRoom(room);
  ok(cb, def.extra ? def.extra(room) : {});
}

// ---------------------------------------------------------- Socket.IO
io.on('connection', (socket) => {
  // socket.data: { role, code, adminToken?, playerId?, playerToken? }

  // ---- Admin erstellt Spiel
  socket.on('admin:createGame', ({ password, gameType, irl } = {}, cb) => {
    if (password !== ADMIN_PASSWORD) return fail(cb, 'Falsches Admin-Passwort.');
    const room = gm.createRoom(gameType, { irl: !!irl });
    joinAdmin(socket, room);
    ok(cb, {
      code: room.code,
      adminToken: room.adminToken,
      gameType: room.gameType,
      state: gm.buildState(room, { role: 'admin' }),
    });
  });

  // ---- Admin verbindet sich neu
  socket.on('admin:reconnect', ({ code, adminToken } = {}, cb) => {
    const room = gm.getRoom(code);
    if (!room || room.adminToken !== adminToken) return fail(cb, 'Sitzung ungültig.');
    joinAdmin(socket, room);
    ok(cb, { code: room.code, state: gm.buildState(room, { role: 'admin' }) });
  });

  function joinAdmin(sock, room) {
    sock.data = { role: 'admin', code: room.code, adminToken: room.adminToken };
    sock.join(adminRoom(room.code));
    sock.join(gameRoom(room.code));
    sock.emit('state', gm.buildState(room, { role: 'admin' }));
    sock.emit('avatars', gm.avatarMap(room));
  }

  function requireAdmin(cb) {
    if (socket.data?.role !== 'admin') {
      fail(cb, 'Keine Admin-Berechtigung.');
      return null;
    }
    const room = gm.getRoom(socket.data.code);
    if (!room || room.adminToken !== socket.data.adminToken) {
      fail(cb, 'Sitzung ungültig.');
      return null;
    }
    return room;
  }

  // ---- Admin-Aktionen
  const adminActions = {
    'admin:startRound': (room) => {
      if (room.players.size === 0) throw new Error('Es sind noch keine Spieler beigetreten.');
      gm.startRound(room);
    },
    'admin:startVoting': (room) => gm.beginVoting(room),
    'admin:showAnswer': (room, { answerId }) => gm.showAnswer(room, answerId),
    'admin:showAllAnswers': (room) => gm.showAllAnswers(room),
    'admin:openVoting': (room) => gm.openVoting(room),
    'admin:editAnswer': (room, { answerId, text }) => {
      const res = gm.editAnswer(room, answerId, text);
      if (!res.ok) throw new Error(res.error);
    },
    'admin:showResults': (room) => gm.showResults(room),
    'admin:revealAnswer': (room, { answerId }) => gm.revealAnswer(room, answerId),
    'admin:revealAll': (room) => gm.revealAllAnswers(room),
    'admin:nextQuestion': (room) => gm.nextQuestion(room),
    'admin:endGame': (room) => gm.endGame(room),
    'admin:backToLobby': (room) => gm.backToLobby(room),
    // IRL-Modus: Punkte direkt vergeben (z. B. nach Handzeichen)
    'bluff:adjustScore': (room, p) => gm.adjustPlayerScore(room, p.playerId, p.delta),
  };

  for (const [event, handler] of Object.entries(adminActions)) {
    socket.on(event, (payload = {}, cb) => {
      const room = requireAdmin(cb);
      if (!room) return;
      try {
        handler(room, payload);
        broadcastRoom(room);
        ok(cb);
      } catch (err) {
        fail(cb, err.message || 'Aktion fehlgeschlagen.');
      }
    });
  }

  // ---- Admin-Aktionen für "Der dümmste fliegt"
  const heartsAdminActions = {
    'hearts:startGame': (room) => gm.hearts.startGame(room),
    'hearts:setActive': (room, p) => gm.hearts.setActive(room, p.playerId),
    'hearts:nextActive': (room) => gm.hearts.nextActive(room),
    'hearts:askQuestion': (room, p) => gm.hearts.askQuestion(room, p),
    'hearts:clearQuestion': (room) => gm.hearts.clearQuestion(room),
    'hearts:submitAnswer': (room, p) => gm.hearts.submitAnswer(room, p),
    'hearts:setCorrect': (room, p) => gm.hearts.setCorrect(room, p.answerId, p.correct),
    'hearts:editAnswer': (room, p) => gm.hearts.editAnswer(room, p.answerId, p.text),
    'hearts:removeAnswer': (room, p) => gm.hearts.removeAnswer(room, p.answerId),
    'hearts:continueQuestions': (room) => gm.hearts.continueQuestions(room),
    'hearts:startVoting': (room) => gm.hearts.startVoting(room),
    'hearts:goToReveal': (room) => gm.hearts.goToReveal(room),
    'hearts:revealVote': (room, p) => gm.hearts.revealVote(room, p.voterId),
    'hearts:revealAllVotes': (room) => gm.hearts.revealAllVotes(room),
    'hearts:confirmResult': (room) => gm.hearts.confirmResult(room),
    'hearts:skipRound': (room) => gm.hearts.skipRound(room),
    'hearts:closeVoting': (room) => gm.hearts.closeVoting(room),
    'hearts:removeLife': (room, p) => gm.hearts.removeLife(room, p.playerId),
    'hearts:irlDecide': (room, p) => gm.hearts.decideLoser(room, p.playerId),
    'hearts:finaleAnswer': (room, p) => gm.hearts.finaleAnswer(room, p.correct),
    'hearts:finaleRevealNext': (room) => gm.hearts.finaleRevealNext(room),
    'hearts:finaleTiebreak': (room) => gm.hearts.finaleTiebreak(room),
    'hearts:finaleFinish': (room) => gm.hearts.finaleFinish(room),
    // Timer
    'hearts:setTimerSeconds': (room, p) => gm.hearts.setTimerSeconds(room, p.seconds),
    'hearts:setTimerAutoStart': (room, p) => gm.hearts.setTimerAutoStart(room, p.on),
    'hearts:startTimer': (room) => gm.hearts.startTimer(room),
    'hearts:stopTimer': (room) => gm.hearts.stopTimer(room),
    'hearts:resetTimer': (room) => gm.hearts.resetTimer(room),
    // Schätzfrage
    'hearts:setEstimateQuestion': (room, p) => gm.hearts.setEstimateQuestion(room, p),
    'hearts:revealEstimate': (room) => gm.hearts.revealEstimate(room),
    'hearts:confirmEstimate': (room) => gm.hearts.confirmEstimate(room),
    'hearts:nextRound': (room) => gm.hearts.nextRound(room),
    'hearts:endGame': (room) => gm.hearts.endGame(room),
    'hearts:backToLobby': (room) => gm.hearts.backToLobby(room),
  };

  for (const [event, handler] of Object.entries(heartsAdminActions)) {
    socket.on(event, (payload = {}, cb) => {
      const room = requireAdmin(cb);
      if (!room) return;
      if (room.gameType !== 'hearts') return fail(cb, 'Diese Aktion gilt nur für „Der dümmste fliegt".');
      try {
        handler(room, payload);
        broadcastRoom(room);
        ok(cb);
      } catch (err) {
        fail(cb, err.message || 'Aktion fehlgeschlagen.');
      }
    });
  }

  // ---- Admin-Aktionen für "Wellenlänge"
  const waveAdminActions = {
    'wave:addTeam': (room) => gm.wave.addTeam(room),
    'wave:removeTeam': (room, p) => gm.wave.removeTeam(room, p.teamId),
    'wave:renameTeam': (room, p) => gm.wave.renameTeam(room, p.teamId, p.name),
    'wave:assignPlayer': (room, p) => gm.wave.assignPlayer(room, p.playerId, p.teamId ?? null),
    'wave:setPointsToWin': (room, p) => gm.wave.setPointsToWin(room, p.points),
    'wave:startGame': (room) => gm.wave.startGame(room),
    'wave:editClue': (room, p) => gm.wave.editClue(room, p.text),
    'wave:showGuess': (room) => gm.wave.showGuess(room),
    'wave:irlClue': (room, p) => gm.wave.irlClue(room, p.text),
    'wave:irlGuess': (room, p) => gm.wave.irlGuess(room, p.value),
    'wave:revealResult': (room) => gm.wave.revealResult(room),
    'wave:nextTurn': (room) => gm.wave.nextTurn(room),
    'wave:skipTurn': (room) => gm.wave.skipTurn(room),
    'wave:endGame': (room) => gm.wave.endGame(room),
    'wave:backToLobby': (room) => gm.wave.backToLobby(room),
  };

  for (const [event, handler] of Object.entries(waveAdminActions)) {
    socket.on(event, (payload = {}, cb) => {
      const room = requireAdmin(cb);
      if (!room) return;
      if (room.gameType !== 'wave') return fail(cb, 'Diese Aktion gilt nur für „Wellenlänge".');
      try {
        handler(room, payload);
        broadcastRoom(room);
        ok(cb);
      } catch (err) {
        fail(cb, err.message || 'Aktion fehlgeschlagen.');
      }
    });
  }

  // ---- Admin-Aktionen für "Quiz-Duell" (Jeopardy)
  const jeopardyAdminActions = {
    'jeopardy:addTeam': (room, p) => gm.jeopardy.addTeam(room, p.name),
    'jeopardy:removeTeam': (room, p) => gm.jeopardy.removeTeam(room, p.teamId),
    'jeopardy:renameTeam': (room, p) => gm.jeopardy.renameTeam(room, p.teamId, p.name),
    'jeopardy:setTeamColor': (room, p) => gm.jeopardy.setTeamColor(room, p.teamId, p.color),
    'jeopardy:assignPlayer': (room, p) => gm.jeopardy.assignPlayer(room, p.playerId, p.teamId ?? null),
    'jeopardy:setBoardMultiplier': (room, p) => gm.jeopardy.setBoardMultiplier(room, p.multiplier),
    'jeopardy:setTimerSeconds': (room, p) => gm.jeopardy.setTimerSeconds(room, p.seconds),
    'jeopardy:startGame': (room) => gm.jeopardy.startGame(room),
    'jeopardy:confirmSelection': (room) => gm.jeopardy.confirmSelection(room),
    'jeopardy:cancelSelection': (room) => gm.jeopardy.cancelSelection(room),
    'jeopardy:openQuestion': (room, p) => gm.jeopardy.openQuestion(room, p.ci, p.qi),
    'jeopardy:startTimer': (room) => gm.jeopardy.startTimer(room),
    'jeopardy:stopTimer': (room) => gm.jeopardy.stopTimer(room),
    'jeopardy:resetTimer': (room) => gm.jeopardy.resetTimer(room),
    'jeopardy:mediaPlay': (room) => gm.jeopardy.mediaPlay(room),
    'jeopardy:mediaPause': (room) => gm.jeopardy.mediaPause(room),
    'jeopardy:mediaRestart': (room) => gm.jeopardy.mediaRestart(room),
    'jeopardy:openSteal': (room) => gm.jeopardy.openSteal(room),
    'jeopardy:judge': (room, p) => gm.jeopardy.judge(room, p.correct),
    'jeopardy:closeQuestion': (room) => gm.jeopardy.closeQuestion(room),
    'jeopardy:confirmJoker': (room, p) => gm.jeopardy.confirmJoker(room, p.reqId),
    'jeopardy:rejectJoker': (room, p) => gm.jeopardy.rejectJoker(room, p.reqId),
    'jeopardy:adjustJoker': (room, p) => gm.jeopardy.adjustJoker(room, p.teamId, p.type, p.delta),
    'jeopardy:adjustScore': (room, p) => gm.jeopardy.adjustScore(room, p.teamId, p.delta),
    'jeopardy:irlBuzz': (room, p) => gm.jeopardy.buzzTeam(room, p.teamId),
    'jeopardy:irlJoker': (room, p) => gm.jeopardy.applyJokerDirect(room, p.teamId, p.type, p.targetTeamId),
    'jeopardy:clearJokerEffects': (room) => gm.jeopardy.clearJokerEffects(room),
    'jeopardy:endGame': (room) => gm.jeopardy.endGame(room),
    'jeopardy:backToLobby': (room) => gm.jeopardy.backToLobby(room),
  };

  for (const [event, handler] of Object.entries(jeopardyAdminActions)) {
    socket.on(event, (payload = {}, cb) => {
      const room = requireAdmin(cb);
      if (!room) return;
      if (room.gameType !== 'jeopardy') return fail(cb, 'Diese Aktion gilt nur für „Quiz-Duell".');
      try {
        handler(room, payload);
        broadcastRoom(room);
        ok(cb);
      } catch (err) {
        fail(cb, err.message || 'Aktion fehlgeschlagen.');
      }
    });
  }

  // ---- Admin wirft einen Spieler (aus Lobby oder Spiel)
  socket.on('admin:kickPlayer', ({ playerId } = {}, cb) => {
    const room = requireAdmin(cb);
    if (!room) return;
    gm.kickPlayer(room, playerId);
    io.to(playerSocketRoom(room.code, playerId)).emit('kicked', {
      reason: 'Du wurdest vom Gamemaster entfernt.',
    });
    broadcastRoom(room);
    broadcastAvatars(room);
    ok(cb);
  });

  // ---- Spieler tritt bei / verbindet neu
  socket.on('player:join', ({ code, name, token } = {}, cb) => {
    const result = gm.joinPlayer(code, name, token);
    if (!result.ok) return fail(cb, result.error);
    const { room, player } = result;

    socket.data = {
      role: 'player',
      code: room.code,
      playerId: player.id,
      playerToken: player.token,
    };
    socket.join(playerSocketRoom(room.code, player.id));
    socket.join(gameRoom(room.code));

    ok(cb, {
      playerId: player.id,
      token: player.token,
      name: player.name,
      hasAvatar: !!player.avatar,
      gameType: room.gameType,
      state: gm.buildState(room, { role: 'player', playerId: player.id }),
    });
    socket.emit('avatars', gm.avatarMap(room));
    broadcastRoom(room);
  });

  socket.on('player:setAvatar', ({ dataUrl } = {}, cb) => {
    const ctx = requirePlayer(cb);
    if (!ctx) return;
    const res = gm.setAvatar(ctx.room, ctx.player, dataUrl);
    if (!res.ok) return fail(cb, res.error);
    broadcastAvatars(ctx.room);
    ok(cb);
  });

  function requirePlayer(cb) {
    if (socket.data?.role !== 'player') {
      fail(cb, 'Nicht als Spieler angemeldet.');
      return null;
    }
    const room = gm.getRoom(socket.data.code);
    if (!room) {
      fail(cb, 'Raum existiert nicht mehr.');
      return null;
    }
    const player = gm.getPlayerByToken(room, socket.data.playerToken);
    if (!player) {
      fail(cb, 'Du wurdest aus dem Spiel entfernt.');
      return null;
    }
    return { room, player };
  }

  // ---- Spieler verlässt die Lobby / das Spiel selbst
  socket.on('player:leave', (_payload, cb) => {
    const ctx = requirePlayer(cb);
    if (!ctx) return;
    const { room, player } = ctx;
    gm.kickPlayer(room, player.id);
    socket.leave(playerSocketRoom(room.code, player.id));
    socket.leave(gameRoom(room.code));
    socket.data = {};
    broadcastRoom(room);
    broadcastAvatars(room);
    ok(cb);
  });

  // ---- Spieler-Aktionen (alle Spiele) aus der gemeinsamen Tabelle
  for (const [event, def] of Object.entries(PLAYER_ACTIONS)) {
    socket.on(event, (payload = {}, cb) => {
      const ctx = requirePlayer(cb);
      if (!ctx) return;
      runPlayerAction(def, ctx.room, ctx.player, payload, cb);
    });
  }

  // ---- IRL-Modus: Moderator legt Spieler an und handelt stellvertretend
  socket.on('irl:addPlayer', ({ name } = {}, cb) => {
    const room = requireAdmin(cb);
    if (!room) return;
    const res = gm.addIrlPlayer(room, name);
    if (!res.ok) return fail(cb, res.error);
    broadcastRoom(room);
    broadcastAvatars(room);
    ok(cb, { playerId: res.player.id });
  });

  socket.on('irl:act', ({ playerId, action, payload } = {}, cb) => {
    const room = requireAdmin(cb);
    if (!room) return;
    const def = PLAYER_ACTIONS[action];
    if (!def) return fail(cb, 'Unbekannte Aktion.');
    const player = gm.getPlayerById(room, playerId);
    if (!player) return fail(cb, 'Spieler nicht gefunden.');
    runPlayerAction(def, room, player, payload, cb);
  });

  // ---- Projektor-/Zuschauer-Ansicht (nur lesend, keine Geheimnisse)
  socket.on('display:join', ({ code } = {}, cb) => {
    const room = gm.getRoom(code);
    if (!room) return fail(cb, 'Raum nicht gefunden.');
    socket.data = { role: 'display', code: room.code };
    socket.join(displayRoom(room.code));
    socket.join(gameRoom(room.code));
    ok(cb, { code: room.code, gameType: room.gameType, state: gm.buildState(room, { role: 'display' }) });
    socket.emit('avatars', gm.avatarMap(room));
  });

  // ---- Trennung
  socket.on('disconnect', () => {
    if (socket.data?.role === 'player') {
      const room = gm.getRoom(socket.data.code);
      if (room) {
        gm.setPlayerConnected(room, socket.data.playerToken, false);
        broadcastRoom(room);
      }
    }
  });
});

// Periodische Aufräum-Aufgabe für inaktive Räume.
setInterval(() => gm.cleanupInactiveRooms(), 10 * 60 * 1000).unref();

httpServer.listen(PORT, () => {
  console.log(`Gamemaster läuft auf http://localhost:${PORT}`);
  console.log(`Admin-Passwort: ${ADMIN_PASSWORD === 'gamemaster' ? 'gamemaster (Standard – bitte per ADMIN_PASSWORD ändern!)' : '******'}`);
});
