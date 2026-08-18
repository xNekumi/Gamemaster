import { randomBytes, randomUUID } from 'node:crypto';

/**
 * GameManager verwaltet alle laufenden Spielräume im Speicher.
 *
 * Ein Raum durchläuft folgende Phasen:
 *   'lobby'     -> Spieler treten bei
 *   'answering' -> Frage sichtbar, Spieler tippen ihre Antwort
 *   'voting'    -> alle Antworten (Spieler + richtige) gemischt sichtbar, Spieler stimmen ab
 *   'reveal'    -> Punkte berechnet; Admin deckt pro Antwort Autor + Stimmen auf
 *   'finished'  -> Endstand
 */

const PHASES = Object.freeze({
  LOBBY: 'lobby',
  ANSWERING: 'answering',
  VOTING: 'voting',
  REVEAL: 'reveal',
  FINISHED: 'finished',
});

// Zeichen ohne leicht verwechselbare (0/O, 1/I) für den Raum-Code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalize(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class GameManager {
  /**
   * @param {object} opts
   * @param {Array<{question:string, answer:string}>} opts.questions
   * @param {object} opts.config
   */
  constructor({ questions, config }) {
    this.questions = questions.map((q, idx) => ({ id: idx, ...q }));
    this.config = config;
    /** @type {Map<string, object>} */
    this.rooms = new Map();
  }

  // ---------------------------------------------------------------- Räume

  createRoom() {
    const code = this._generateUniqueCode();
    const room = {
      code,
      adminToken: randomBytes(24).toString('hex'),
      phase: PHASES.LOBBY,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      round: 0,
      players: new Map(),
      usedQuestionIds: new Set(),
      current: null,
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  deleteRoom(code) {
    this.rooms.delete(String(code || '').toUpperCase());
  }

  _generateUniqueCode() {
    const len = this.config.room.codeLength;
    let code;
    do {
      code = Array.from({ length: len }, () =>
        CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  /** Räumt inaktive Räume auf (wird periodisch aufgerufen). */
  cleanupInactiveRooms() {
    const ttl = this.config.room.inactiveRoomTtlMinutes * 60 * 1000;
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivity > ttl) this.rooms.delete(code);
    }
  }

  _touch(room) {
    room.lastActivity = Date.now();
  }

  // ------------------------------------------------------------- Spieler

  /**
   * Spieler tritt bei oder verbindet sich mit vorhandenem Token neu.
   * @returns {{ok:true, room, player} | {ok:false, error:string}}
   */
  joinPlayer(code, name, token) {
    const room = this.getRoom(code);
    if (!room) return { ok: false, error: 'Raum nicht gefunden.' };

    // Reconnect über bestehendes Token
    if (token) {
      const existing = room.players.get(token);
      if (existing) {
        existing.connected = true;
        this._touch(room);
        return { ok: true, room, player: existing };
      }
    }

    const cleanName = String(name || '').trim().slice(0, 24);
    if (!cleanName) return { ok: false, error: 'Bitte gib einen Namen ein.' };

    const nameTaken = [...room.players.values()].some(
      (p) => normalize(p.name) === normalize(cleanName)
    );
    if (nameTaken) return { ok: false, error: 'Name ist bereits vergeben.' };

    if (room.players.size >= this.config.room.maxPlayers) {
      return { ok: false, error: 'Der Raum ist voll.' };
    }

    const player = {
      id: randomUUID(),
      token: randomBytes(24).toString('hex'),
      name: cleanName,
      score: 0,
      connected: true,
      avatar: null, // data-URL des Profilbilds (optional)
      joinedAt: Date.now(),
    };
    room.players.set(player.token, player);
    this._touch(room);
    return { ok: true, room, player };
  }

  getPlayerByToken(room, token) {
    return room?.players.get(token) || null;
  }

  setPlayerConnected(room, token, connected) {
    const p = room?.players.get(token);
    if (p) p.connected = connected;
  }

  /**
   * Setzt das Profilbild eines Spielers (data-URL).
   * Größe wird begrenzt, um Speicher/Bandbreite zu schonen.
   */
  setAvatar(room, player, dataUrl) {
    if (dataUrl === null || dataUrl === '') {
      player.avatar = null;
      this._touch(room);
      return { ok: true };
    }
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) {
      return { ok: false, error: 'Ungültiges Bildformat.' };
    }
    // ~500 KB Obergrenze (Client verkleinert bereits deutlich stärker)
    if (dataUrl.length > 500 * 1024) {
      return { ok: false, error: 'Bild ist zu groß.' };
    }
    player.avatar = dataUrl;
    this._touch(room);
    return { ok: true };
  }

  /** Map playerId -> avatar (oder null) für den separaten Avatar-Broadcast. */
  avatarMap(room) {
    const map = {};
    for (const p of room.players.values()) map[p.id] = p.avatar;
    return map;
  }

  /** Spieler in Beitritts-Reihenfolge (stabile Reihenfolge für die Avatar-Leiste). */
  _roster(room) {
    return [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }));
  }

  kickPlayer(room, playerId) {
    for (const [token, p] of room.players) {
      if (p.id === playerId) {
        room.players.delete(token);
        break;
      }
    }
    this._touch(room);
  }

  // -------------------------------------------------------- Spielablauf

  /** Startet eine neue Runde: wählt zufällige, noch nicht genutzte Frage. */
  startRound(room) {
    const available = this.questions.filter((q) => !room.usedQuestionIds.has(q.id));
    const pool = available.length > 0 ? available : this.questions;
    if (available.length === 0) room.usedQuestionIds.clear();

    const question = pool[Math.floor(Math.random() * pool.length)];
    room.usedQuestionIds.add(question.id);
    room.round += 1;

    room.current = {
      question,
      // truth = eigener Antwort-Eintrag, authorId === null kennzeichnet die richtige Antwort
      answers: [
        {
          id: randomUUID(),
          text: question.answer,
          authorId: null,
          isTruth: true,
          votes: [],
          revealed: false,
        },
      ],
      submissions: new Map(), // playerId -> answerId
      truthGuessers: new Set(), // Spieler, die exakt die richtige Antwort getippt haben
      votes: new Map(), // playerId -> answerId
      scored: false,
    };
    room.phase = PHASES.ANSWERING;
    this._touch(room);
  }

  /** Spieler reicht Antworttext ein. */
  submitAnswer(room, player, text) {
    if (room.phase !== PHASES.ANSWERING || !room.current) {
      return { ok: false, error: 'Aktuell können keine Antworten abgegeben werden.' };
    }
    if (room.current.submissions.has(player.id) || room.current.truthGuessers.has(player.id)) {
      return { ok: false, error: 'Du hast bereits geantwortet.' };
    }
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return { ok: false, error: 'Die Antwort darf nicht leer sein.' };

    // Sonderfall: Spieler tippt exakt die richtige Antwort.
    // Kein doppelter Eintrag – Spieler wird als "richtig geraten" gewertet.
    if (normalize(clean) === normalize(room.current.question.answer)) {
      room.current.truthGuessers.add(player.id);
    } else {
      const answer = {
        id: randomUUID(),
        text: clean,
        authorId: player.id,
        isTruth: false,
        votes: [],
        revealed: false,
      };
      room.current.answers.push(answer);
      room.current.submissions.set(player.id, answer.id);
    }
    this._touch(room);

    // Kein Auto-Start der Abstimmung mehr: Der Admin entscheidet per Button,
    // damit er die Antworten vorher prüfen/korrigieren kann.
    return { ok: true, allAnswered: this._allAnswered(room) };
  }

  /**
   * Admin korrigiert den Text einer Spieler-Antwort (Rechtschreibung/Zeichensetzung).
   * Nur in der Antwort-Phase und nur für Spieler-Antworten (nicht die Wahrheit).
   */
  editAnswer(room, answerId, text) {
    if (room.phase !== PHASES.ANSWERING || !room.current) {
      return { ok: false, error: 'Antworten können nur vor der Abstimmung bearbeitet werden.' };
    }
    const answer = room.current.answers.find((a) => a.id === answerId);
    if (!answer) return { ok: false, error: 'Antwort nicht gefunden.' };
    if (answer.isTruth) return { ok: false, error: 'Die richtige Antwort kann nicht bearbeitet werden.' };
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return { ok: false, error: 'Die Antwort darf nicht leer sein.' };
    answer.text = clean;
    this._touch(room);
    return { ok: true };
  }

  _activePlayers(room) {
    // Nur verbundene Spieler zählen für Auto-Fortschritt.
    return [...room.players.values()].filter((p) => p.connected);
  }

  _allAnswered(room) {
    const active = this._activePlayers(room);
    if (active.length === 0) return false;
    return active.every(
      (p) => room.current.submissions.has(p.id) || room.current.truthGuessers.has(p.id)
    );
  }

  /** Wechsel in die Abstimmungsphase; Antworten werden gemischt. */
  beginVoting(room) {
    if (!room.current) return;
    room.current.answers = shuffle(room.current.answers);
    room.phase = PHASES.VOTING;
    this._touch(room);
  }

  /** Spieler stimmt für eine Antwort. Eigene Antwort ist nicht wählbar. */
  submitVote(room, player, answerId) {
    if (room.phase !== PHASES.VOTING || !room.current) {
      return { ok: false, error: 'Aktuell kann nicht abgestimmt werden.' };
    }
    if (room.current.votes.has(player.id)) {
      return { ok: false, error: 'Du hast bereits abgestimmt.' };
    }
    const answer = room.current.answers.find((a) => a.id === answerId);
    if (!answer) return { ok: false, error: 'Antwort nicht gefunden.' };
    if (answer.authorId === player.id) {
      return { ok: false, error: 'Du kannst nicht für deine eigene Antwort stimmen.' };
    }
    answer.votes.push(player.id);
    room.current.votes.set(player.id, answer.id);
    this._touch(room);

    const done = this._allVoted(room);
    if (done) this.showResults(room);
    return { ok: true, allVoted: done };
  }

  _allVoted(room) {
    // Spieler, die die Wahrheit getippt haben, geben keine Stimme ab (haben keine wählbare Nicht-eigene Situation? -> sie stimmen trotzdem).
    // Alle verbundenen Spieler sollen abstimmen. Wer keine eigene Antwort hat, stimmt ganz normal.
    const active = this._activePlayers(room);
    const voters = active.filter((p) => this._playerHasVotableOption(room, p));
    if (voters.length === 0) return false;
    return voters.every((p) => room.current.votes.has(p.id));
  }

  _playerHasVotableOption(room, player) {
    // Es gibt mindestens eine Antwort, die nicht vom Spieler selbst stammt.
    return room.current.answers.some((a) => a.authorId !== player.id);
  }

  /** Berechnet die Punkte und wechselt in die Reveal-Phase. */
  showResults(room) {
    if (!room.current) return;
    if (!room.current.scored) {
      this._computeScores(room);
      room.current.scored = true;
    }
    room.phase = PHASES.REVEAL;
    this._touch(room);
  }

  _computeScores(room) {
    const cur = room.current;
    // Punkte für Stimmen + richtiges Raten
    for (const [voterId, answerId] of cur.votes) {
      const answer = cur.answers.find((a) => a.id === answerId);
      if (!answer) continue;
      if (answer.isTruth) {
        this._addScore(room, voterId, this.config.scoring.pointsForGuessingCorrectAnswer);
      } else if (answer.authorId) {
        this._addScore(room, answer.authorId, this.config.scoring.pointsForVoteOnYourAnswer);
      }
    }
    // Spieler, die die richtige Antwort exakt getippt haben, erhalten den Rate-Punkt.
    for (const playerId of cur.truthGuessers) {
      this._addScore(room, playerId, this.config.scoring.pointsForGuessingCorrectAnswer);
    }
  }

  _addScore(room, playerId, points) {
    for (const p of room.players.values()) {
      if (p.id === playerId) {
        p.score += points;
        return;
      }
    }
  }

  /** Admin deckt eine einzelne Antwort auf (Autor + Stimmen). */
  revealAnswer(room, answerId) {
    if (room.phase !== PHASES.REVEAL || !room.current) return;
    const answer = room.current.answers.find((a) => a.id === answerId);
    if (answer) answer.revealed = true;
    this._touch(room);
  }

  revealAllAnswers(room) {
    if (room.phase !== PHASES.REVEAL || !room.current) return;
    for (const a of room.current.answers) a.revealed = true;
    this._touch(room);
  }

  /** Zur nächsten Frage (oder erste Runde). */
  nextQuestion(room) {
    this.startRound(room);
  }

  endGame(room) {
    room.phase = PHASES.FINISHED;
    room.current = null;
    this._touch(room);
  }

  backToLobby(room) {
    room.phase = PHASES.LOBBY;
    room.current = null;
    room.round = 0;
    room.usedQuestionIds.clear();
    this._touch(room);
  }

  // --------------------------------------------------- Zustands-Snapshots

  _playerName(room, playerId) {
    for (const p of room.players.values()) if (p.id === playerId) return p.name;
    return 'Unbekannt';
  }

  _scoreboard(room) {
    return [...room.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  /**
   * Baut einen rollen-spezifischen Snapshot des Spielzustands.
   * @param {object} room
   * @param {{role:'admin'} | {role:'player', playerId:string}} viewer
   */
  buildState(room, viewer) {
    const base = {
      code: room.code,
      phase: room.phase,
      round: room.round,
      totalQuestions: this.questions.length,
      scoreboard: this._scoreboard(room),
      roster: this._roster(room),
      playerCount: room.players.size,
    };

    if (room.phase === PHASES.LOBBY || room.phase === PHASES.FINISHED) {
      return { ...base, role: viewer.role };
    }

    const cur = room.current;
    const answeredIds = new Set([...cur.submissions.keys(), ...cur.truthGuessers]);

    if (viewer.role === 'admin') {
      return {
        ...base,
        role: 'admin',
        question: cur.question.question,
        correctAnswer: cur.question.answer,
        answeredCount: answeredIds.size,
        connectedCount: this._activePlayers(room).length,
        votedCount: cur.votes.size,
        answerStatus: [...room.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          answered: answeredIds.has(p.id),
          voted: cur.votes.has(p.id),
          connected: p.connected,
        })),
        answers: cur.answers.map((a) => ({
          id: a.id,
          text: a.text,
          isTruth: a.isTruth,
          revealed: a.revealed,
          authorId: a.isTruth ? null : a.authorId,
          authorName: a.isTruth ? null : this._playerName(room, a.authorId),
          voterIds: [...a.votes],
          voters: a.votes.map((vid) => this._playerName(room, vid)),
          voteCount: a.votes.length,
        })),
        truthGuessers: [...cur.truthGuessers].map((id) => this._playerName(room, id)),
      };
    }

    // Spieler-Sicht
    const playerId = viewer.playerId;
    const myAnswerId = cur.submissions.get(playerId) || null;
    const iGuessedTruth = cur.truthGuessers.has(playerId);
    const myVote = cur.votes.get(playerId) || null;

    const view = {
      ...base,
      role: 'player',
      playerId,
      question: cur.question.question,
      hasAnswered: answeredIds.has(playerId),
      hasVoted: cur.votes.has(playerId),
      myAnswerId,
      iGuessedTruth,
      myVote,
    };

    if (room.phase === PHASES.VOTING || room.phase === PHASES.REVEAL) {
      const revealed = (a) => room.phase === PHASES.REVEAL && a.revealed;
      view.answers = cur.answers.map((a) => ({
        id: a.id,
        text: a.text,
        isOwn: a.authorId === playerId,
        // in der Reveal-Phase werden Details erst durch den Admin aufgedeckt
        revealed: a.revealed,
        isTruth: revealed(a) ? a.isTruth : undefined,
        authorId: revealed(a) && !a.isTruth ? a.authorId : undefined,
        authorName: revealed(a) && !a.isTruth ? this._playerName(room, a.authorId) : undefined,
        voterIds: revealed(a) ? [...a.votes] : undefined,
        voters: revealed(a) ? a.votes.map((vid) => this._playerName(room, vid)) : undefined,
      }));
    }

    if (room.phase === PHASES.REVEAL) {
      view.correctAnswerRevealed = cur.answers.some((a) => a.isTruth && a.revealed);
    }

    return view;
  }
}

export { PHASES };
