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
  ESTIMATE: 'estimate', // Schätzfrage, wenn alle ihre Fragen richtig hatten
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
    this.defaultTimer = config?.hearts?.timerSeconds ?? 30;
    this.defaultAutoStart = config?.hearts?.timerAutoStart !== false; // Standard: an
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
      estimate: null, // Schätzfrage-Zustand { question, answer, guesses, revealed, tie, result }
      // Timer (für alle sichtbar)
      timerSeconds: this.defaultTimer,
      timerAutoStart: this.defaultAutoStart,
      timerRunning: false,
      timerEndsAt: null,
      timerRemainingMs: this.defaultTimer * 1000,
      winnerId: null,
    };
  }

  // ---------------------------------------------------------- Timer
  setTimerSeconds(room, s) {
    const h = room.hearts;
    const v = Math.floor(Number(s));
    h.timerSeconds = Number.isFinite(v) && v >= 5 ? Math.min(600, v) : this.defaultTimer;
    if (!h.timerRunning) h.timerRemainingMs = h.timerSeconds * 1000;
    room.lastActivity = Date.now();
  }
  setTimerAutoStart(room, on) {
    room.hearts.timerAutoStart = !!on;
    room.lastActivity = Date.now();
  }
  startTimer(room) {
    const h = room.hearts;
    if (!h.timerRunning) {
      h.timerEndsAt = Date.now() + (h.timerRemainingMs ?? h.timerSeconds * 1000);
      h.timerRunning = true;
    }
    room.lastActivity = Date.now();
  }
  stopTimer(room) {
    const h = room.hearts;
    if (h.timerRunning) {
      h.timerRemainingMs = Math.max(0, (h.timerEndsAt || 0) - Date.now());
      h.timerRunning = false;
      h.timerEndsAt = null;
    }
    room.lastActivity = Date.now();
  }
  resetTimer(room) {
    const h = room.hearts;
    h.timerRunning = false;
    h.timerEndsAt = null;
    h.timerRemainingMs = (h.timerSeconds || this.defaultTimer) * 1000;
    room.lastActivity = Date.now();
  }
  /** Bei einer neuen Frage den Timer neu aufziehen (und ggf. automatisch starten). */
  _armTimerForQuestion(room) {
    const h = room.hearts;
    h.timerRunning = false;
    h.timerEndsAt = null;
    h.timerRemainingMs = (h.timerSeconds || this.defaultTimer) * 1000;
    if (h.timerAutoStart) this.startTimer(room);
  }
  _timerView(h) {
    return {
      seconds: h.timerSeconds,
      running: h.timerRunning,
      endsAt: h.timerRunning ? h.timerEndsAt : null,
      remainingMs: h.timerRunning ? Math.max(0, (h.timerEndsAt || 0) - Date.now()) : h.timerRemainingMs,
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
    this._armTimerForQuestion(room);
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
      solution: q && q.forPlayerId === playerId ? q.answer || '' : payload.solution || '',
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
    h.currentQuestion = null;
    h.activePlayerId = null;
    this.stopTimer(room);

    // Wenn alle lebenden Spieler perfekt waren -> Schätzfrage statt Abstimmung.
    const candidates = this._nonPerfectLiving(room);
    if (candidates.length === 0) {
      this._enterEstimate(room);
      return;
    }
    h.phase = PHASES.VOTING;
    h.votes = {};
    h.revealedVoters = [];
    h.votingCandidates = candidates; // nur nicht-perfekte Spieler sind wählbar
    h.isRunoff = false;
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
  _answersOf(room, id) {
    return room.hearts.answers.filter((a) => a.playerId === id);
  }
  /** Spieler, der alle seine Fragen dieser Runde richtig hatte (nicht wählbar). */
  _perfect(room, id) {
    const answers = this._answersOf(room, id);
    return answers.length > 0 && answers.every((a) => a.correct === true);
  }
  _nonPerfectLiving(room) {
    return this._living(room).filter((id) => !this._perfect(room, id));
  }
  _candidateIds(room) {
    // Perfekte Spieler (alle Fragen richtig) sind nicht wählbar.
    return room.hearts.votingCandidates || this._nonPerfectLiving(room);
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

  // ---------------------------------------------------------- Schätzfrage
  // Wenn alle lebenden Spieler ihre Fragen richtig hatten, entscheidet eine
  // Schätzfrage: Wer am weitesten von der Zahl entfernt ist, verliert ein Herz.
  _enterEstimate(room) {
    const h = room.hearts;
    h.phase = PHASES.ESTIMATE;
    h.estimate = { question: null, answer: null, guesses: {}, revealed: false, tie: false, result: null };
    this.stopTimer(room);
    room.lastActivity = Date.now();
  }

  setEstimateQuestion(room, payload = {}) {
    const h = room.hearts;
    if (h.phase !== PHASES.ESTIMATE) throw new Error('Aktuell keine Schätzfrage möglich.');
    const question = String(payload.question || '').trim().slice(0, 300);
    const answer = Number(payload.answer);
    if (!question) throw new Error('Bitte eine Schätzfrage eingeben.');
    if (!Number.isFinite(answer)) throw new Error('Bitte eine gültige Zahl als Lösung angeben.');
    h.estimate = { question, answer, guesses: {}, revealed: false, tie: false, result: null };
    this._armTimerForQuestion(room);
    room.lastActivity = Date.now();
  }

  estimateGuess(room, player, value) {
    const h = room.hearts;
    const e = h.estimate;
    if (h.phase !== PHASES.ESTIMATE || !e || !e.question) return { ok: false, error: 'Aktuell keine Schätzfrage offen.' };
    if (e.revealed) return { ok: false, error: 'Die Schätzfrage ist bereits aufgelöst.' };
    if (this._heartsOf(room, player.id) <= 0) return { ok: false, error: 'Ausgeschiedene Spieler schätzen nicht mit.' };
    const v = Number(value);
    if (!Number.isFinite(v)) return { ok: false, error: 'Bitte eine gültige Zahl eingeben.' };
    e.guesses[player.id] = v;
    room.lastActivity = Date.now();
    return { ok: true };
  }

  revealEstimate(room) {
    const h = room.hearts;
    const e = h.estimate;
    if (h.phase !== PHASES.ESTIMATE || !e || !e.question) throw new Error('Keine Schätzfrage offen.');
    this.stopTimer(room);
    const living = this._living(room);
    // Distanzen bestimmen; wer nicht geschätzt hat, gilt als am weitesten entfernt.
    const dist = {};
    for (const id of living) {
      dist[id] = id in e.guesses ? Math.abs(e.guesses[id] - e.answer) : Infinity;
    }
    let max = -Infinity;
    for (const id of living) max = Math.max(max, dist[id]);
    const losers = living.filter((id) => dist[id] === max);
    e.revealed = true;
    e.result = {
      answer: e.answer,
      distances: dist,
      guesses: { ...e.guesses },
      loserIds: losers,
    };
    // Gleichstand an der Spitze -> neue Schätzfrage nötig.
    e.tie = losers.length !== 1;
    room.lastActivity = Date.now();
  }

  confirmEstimate(room) {
    const h = room.hearts;
    const e = h.estimate;
    if (h.phase !== PHASES.ESTIMATE || !e || !e.revealed) throw new Error('Erst die Schätzfrage auflösen.');
    if (e.tie) throw new Error('Gleichstand – bitte eine weitere Schätzfrage stellen.');
    const loserId = e.result.loserIds[0];
    h.hearts[loserId] = Math.max(0, this._heartsOf(room, loserId) - 1);
    const eliminatedId = h.hearts[loserId] <= 0 ? loserId : null;
    h.lastResult = { loserId, eliminatedId, estimate: true };
    h.estimate = null;
    if (!this._checkFinaleOrFinished(room)) h.phase = PHASES.ROUND_END;
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
      results: { [finalists[0]]: [], [finalists[1]]: [] }, // richtig/falsch pro Frage
      revealIndex: 0, // wie viele Fragen in der Auflösung schon gezeigt wurden
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
    this._armTimerForQuestion(room);
  }

  finaleAnswer(room, correct) {
    const h = room.hearts;
    const f = h.finale;
    if (h.phase !== PHASES.FINALE || !f || f.stage !== 'answering') {
      throw new Error('Aktuell keine Finale-Frage offen.');
    }
    const active = f.finalists[f.finalistIndex];
    if (correct === true) f.scores[active] = (f.scores[active] || 0) + 1;
    (f.results[active] = f.results[active] || []).push(correct === true);
    f.qIndex += 1;

    if (f.qIndex < f.blockSize) {
      this._setFinaleQuestion(room);
    } else if (f.finalistIndex === 0) {
      f.finalistIndex = 1;
      f.qIndex = 0;
      this._setFinaleQuestion(room);
    } else {
      // beide durch -> spannende Auflösung (Frage für Frage)
      f.stage = 'reveal';
      f.revealIndex = 0;
      h.currentQuestion = null;
      h.activePlayerId = null;
      this.stopTimer(room);
    }
    room.lastActivity = Date.now();
  }

  /** Admin deckt in der Auflösung die nächste Finale-Frage auf. */
  finaleRevealNext(room) {
    const h = room.hearts;
    const f = h.finale;
    if (h.phase !== PHASES.FINALE || !f || f.stage !== 'reveal') throw new Error('Jetzt nicht möglich.');
    if (f.revealIndex < f.blockSize) f.revealIndex += 1;
    room.lastActivity = Date.now();
  }

  _finaleFullyRevealed(room) {
    const f = room.hearts.finale;
    return f && f.stage === 'reveal' && (f.revealIndex || 0) >= f.blockSize;
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
    if (!this._finaleFullyRevealed(room)) throw new Error('Erst alle Fragen aufdecken.');
    if (!this._finaleTie(room)) throw new Error('Es gibt keinen Gleichstand.');
    const [a, b] = f.finalists;
    f.questions = this._drawFinaleQuestions(room, this.finaleTiebreakQuestions);
    f.blockSize = f.questions.length;
    f.finalistIndex = 0;
    f.qIndex = 0;
    f.block += 1;
    f.results = { [a]: [], [b]: [] };
    f.revealIndex = 0;
    f.stage = 'answering';
    this._setFinaleQuestion(room);
    room.lastActivity = Date.now();
  }

  finaleFinish(room) {
    const h = room.hearts;
    const f = h.finale;
    if (h.phase !== PHASES.FINALE || f.stage !== 'reveal') throw new Error('Jetzt nicht möglich.');
    if (!this._finaleFullyRevealed(room)) throw new Error('Erst alle Fragen aufdecken.');
    if (this._finaleTie(room)) throw new Error('Gleichstand – es müssen weitere Fragen gespielt werden.');
    const [a, b] = f.finalists;
    h.winnerId = (f.scores[a] || 0) > (f.scores[b] || 0) ? a : b;
    h.phase = PHASES.FINISHED;
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Runden-Steuerung
  skipRound(room) {
    const h = room.hearts;
    if (![PHASES.QUESTION, PHASES.VOTING, PHASES.REVEAL, PHASES.ESTIMATE].includes(h.phase)) {
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
    h.estimate = null;
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
      // In der Abstimmung: perfekte Spieler (alle Fragen richtig) sind immun.
      immune: h.phase === PHASES.VOTING && this._heartsOf(room, id) > 0 && this._perfect(room, id),
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
      solution: a.solution || '',
      text: a.text,
      correct: a.correct,
    }));

    // Timer für alle sichtbar.
    base.timer = this._timerView(h);

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
      const amFinalist = viewer.role === 'player' && f.finalists.includes(meId);
      const revealing = f.stage === 'reveal';
      const ri = f.revealIndex || 0;
      const fully = revealing && ri >= f.blockSize;
      const res = f.results || { [a]: [], [b]: [] };
      const sumUpTo = (id, n) => (res[id] || []).slice(0, n).filter(Boolean).length;

      let scores = null;
      let revealLog = null;
      if (revealing) {
        // Während der Auflösung: laufender Punktestand nur bis zur aufgedeckten Frage.
        scores = { [a]: sumUpTo(a, ri), [b]: sumUpTo(b, ri) };
        revealLog = [];
        for (let i = 0; i < ri; i++) {
          revealLog.push({
            no: i + 1,
            question: (f.questions[i] || {}).text || '',
            answer: (f.questions[i] || {}).answer || '',
            r0: !!(res[a] || [])[i],
            r1: !!(res[b] || [])[i],
          });
        }
      } else {
        // Antwort-Phase: Punkte für Admin & Zuschauer sichtbar, für Finalisten verborgen.
        scores = isAdmin || !amFinalist ? { ...f.scores } : null;
      }
      const tie = fully && scores[a] === scores[b];

      base.finale = {
        finalists: f.finalists,
        finalistNames: f.finalists.map((id) => this._name(room, id)),
        activeId: h.phase === PHASES.FINALE && f.stage === 'answering' ? h.activePlayerId : null,
        stage: f.stage,
        block: f.block,
        blockSize: f.blockSize,
        questionNo: Math.min(f.qIndex + 1, f.blockSize),
        revealIndex: revealing ? ri : null,
        fullyRevealed: fully,
        revealLog,
        tie,
        scores,
        leaderId: fully && !tie ? (scores[a] > scores[b] ? a : b) : null,
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
      base.timerAutoStart = h.timerAutoStart;
      // Schätzfrage: Admin sieht alles (inkl. Lösung, Tipps).
      if (h.estimate) {
        base.estimate = {
          question: h.estimate.question,
          answer: h.estimate.answer,
          guessCount: Object.keys(h.estimate.guesses).length,
          livingCount: this._living(room).length,
          revealed: h.estimate.revealed,
          tie: h.estimate.tie,
          result: h.estimate.result
            ? {
                ...h.estimate.result,
                byPlayer: this._living(room).map((id) => ({
                  id,
                  name: this._name(room, id),
                  guess: id in h.estimate.guesses ? h.estimate.guesses[id] : null,
                  distance: h.estimate.result.distances[id],
                  loser: h.estimate.result.loserIds.includes(id),
                })),
              }
            : null,
        };
      }
    } else {
      base.myId = meId;
      base.myHearts = this._heartsOf(room, meId);
      base.myEliminated = this._heartsOf(room, meId) <= 0;
      // Aktuelle Frage für ALLE sichtbar (Text, ohne Lösung); Hervorhebung, wenn man dran ist.
      if (h.currentQuestion) {
        base.currentQuestionText = h.currentQuestion.text;
        base.currentQuestionFor = h.currentQuestion.forPlayerId;
        base.currentQuestionForName = this._name(room, h.currentQuestion.forPlayerId);
        if (h.currentQuestion.forPlayerId === meId) base.myQuestion = h.currentQuestion.text;
      }
      if (h.phase === PHASES.VOTING) {
        base.myVote = h.votes[meId] || null;
        base.canVote = this._voters(room).includes(meId);
        base.votableIds = base.canVote ? this._candidateIds(room).filter((id) => id !== meId) : [];
      }
      // Schätzfrage: Spieler sehen die Frage (Lösung erst bei Auflösung).
      if (h.estimate) {
        base.estimate = {
          question: h.estimate.question,
          revealed: h.estimate.revealed,
          tie: h.estimate.tie,
          answer: h.estimate.revealed ? h.estimate.answer : null,
          myGuess: meId in h.estimate.guesses ? h.estimate.guesses[meId] : null,
          canGuess: !!h.estimate.question && !h.estimate.revealed && this._heartsOf(room, meId) > 0,
          result: h.estimate.revealed && h.estimate.result
            ? {
                loserIds: h.estimate.result.loserIds,
                byPlayer: this._living(room).map((id) => ({
                  id,
                  name: this._name(room, id),
                  guess: id in h.estimate.guesses ? h.estimate.guesses[id] : null,
                  distance: h.estimate.result.distances[id],
                  loser: h.estimate.result.loserIds.includes(id),
                })),
              }
            : null,
        };
      }
    }

    return base;
  }
}

export { PHASES as HEARTS_PHASES };
