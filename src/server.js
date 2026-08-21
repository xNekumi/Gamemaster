import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GameManager } from './gameManager.js';
import { HeartsGame } from './heartsGame.js';

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

if (!Array.isArray(questions) || questions.length === 0) {
  console.error('Keine Fragen gefunden. Bitte data/questions.json prüfen.');
  process.exit(1);
}

const hearts = new HeartsGame({ questions: heartsQuestions, config });
const gm = new GameManager({ questions, config, hearts });

// -------------------------------------------------------------- Express
const app = express();
app.use(express.static(join(ROOT, 'public')));
app.get('/admin', (_req, res) => res.sendFile(join(ROOT, 'public', 'admin.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: gm.rooms.size }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// -------------------------------------------------- Broadcast-Helfer
function broadcastRoom(room) {
  // Admins im Raum
  io.to(adminRoom(room.code)).emit('state', gm.buildState(room, { role: 'admin' }));
  // Jeder Spieler bekommt seine gefilterte Sicht
  for (const player of room.players.values()) {
    io.to(playerSocketRoom(room.code, player.id)).emit(
      'state',
      gm.buildState(room, { role: 'player', playerId: player.id })
    );
  }
}

const adminRoom = (code) => `admin:${code}`;
const playerSocketRoom = (code, playerId) => `player:${code}:${playerId}`;
const gameRoom = (code) => `game:${code}`;

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

// ---------------------------------------------------------- Socket.IO
io.on('connection', (socket) => {
  // socket.data: { role, code, adminToken?, playerId?, playerToken? }

  // ---- Admin erstellt Spiel
  socket.on('admin:createGame', ({ password, gameType } = {}, cb) => {
    if (password !== ADMIN_PASSWORD) return fail(cb, 'Falsches Admin-Passwort.');
    const room = gm.createRoom(gameType);
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

  socket.on('player:submitAnswer', ({ text } = {}, cb) => {
    const ctx = requirePlayer(cb);
    if (!ctx) return;
    const res = gm.submitAnswer(ctx.room, ctx.player, text);
    if (!res.ok) return fail(cb, res.error);
    broadcastRoom(ctx.room);
    ok(cb);
  });

  socket.on('player:vote', ({ answerId } = {}, cb) => {
    const ctx = requirePlayer(cb);
    if (!ctx) return;
    const res = gm.submitVote(ctx.room, ctx.player, answerId);
    if (!res.ok) return fail(cb, res.error);
    broadcastRoom(ctx.room);
    ok(cb);
  });

  // ---- Spieler-Vote für "Der dümmste fliegt"
  socket.on('hearts:vote', ({ targetId } = {}, cb) => {
    const ctx = requirePlayer(cb);
    if (!ctx) return;
    if (ctx.room.gameType !== 'hearts') return fail(cb, 'Falscher Spieltyp.');
    const res = gm.hearts.vote(ctx.room, ctx.player, targetId);
    if (!res.ok) return fail(cb, res.error);
    broadcastRoom(ctx.room);
    ok(cb, { allVoted: gm.hearts.allVoted(ctx.room) });
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
