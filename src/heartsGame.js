import { randomUUID } from 'node:crypto';

/**
 * "Der dümmste fliegt"
 *
 * Normale Runden:
 *   'question' -> Admin stellt den Hot-Seat-Spielern Fragen (Popup), tippt die
 *                 Antwort ein und markiert grün/rot. Voting erst nach genug Fragen.
 *   'voting'   -> Jeder lebende Spieler stimmt für einen anderen lebenden Spieler.
 *   'reveal'   -> Admin deckt die Stimmen auf und bestätigt.
 *   'roundEnd' -> Spieler mit den meisten Stimmen verliert ein Herz. 0 = raus.
 *
 * Finale (automatisch, sobald nur noch 2 Spieler leben):
 *   'finale'   -> Beide Finalisten beantworten nacheinander dieselben Fragen
 *                 (10, bei Gleichstand +5). Pro richtige Antwort 1 Punkt (Admin
 *                 bewertet). Die Punkte sind für die Finalisten verborgen
 *                 (Zuschauer sehen live), erst zur Auflösung für alle sichtbar.
 *   'finished' -> Sieger steht fest.
 */

const PHASES = Object.freeze({
  LOBBY: 'lobby',
  QUESTION: 'question',
  VOTING: 'voting',
  REVEAL: 'reveal',
  ROUND_END: 'roundEnd',
  FINALE: 'finale',
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
  constructor({ questions, config }) {
    // Fragen unterstützen zwei Formate: "Text" oder { question, answer }.
    this.questions = (questions || []).map((q, i) =>
      typeof q === 'string'
        ? { id: i, text: q, answer: '' }
        : { id: i, text: q.question || q.text || '', answer: q.answer || '' }
    );
    this.startHearts = config?.hearts?.startHearts ?? 3;
    this.minQuestions = config?.hearts?.minQuestionsPerPlayer ?? 2;
    this.finaleQuestions = config?.hearts?.finaleQuestions ?? 10;
    this.finaleTiebreakQuestions = config?.hearts?.finaleTiebreakQuestions ?? 5;
  }

  /** Initialer Zustand (Lobby) beim Erstellen eines Raums. */
  initialState() {
    return {
      phase: PHASES.LOBBY,
      round: 0,
      order: [],
      hearts: {},
      questionCount: {},
      questionTarget: this.minQuestions,
      activePlayerId: null,
      currentQuestion: null,
      usedQuestionIds: [],
      answers: [],
      votes: {},
      revealedVoters: [],
      votingCandidates: null,
      isRunoff: false,
      lastResult: null,
      manualPick: false, // Admin soll nach verworfenem Voting manuell entscheiden
      finaleNext: false, // nach dieser Rundenende folgt das Finale
      finale: null, // { finalists, questions, blockSize, finalistIndex, qIndex, scores, stage, block }
      winnerId: null,
    };
  }

  // ---------------------------------------------------------- Hilfen
  _living(room) {
    return room.hearts.order.filter(
      (id) => room.players && this._exists(room, id) && this._heartsOf(room, id) > 0
    );
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
    h.round = 1;
    h.answers = [];
    h.votes = {};
    h.revealedVoters = [];
    h.votingCandidates = null;
    h.isRunoff = false;
    h.lastResult = null;
    h.manualPick = false;
    h.finaleNext = false;
    h.finale = null;
    h.winnerId = null;
    h.currentQuestion = null;
    // Bei genau 2 Spielern startet sofort das Finale.
    if (this._living(room).length === 2) {
      this._startFinale(room);
    } else {
      h.activePlayerId = this._living(room)[0] || null;
      h.phase = PHASES.QUESTION;
      this._autoAskActive(room);
    }
    room.lastActivity = Date.now();
  }

  syncLobby(room) {
    const h = room.hearts;
    if (h.phase !== PHASES.LOBBY) return;
    const ids = [...room.players.values()].map((p) => p.id);
    h.order = h.order.filter((id) => ids.includes(id));
    for (const id of ids) if (!h.order.includes(id)) h.order.push(id);
  }

  // ---------------------------------------------------------- Fragen / Hot-Seat
  setActive(room, playerId) {
    if (room.hearts.phase !== PHASES.QUESTION) return;
    if (this._heartsOf(room, playerId) <= 0) return;
    room.hearts.activePlayerId = playerId;
    room.lastActivity = Date.now();
  }

  nextActive(room) {
    const living = this._living(room);
    if (!living.length) return;
    const idx = living.indexOf(room.hearts.activePlayerId);
    room.hearts.activePlayerId = living[(idx + 1) % living.length];
    room.lastActivity = Date.now();
  }

  _drawQuestion(room) {
    const h = room.hearts;
    let pool = this.questions.filter((q) => !h.usedQuestionIds.includes(q.id));
    if (!pool.length) {
      h.usedQuestionIds = [];
      pool = this.questions;
    }
    if (!pool.length) return null;
    const q = pool[Math.floor(Math.random() * pool.length)];
    h.usedQuestionIds.push(q.id);
    return { text: q.text, answer: q.answer || '' };
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
      const q = this._drawQuestion(room);
      if (!q) throw new Error('Keine Fragen vorhanden.');
      text = q.text;
      answer = q.answer;
    }
    h.currentQuestion = {
      id: randomUUID(),
      text: String(text).slice(0, 300),
      answer: String(answer).slice(0, 300),
      forPlayerId: target,
    };
    room.lastActivity = Date.now();
  }

  clearQuestion(room) {
    room.hearts.currentQuestion = null;
    room.lastActivity = Date.now();
  }

  _autoAskActive(room) {
    try {
      if (room.hearts.phase === PHASES.QUESTION && room.hearts.activePlayerId) {
        this.askQuestion(room, {});
      }
    } catch {
      /* keine Frage verfügbar */
    }
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

    if (!this.canStartVoting(room)) {
      this.nextActive(room);
      this._autoAskActive(room);
    }
    room.lastActivity = Date.now();
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

  _decisionPending(room) {
    const h = room.hearts;
    return h.phase === PHASES.QUESTION && !h.currentQuestion && this.canStartVoting(room);
  }

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
    const h = room.hearts;
    if (h.phase !== PHASES.QUESTION) throw new Error('Voting kann jetzt nicht gestartet werden.');
    if (!this.canStartVoting(room)) {
      throw new Error(`Jeder lebende Spieler muss erst genug Fragen gehabt haben.`);
    }
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
    if (!this._voters(room).includes(voter.id)) {
      return { ok: false, error: 'Ausgeschiedene Spieler stimmen nicht ab.' };
    }
    if (targetId === voter.id) return { ok: false, error: 'Du kannst nicht für dich selbst stimmen.' };
    if (!this._candidateIds(room).includes(targetId)) {
      return { ok: false, error: 'Für diesen Spieler kann nicht gestimmt werden.' };
    }
    h.votes[voter.id] = targetId;
    room.lastActivity = Date.now();
    return { ok: true };
  }

  _voters(room) {
    return this._living(room);
  }
  _candidateIds(room) {
    return room.hearts.votingCandidates || this._living(room);
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
    for (const target of Object.values(room.hearts.votes)) counts[target] = (counts[target] || 0) + 1;
    let max = 0;
    for (const c of Object.values(counts)) max = Math.max(max, c);
    const leaders = Object.keys(counts).filter((id) => counts[id] === max && max > 0);
    return { counts, max, leaders };
  }

  confirmResult(room) {
    const h = room.hearts;
    if (h.phase !== PHASES.REVEAL) throw new Error('Ergebnis kann jetzt nicht bestätigt werden.');
    const { leaders } = this._tally(room);

    if (leaders.length === 0) throw new Error('Es wurden keine Stimmen abgegeben.');
    if (leaders.length > 1) {
      // Stichwahl zwischen den Gleichauf-Liegenden
      h.phase = PHASES.VOTING;
      h.votingCandidates = leaders;
      h.isRunoff = true;
      h.votes = {};
      h.revealedVoters = [];
      room.lastActivity = Date.now();
      return { runoff: true, candidates: leaders };
    }

    const loserId = leaders[0];
    h.hearts[loserId] = Math.max(0, this._heartsOf(room, loserId) - 1);
    const eliminatedId = h.hearts[loserId] <= 0 ? loserId : null;
    h.lastResult = { loserId, eliminatedId };

    if (!this._checkFinaleOrFinished(room)) h.phase = PHASES.ROUND_END;
    room.lastActivity = Date.now();
    return { runoff: false, loserId, eliminatedId };
  }

  /**
   * Prüft nach einer Eliminierung: 1 übrig -> Sieger; 2 übrig -> Finale ansetzen
   * (Rundenende, dann startet der Admin das Finale). Gibt true zurück, wenn ein
   * Übergang gesetzt wurde.
   */
  _checkFinaleOrFinished(room) {
    const h = room.hearts;
    const living = this._living(room);
    if (living.length <= 1) {
      h.winnerId = living[0] || null;
      h.phase = PHASES.FINISHED;
      return true;
    }
    if (living.length === 2 && h.phase !== PHASES.FINALE) {
      h.finaleNext = true;
      h.phase = PHASES.ROUND_END;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------- Admin-Overrides
  /** Zieht einem Spieler manuell ein Herz ab. */
  removeLife(room, playerId) {
    const h = room.hearts;
    if ([PHASES.LOBBY, PHASES.FINALE, PHASES.FINISHED].includes(h.phase)) {
      throw new Error('Leben können jetzt nicht abgezogen werden.');
    }
    if (this._heartsOf(room, playerId) <= 0) throw new Error('Spieler ist bereits ausgeschieden.');
    h.hearts[playerId] = Math.max(0, this._heartsOf(room, playerId) - 1);
    const eliminatedId = h.hearts[playerId] <= 0 ? playerId : null;
    h.lastResult = { loserId: playerId, eliminatedId, manual: true };
    h.manualPick = false;
    this._checkFinaleOrFinished(room); // sonst bleibt die aktuelle Phase erhalten
    room.lastActivity = Date.now();
  }

  /** Verwirft die laufende Abstimmung; der Admin entscheidet manuell (roundEnd). */
  closeVoting(room) {
    const h = room.hearts;
    if (![PHASES.VOTING, PHASES.REVEAL].includes(h.phase)) {
      throw new Error('Es läuft gerade keine Abstimmung.');
    }
    h.votes = {};
    h.revealedVoters = [];
    h.votingCandidates = null;
    h.isRunoff = false;
    h.lastResult = null;
    h.manualPick = true;
    h.phase = PHASES.ROUND_END;
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Finale
  _startFinale(room) {
    const h = room.hearts;
    const finalists = this._living(room).slice(0, 2);
    if (finalists.length < 2) return;
    h.finale = {
      finalists,
      block: 1,
      blockSize: this.finaleQuestions,
      finalistIndex: 0,
      qIndex: 0,
      scores: { [finalists[0]]: 0, [finalists[1]]: 0 },
      stage: 'answering',
      questions: this._drawFinaleQuestions(room, this.finaleQuestions),
    };
    h.phase = PHASES.FINALE;
    h.finaleNext = false;
    h.manualPick = false;
    h.votes = {};
    h.revealedVoters = [];
    h.answers = [];
    this._setFinaleQuestion(room);
    room.lastActivity = Date.now();
  }

  _drawFinaleQuestions(room, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const q = this._drawQuestion(room);
      if (!q) break;
      out.push(q);
    }
    return out;
  }

  _setFinaleQuestion(room) {
    const h = room.hearts;
    const f = h.finale;
    const active = f.finalists[f.finalistIndex];
    const q = f.questions[f.qIndex] || { text: '', answer: '' };
    h.activePlayerId = active;
    h.currentQuestion = {
      id: randomUUID(),
      text: q.text,
      answer: q.answer,
      forPlayerId: active,
    };
  }

  finaleAnswer(room, correct) {
    const h = room.hearts;
    const f = h.finale;
    if (h.phase !== PHASES.FINALE || !f || f.stage !== 'answering') {
      throw new Error('Aktuell keine Finale-Frage offen.');
    }
    const active = f.finalists[f.finalistIndex];
    if (correct === true) f.scores[active] = (f.scores[active] || 0) + 1;
    f.qIndex += 1;

    if (f.qIndex < f.blockSize) {
      this._setFinaleQuestion(room);
    } else if (f.finalistIndex === 0) {
      f.finalistIndex = 1;
      f.qIndex = 0;
      this._setFinaleQuestion(room);
    } else {
      // beide durch -> Auflösung
      f.stage = 'reveal';
      h.currentQuestion = null;
      h.activePlayerId = null;
    }
    room.lastActivity = Date.now();
  }

  _finaleTie(room) {
    const f = room.hearts.finale;
    const [a, b] = f.finalists;
    return (f.scores[a] || 0) === (f.scores[b] || 0);
  }

  finaleTiebreak(room) {
    const h = room.hearts;
    const f = h.finale;
    if (h.phase !== PHASES.FINALE || f.stage !== 'reveal') throw new Error('Jetzt nicht möglich.');
    if (!this._finaleTie(room)) throw new Error('Es gibt keinen Gleichstand.');
    f.questions = this._drawFinaleQuestions(room, this.finaleTiebreakQuestions);
    f.blockSize = f.questions.length;
    f.finalistIndex = 0;
    f.qIndex = 0;
    f.block += 1;
    f.stage = 'answering';
    this._setFinaleQuestion(room);
    room.lastActivity = Date.now();
  }

  finaleFinish(room) {
    const h = room.hearts;
    const f = h.finale;
    if (h.phase !== PHASES.FINALE || f.stage !== 'reveal') throw new Error('Jetzt nicht möglich.');
    if (this._finaleTie(room)) throw new Error('Gleichstand – es müssen weitere Fragen gespielt werden.');
    const [a, b] = f.finalists;
    h.winnerId = (f.scores[a] || 0) > (f.scores[b] || 0) ? a : b;
    h.phase = PHASES.FINISHED;
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Runden-Steuerung
  skipRound(room) {
    const h = room.hearts;
    if (![PHASES.QUESTION, PHASES.VOTING, PHASES.REVEAL].includes(h.phase)) {
      throw new Error('Die Runde kann jetzt nicht übersprungen werden.');
    }
    this.nextRound(room);
  }

  nextRound(room) {
    const h = room.hearts;
    if (h.phase === PHASES.FINISHED || h.phase === PHASES.FINALE) return;
    // Wenn nur noch 2 leben -> Finale statt normaler Runde.
    if (h.finaleNext || this._living(room).length === 2) {
      this._startFinale(room);
      return;
    }
    h.round += 1;
    for (const id of h.order) h.questionCount[id] = 0;
    h.questionTarget = this.minQuestions;
    h.answers = [];
    h.votes = {};
    h.revealedVoters = [];
    h.votingCandidates = null;
    h.isRunoff = false;
    h.lastResult = null;
    h.manualPick = false;
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
    if (h.phase === PHASES.FINALE && h.finale) {
      const [a, b] = h.finale.finalists;
      h.winnerId = (h.finale.scores[a] || 0) >= (h.finale.scores[b] || 0) ? a : b;
    } else {
      const living = this._living(room);
      if (living.length) {
        h.winnerId = living.sort((x, y) => this._heartsOf(room, y) - this._heartsOf(room, x))[0];
      }
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
      isFinalist: h.finale ? h.finale.finalists.includes(id) : false,
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
    };

    base.answers = h.answers.map((a) => ({
      id: a.id,
      playerId: a.playerId,
      question: a.question,
      text: a.text,
      correct: a.correct,
    }));

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

    // ---- Finale-Infos (rollen-/sichtbarkeitsabhängig)
    if (h.finale) {
      const f = h.finale;
      const [a, b] = f.finalists;
      const tie = f.stage === 'reveal' && (f.scores[a] || 0) === (f.scores[b] || 0);
      const amFinalist = viewer.role === 'player' && f.finalists.includes(meId);
      // Punkte sehen: Admin immer, bei Auflösung alle, sonst alle außer den 2 Finalisten
      const showScores = isAdmin || f.stage === 'reveal' || !amFinalist;
      base.finale = {
        finalists: f.finalists,
        finalistNames: f.finalists.map((id) => this._name(room, id)),
        activeId: h.phase === PHASES.FINALE && f.stage === 'answering' ? h.activePlayerId : null,
        stage: f.stage,
        block: f.block,
        blockSize: f.blockSize,
        questionNo: Math.min(f.qIndex + 1, f.blockSize),
        tie,
        scores: showScores ? { ...f.scores } : null,
        leaderId:
          f.stage === 'reveal' && !tie ? ((f.scores[a] || 0) > (f.scores[b] || 0) ? a : b) : null,
      };
      base.amFinalist = amFinalist;
    }

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
      base.allVotes = { ...h.votes };
      base.voteCounts = this._tally(room).counts;
      base.allVoted = this.allVoted(room);
      base.voters = this._voters(room);
      base.manualPick = h.manualPick;
      base.finaleNext = h.finaleNext;
    } else {
      base.myId = meId;
      base.myHearts = this._heartsOf(room, meId);
      base.myEliminated = this._heartsOf(room, meId) <= 0;
      if (h.currentQuestion && h.currentQuestion.forPlayerId === meId) {
        base.myQuestion = h.currentQuestion.text;
      }
      if (h.phase === PHASES.VOTING) {
        base.myVote = h.votes[meId] || null;
        base.canVote = this._voters(room).includes(meId);
        base.votableIds = base.canVote ? this._candidateIds(room).filter((id) => id !== meId) : [];
      }
    }

    return base;
  }
}

export { PHASES as HEARTS_PHASES };
