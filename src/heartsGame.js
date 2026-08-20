import { randomUUID } from 'node:crypto';

/**
 * "Der dümmste fliegt"
 *
 * Ablauf pro Runde:
 *   'question' -> Admin stellt den Hot-Seat-Spielern nacheinander Fragen (Popup
 *                 auf deren Bildschirm), tippt deren Antwort ein und markiert
 *                 sie grün (richtig) / rot (falsch). Voting ist erst möglich,
 *                 wenn jeder lebende Spieler >= minQuestionsPerPlayer Fragen hatte.
 *   'voting'   -> Jeder lebende Spieler stimmt für einen anderen lebenden Spieler.
 *   'reveal'   -> Admin deckt die Stimmen einzeln auf (Wähler unten links an der
 *                 Kachel des Gewählten) und bestätigt das Ergebnis.
 *   'roundEnd' -> Spieler mit den meisten Stimmen verliert ein Herz
 *                 (Gleichstand -> Stichwahl). 0 Herzen = ausgeschieden.
 *   'finished' -> nur noch ein Spieler übrig = Sieger.
 */

const PHASES = Object.freeze({
  LOBBY: 'lobby',
  QUESTION: 'question',
  VOTING: 'voting',
  REVEAL: 'reveal',
  ROUND_END: 'roundEnd',
  FINISHED: 'finished',
});

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class HeartsGame {
  /**
   * @param {object} opts
   * @param {string[]} opts.questions  Liste von Fragen (nur der Admin sieht sie)
   * @param {object} opts.config
   */
  constructor({ questions, config }) {
    // Fragen unterstützen zwei Formate: "Text" oder { question, answer }.
    this.questions = (questions || []).map((q, i) =>
      typeof q === 'string'
        ? { id: i, text: q, answer: '' }
        : { id: i, text: q.question || q.text || '', answer: q.answer || '' }
    );
    this.startHearts = config?.hearts?.startHearts ?? 3;
    this.minQuestions = config?.hearts?.minQuestionsPerPlayer ?? 2;
    this.suddenDeathQuestions = config?.hearts?.suddenDeathQuestions ?? 5;
  }

  /** Initialer Zustand (Lobby) beim Erstellen eines Raums. */
  initialState() {
    return {
      phase: PHASES.LOBBY,
      round: 0,
      order: [], // Anzeige-/Zug-Reihenfolge (zufällig pro Lobby)
      hearts: {}, // playerId -> verbleibende Herzen
      questionCount: {}, // playerId -> beantwortete Fragen in dieser Runde
      questionTarget: this.minQuestions, // benötigte Fragen pro Spieler diese Runde
      activePlayerId: null,
      currentQuestion: null, // { id, text, forPlayerId }
      usedQuestionIds: [],
      answers: [], // { id, playerId, question, text, correct }
      votes: {}, // voterId -> targetId
      revealedVoters: [], // bereits aufgedeckte Stimmen
      votingCandidates: null, // null = alle Lebenden; sonst Stichwahl-Kandidaten
      isRunoff: false,
      suddenDeath: false, // nur noch 2 Spieler übrig – Zuschauer entscheiden
      lastResult: null, // { loserId, eliminatedId }
      winnerId: null,
    };
  }

  // ---------------------------------------------------------- Hilfen
  _living(room) {
    const h = room.hearts;
    return h.order.filter((id) => room.players && this._heartsOf(room, id) > 0 && this._exists(room, id));
  }

  _exists(room, id) {
    for (const p of room.players.values()) if (p.id === id) return true;
    return false;
  }

  _heartsOf(room, id) {
    return room.hearts.hearts[id] ?? 0;
  }

  _player(room, id) {
    for (const p of room.players.values()) if (p.id === id) return p;
    return null;
  }

  /** Ausgeschiedene (0 Herzen) Spieler in Reihenfolge – die Zuschauer. */
  _spectators(room) {
    return room.hearts.order.filter((id) => this._exists(room, id) && this._heartsOf(room, id) <= 0);
  }

  /** Aktiviert Sudden Death, wenn nur noch 2 Spieler leben und es Zuschauer gibt. */
  _maybeSuddenDeath(room) {
    const h = room.hearts;
    const living = this._living(room);
    if (living.length === 2 && this._spectators(room).length >= 1) {
      h.suddenDeath = true;
      h.questionTarget = this.suddenDeathQuestions;
    } else {
      h.suddenDeath = false;
    }
  }

  _name(room, id) {
    return this._player(room, id)?.name || 'Unbekannt';
  }

  // ---------------------------------------------------------- Spielstart
  startGame(room) {
    const ids = [...room.players.values()].map((p) => p.id);
    if (ids.length < 2) throw new Error('Es werden mindestens 2 Spieler benötigt.');
    const h = room.hearts;
    h.order = shuffle(ids);
    h.hearts = {};
    h.questionCount = {};
    for (const id of ids) {
      h.hearts[id] = this.startHearts;
      h.questionCount[id] = 0;
    }
    h.questionTarget = this.minQuestions;
    h.suddenDeath = false;
    h.round = 1;
    this._maybeSuddenDeath(room);
    h.answers = [];
    h.votes = {};
    h.revealedVoters = [];
    h.votingCandidates = null;
    h.isRunoff = false;
    h.lastResult = null;
    h.winnerId = null;
    h.currentQuestion = null;
    h.activePlayerId = this._living(room)[0] || null;
    h.phase = PHASES.QUESTION;
    this._autoAskActive(room);
    room.lastActivity = Date.now();
  }

  /** Neue Spieler in der Lobby in die Reihenfolge aufnehmen. */
  syncLobby(room) {
    const h = room.hearts;
    if (h.phase !== PHASES.LOBBY) return;
    const ids = [...room.players.values()].map((p) => p.id);
    // In zufälliger Reihenfolge halten, neue anhängen, entfernte streichen.
    h.order = h.order.filter((id) => ids.includes(id));
    for (const id of ids) if (!h.order.includes(id)) h.order.push(id);
  }

  // ---------------------------------------------------------- Fragen / Hot-Seat
  setActive(room, playerId) {
    if (this._heartsOf(room, playerId) <= 0) return;
    room.hearts.activePlayerId = playerId;
    room.lastActivity = Date.now();
  }

  nextActive(room) {
    const living = this._living(room);
    if (!living.length) return;
    const cur = room.hearts.activePlayerId;
    const idx = living.indexOf(cur);
    room.hearts.activePlayerId = living[(idx + 1) % living.length];
    room.lastActivity = Date.now();
  }

  askQuestion(room, payload = {}) {
    const h = room.hearts;
    if (h.phase !== PHASES.QUESTION) throw new Error('Aktuell können keine Fragen gestellt werden.');
    const target = payload.playerId || h.activePlayerId;
    if (!target || this._heartsOf(room, target) <= 0) throw new Error('Kein gültiger Spieler ausgewählt.');
    h.activePlayerId = target;

    let text = payload.text;
    let answer = '';
    if (!text) {
      // nächste ungenutzte Frage ziehen
      let pool = this.questions.filter((q) => !h.usedQuestionIds.includes(q.id));
      if (!pool.length) {
        h.usedQuestionIds = [];
        pool = this.questions;
      }
      if (!pool.length) throw new Error('Keine Fragen vorhanden.');
      const q = pool[Math.floor(Math.random() * pool.length)];
      h.usedQuestionIds.push(q.id);
      text = q.text;
      answer = q.answer || '';
    }
    h.currentQuestion = {
      id: randomUUID(),
      text: String(text).slice(0, 300),
      answer: String(answer).slice(0, 300), // nur für den Admin sichtbar
      forPlayerId: target,
    };
    room.lastActivity = Date.now();
  }

  clearQuestion(room) {
    room.hearts.currentQuestion = null;
    room.lastActivity = Date.now();
  }

  submitAnswer(room, payload = {}) {
    const h = room.hearts;
    if (h.phase !== PHASES.QUESTION) throw new Error('Aktuell können keine Antworten eingetragen werden.');
    const q = h.currentQuestion;
    const playerId = payload.playerId || q?.forPlayerId;
    if (!playerId || this._heartsOf(room, playerId) <= 0) throw new Error('Kein gültiger Spieler.');
    const text = String(payload.text || '').trim().slice(0, 400);
    if (!text) throw new Error('Die Antwort darf nicht leer sein.');

    h.answers.push({
      id: randomUUID(),
      playerId,
      question: q && q.forPlayerId === playerId ? q.text : payload.question || '',
      text,
      correct: payload.correct === true ? true : payload.correct === false ? false : null,
    });
    h.questionCount[playerId] = (h.questionCount[playerId] || 0) + 1;
    if (q && q.forPlayerId === playerId) h.currentQuestion = null;

    // Wenn jetzt alle Lebenden ihr Fragenziel erreicht haben, NICHT automatisch
    // weiter zum nächsten Spieler – der Admin entscheidet (weitere Runde/Voting).
    // Andernfalls automatisch zum nächsten Hot-Seat und die nächste Frage stellen.
    if (!this.canStartVoting(room)) {
      this.nextActive(room);
      this._autoAskActive(room);
    }
    room.lastActivity = Date.now();
  }

  /** Zieht automatisch eine Frage für den aktuell aktiven Spieler (falls möglich). */
  _autoAskActive(room) {
    try {
      if (room.hearts.phase === PHASES.QUESTION && room.hearts.activePlayerId) {
        this.askQuestion(room, {});
      }
    } catch {
      /* keine Frage verfügbar – ignorieren */
    }
  }

  setCorrect(room, answerId, correct) {
    const a = room.hearts.answers.find((x) => x.id === answerId);
    if (a) a.correct = correct === true ? true : correct === false ? false : null;
    room.lastActivity = Date.now();
  }

  editAnswer(room, answerId, text) {
    const a = room.hearts.answers.find((x) => x.id === answerId);
    if (!a) return;
    const clean = String(text || '').trim().slice(0, 400);
    if (clean) a.text = clean;
    room.lastActivity = Date.now();
  }

  removeAnswer(room, answerId) {
    const h = room.hearts;
    const a = h.answers.find((x) => x.id === answerId);
    if (!a) return;
    h.answers = h.answers.filter((x) => x.id !== answerId);
    if (h.questionCount[a.playerId] > 0) h.questionCount[a.playerId] -= 1;
    room.lastActivity = Date.now();
  }

  canStartVoting(room) {
    const living = this._living(room);
    if (living.length < 2) return false;
    const target = room.hearts.questionTarget || this.minQuestions;
    return living.every((id) => (room.hearts.questionCount[id] || 0) >= target);
  }

  /** Entscheidungspunkt: alle Lebenden haben ihr Fragenziel erreicht, keine Frage offen. */
  _decisionPending(room) {
    const h = room.hearts;
    // Im Sudden Death gibt es keine "weitere Fragerunde"-Wahl.
    return !h.suddenDeath && h.phase === PHASES.QUESTION && !h.currentQuestion && this.canStartVoting(room);
  }

  /** "Weitere Fragerunde": Ziel um 1 erhöhen und mit dem nächsten Spieler fortfahren. */
  continueQuestions(room) {
    const h = room.hearts;
    if (h.phase !== PHASES.QUESTION) return;
    h.questionTarget = (h.questionTarget || this.minQuestions) + 1;
    this.nextActive(room);
    this._autoAskActive(room);
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Voting
  startVoting(room) {
    if (room.hearts.phase !== PHASES.QUESTION) throw new Error('Voting kann jetzt nicht gestartet werden.');
    if (!this.canStartVoting(room)) {
      throw new Error(`Jeder lebende Spieler muss erst mindestens ${this.minQuestions} Fragen gehabt haben.`);
    }
    const h = room.hearts;
    h.phase = PHASES.VOTING;
    h.votes = {};
    h.revealedVoters = [];
    h.votingCandidates = null;
    h.isRunoff = false;
    h.currentQuestion = null;
    h.activePlayerId = null;
    room.lastActivity = Date.now();
  }

  vote(room, voter, targetId) {
    const h = room.hearts;
    if (h.phase !== PHASES.VOTING) return { ok: false, error: 'Aktuell kann nicht abgestimmt werden.' };
    const voters = this._voters(room);
    if (!voters.includes(voter.id)) {
      return {
        ok: false,
        error: h.suddenDeath
          ? 'Im Sudden Death entscheiden die ausgeschiedenen Spieler.'
          : 'Ausgeschiedene Spieler stimmen nicht ab.',
      };
    }
    if (targetId === voter.id) return { ok: false, error: 'Du kannst nicht für dich selbst stimmen.' };
    if (!this._candidateIds(room).includes(targetId)) {
      return { ok: false, error: 'Für diesen Spieler kann nicht gestimmt werden.' };
    }
    h.votes[voter.id] = targetId;
    room.lastActivity = Date.now();
    return { ok: true };
  }

  /** Wer abstimmen darf: normal die Lebenden, im Sudden Death die Zuschauer. */
  _voters(room) {
    const h = room.hearts;
    if (h.suddenDeath) {
      const spectators = this._spectators(room);
      return spectators.length ? spectators : this._living(room);
    }
    return this._living(room);
  }

  /** Für wen gestimmt werden kann: Stichwahl-Kandidaten, sonst die Lebenden. */
  _candidateIds(room) {
    const h = room.hearts;
    if (h.votingCandidates) return h.votingCandidates;
    return this._living(room);
  }

  allVoted(room) {
    const voters = this._voters(room);
    return voters.length > 0 && voters.every((id) => room.hearts.votes[id]);
  }

  goToReveal(room) {
    if (room.hearts.phase !== PHASES.VOTING) return;
    room.hearts.phase = PHASES.REVEAL;
    room.lastActivity = Date.now();
  }

  revealVote(room, voterId) {
    const h = room.hearts;
    if (h.votes[voterId] && !h.revealedVoters.includes(voterId)) h.revealedVoters.push(voterId);
    room.lastActivity = Date.now();
  }

  revealAllVotes(room) {
    const h = room.hearts;
    h.revealedVoters = Object.keys(h.votes);
    room.lastActivity = Date.now();
  }

  _tally(room) {
    const counts = {};
    for (const target of Object.values(room.hearts.votes)) {
      counts[target] = (counts[target] || 0) + 1;
    }
    let max = 0;
    for (const c of Object.values(counts)) max = Math.max(max, c);
    const leaders = Object.keys(counts).filter((id) => counts[id] === max && max > 0);
    return { counts, max, leaders };
  }

  confirmResult(room) {
    const h = room.hearts;
    if (h.phase !== PHASES.REVEAL) throw new Error('Ergebnis kann jetzt nicht bestätigt werden.');
    const { leaders } = this._tally(room);

    if (leaders.length === 0) {
      throw new Error('Es wurden keine Stimmen abgegeben.');
    }
    if (leaders.length > 1) {
      // Stichwahl nur zwischen den Gleichauf-Liegenden
      h.phase = PHASES.VOTING;
      h.votingCandidates = leaders;
      h.isRunoff = true;
      h.votes = {};
      h.revealedVoters = [];
      room.lastActivity = Date.now();
      return { runoff: true, candidates: leaders };
    }

    const loserId = leaders[0];
    // Im Sudden Death verliert der Gewählte ALLE verbleibenden Herzen.
    const loss = h.suddenDeath ? this._heartsOf(room, loserId) : 1;
    h.hearts[loserId] = Math.max(0, this._heartsOf(room, loserId) - loss);
    const eliminatedId = h.hearts[loserId] <= 0 ? loserId : null;
    h.lastResult = { loserId, eliminatedId, suddenDeath: h.suddenDeath };

    const living = this._living(room);
    if (living.length <= 1) {
      h.winnerId = living[0] || null;
      h.phase = PHASES.FINISHED;
    } else {
      h.phase = PHASES.ROUND_END;
    }
    room.lastActivity = Date.now();
    return { runoff: false, loserId, eliminatedId };
  }

  /** Überspringt die Abstimmung dieser Runde – niemand verliert ein Herz. */
  skipRound(room) {
    const h = room.hearts;
    if (![PHASES.QUESTION, PHASES.VOTING, PHASES.REVEAL].includes(h.phase)) {
      throw new Error('Die Runde kann jetzt nicht übersprungen werden.');
    }
    this.nextRound(room);
  }

  nextRound(room) {
    const h = room.hearts;
    if (h.phase === PHASES.FINISHED) return;
    h.round += 1;
    for (const id of h.order) h.questionCount[id] = 0;
    h.questionTarget = this.minQuestions;
    this._maybeSuddenDeath(room);
    h.answers = [];
    h.votes = {};
    h.revealedVoters = [];
    h.votingCandidates = null;
    h.isRunoff = false;
    h.lastResult = null;
    h.currentQuestion = null;
    h.activePlayerId = this._living(room)[0] || null;
    h.phase = PHASES.QUESTION;
    this._autoAskActive(room);
    room.lastActivity = Date.now();
  }

  backToLobby(room) {
    room.hearts = this.initialState();
    this.syncLobby(room);
    room.lastActivity = Date.now();
  }

  endGame(room) {
    const h = room.hearts;
    // Sieger = meiste Herzen (bei laufendem Spiel), sonst letzter Lebender.
    const living = this._living(room);
    if (living.length) {
      h.winnerId = living.sort((a, b) => this._heartsOf(room, b) - this._heartsOf(room, a))[0];
    }
    h.phase = PHASES.FINISHED;
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Snapshot
  buildState(room, viewer) {
    const h = room.hearts;
    const isAdmin = viewer.role === 'admin';
    const meId = viewer.playerId;

    const board = h.order.map((id) => ({
      id,
      name: this._name(room, id),
      hearts: this._heartsOf(room, id),
      maxHearts: this.startHearts,
      eliminated: this._heartsOf(room, id) <= 0,
      isActive: id === h.activePlayerId,
    }));

    const base = {
      gameType: 'hearts',
      role: viewer.role,
      code: room.code,
      phase: h.phase,
      round: h.round,
      board,
      activePlayerId: h.activePlayerId,
      minQuestions: this.minQuestions,
      suddenDeath: h.suddenDeath,
    };

    // Antworten dieser Runde (offen, dem Spieler zugeordnet)
    base.answers = h.answers.map((a) => ({
      id: a.id,
      playerId: a.playerId,
      question: a.question,
      text: a.text,
      correct: a.correct,
    }));

    // Aufgedeckte Stimmen: targetId -> [voterId...]
    const votesByTarget = {};
    for (const voterId of h.revealedVoters) {
      const t = h.votes[voterId];
      if (!t) continue;
      (votesByTarget[t] = votesByTarget[t] || []).push(voterId);
    }
    base.votesByTarget = votesByTarget;
    base.votingCandidates = h.votingCandidates;
    base.isRunoff = h.isRunoff;
    base.lastResult = h.lastResult;

    if (h.phase === PHASES.FINISHED) {
      base.winnerId = h.winnerId;
      base.winnerName = h.winnerId ? this._name(room, h.winnerId) : null;
    }

    if (isAdmin) {
      base.currentQuestion = h.currentQuestion;
      base.questionCount = h.questionCount;
      base.questionTarget = h.questionTarget || this.minQuestions;
      base.canStartVoting = this.canStartVoting(room);
      base.decisionPending = this._decisionPending(room);
      base.allVotes = { ...h.votes }; // voterId -> targetId (auch verdeckt)
      base.voteCounts = this._tally(room).counts;
      base.allVoted = this.allVoted(room);
      base.voters = this._voters(room);
    } else {
      // Spieler-Sicht
      base.myId = meId;
      base.myHearts = this._heartsOf(room, meId);
      base.myEliminated = this._heartsOf(room, meId) <= 0;
      // Frage-Popup nur für den aktiven Spieler, dem sie gestellt wurde
      if (h.currentQuestion && h.currentQuestion.forPlayerId === meId) {
        base.myQuestion = h.currentQuestion.text;
      }
      if (h.phase === PHASES.VOTING) {
        base.myVote = h.votes[meId] || null;
        // Wer abstimmen darf, hängt von der Phase ab (im Sudden Death die Zuschauer).
        const voters = this._voters(room);
        base.canVote = voters.includes(meId);
        base.votableIds = base.canVote
          ? this._candidateIds(room).filter((id) => id !== meId)
          : [];
      }
    }

    return base;
  }
}

export { PHASES as HEARTS_PHASES };
