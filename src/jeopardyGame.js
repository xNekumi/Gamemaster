import { randomUUID } from 'node:crypto';

/**
 * "Quiz-Duell" – ein Jeopardy-artiges Team-Spiel.
 *
 * Ablauf:
 *   'lobby'    -> Admin legt Teams an (mit Farbe), Spieler treten bei und
 *                 dürfen ihren Teamnamen ändern.
 *   'board'    -> Spielbrett (mehrere Kategorien × Fragen mit Punkten). Die
 *                 Teams wählen reihum eine Frage. Vor der Auswahl können die
 *                 "Alles-oder-Nichts"- und "Kaffeepause"-Joker eingesetzt werden.
 *   'question' -> Die gewählte Frage ist offen. Der Game-Master startet/stoppt
 *                 einen Timer und wertet richtig/falsch. Bei falsch öffnet sich
 *                 der Buzzer für ein Klau-Team.
 *   'finished' -> Nach dem letzten Board: Siegerehrung.
 *
 * Punkte:  V = Frage-Punkte × Board-Multiplikator.
 *   richtig +V, falsch −½V. "Kein-Risiko" hebt den Abzug auf. "Alles-oder-Nichts"
 *   macht richtig +2V und falsch −2V. Punkte dürfen negativ werden.
 */

const PHASES = Object.freeze({
  LOBBY: 'lobby',
  BOARD: 'board',
  QUESTION: 'question',
  FINISHED: 'finished',
});

// Deutlich unterscheidbare Team-Farben (in Zuweisungsreihenfolge).
const TEAM_COLORS = [
  '#ef4444', // rot
  '#3b82f6', // blau
  '#22c55e', // grün
  '#f59e0b', // orange
  '#a855f7', // violett
  '#ec4899', // pink
  '#14b8a6', // türkis
  '#eab308', // gelb
];

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class JeopardyGame {
  constructor({ data, config }) {
    // data: { boards: [ { name, categories: [ { name, questions: [ {points, question, answer} ] } ] } ] }
    // Unterstützt beide Feldnamen: points/value und question/prompt. Pro Board
    // kann optional ein "multiplier" gesetzt sein (sonst greift die Admin-Regel).
    this.rawBoards = (data && Array.isArray(data.boards) ? data.boards : []).map((b) => ({
      name: b.name || '',
      multiplier: typeof b.multiplier === 'number' ? b.multiplier : undefined,
      categories: (b.categories || []).map((c) => ({
        name: c.name || '',
        questions: (c.questions || []).map((q) => ({
          points: Number(q.points ?? q.value) || 0,
          question: q.question || q.q || q.prompt || '',
          answer: q.answer || q.a || '',
        })),
      })),
    }));
    this.defaultMultiplier = config?.jeopardy?.boardMultiplier ?? 2;
    this.defaultTimer = config?.jeopardy?.timerSeconds ?? 30;
    this.startJokers = config?.jeopardy?.jokers ?? { noRisk: 1, allOrNothing: 1, coffee: 1 };
    this.shuffleCategories = config?.jeopardy?.shuffleCategories !== false;
  }

  initialState() {
    return {
      phase: PHASES.LOBBY,
      teams: [], // { id, name, color, playerIds:[], score, jokers:{...}, answered, armedAoN }
      teamOrder: [],
      turnIndex: 0,
      boards: null, // wird beim Start aus rawBoards aufgebaut (mit done-Status)
      boardIndex: 0,
      boardMultiplier: this.defaultMultiplier,
      timerSeconds: this.defaultTimer,
      pendingSelection: null, // { teamId, bi, ci, qi } – wartet auf Admin-Bestätigung
      pendingJokers: [], // [{ id, teamId, type, targetTeamId }] – warten auf Admin-Bestätigung
      coffeeTargets: [], // teamIds, die bei der nächsten Frage nicht buzzern dürfen
      current: null, // offene Frage (siehe _openQuestion)
      winnerTeamId: null,
    };
  }

  // ---------------------------------------------------------- Hilfen
  _player(room, id) {
    for (const p of room.players.values()) if (p.id === id) return p;
    return null;
  }
  _name(room, id) {
    return this._player(room, id)?.name || 'Unbekannt';
  }
  _exists(room, id) {
    return !!this._player(room, id);
  }
  _team(room, teamId) {
    return room.jeopardy.teams.find((t) => t.id === teamId) || null;
  }
  _teamOfPlayer(room, playerId) {
    return room.jeopardy.teams.find((t) => t.playerIds.includes(playerId)) || null;
  }
  _playableTeams(room) {
    return room.jeopardy.teams.filter(
      (t) => t.playerIds.length >= 1 && t.playerIds.some((id) => this._exists(room, id))
    );
  }
  _round(n) {
    return Math.round(n);
  }

  // ---------------------------------------------------------- Lobby / Teams
  addTeam(room, name) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.LOBBY) throw new Error('Teams können nur in der Lobby geändert werden.');
    const idx = j.teams.length;
    const color = TEAM_COLORS[idx % TEAM_COLORS.length];
    j.teams.push({
      id: randomUUID(),
      name: String(name || '').trim().slice(0, 24) || `Team ${idx + 1}`,
      color,
      playerIds: [],
      score: 0,
      jokers: { ...this.startJokers },
      answered: 0,
      armedAoN: false,
    });
    room.lastActivity = Date.now();
  }

  removeTeam(room, teamId) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.LOBBY) throw new Error('Teams können nur in der Lobby geändert werden.');
    j.teams = j.teams.filter((t) => t.id !== teamId);
    room.lastActivity = Date.now();
  }

  renameTeam(room, teamId, name) {
    const t = this._team(room, teamId);
    if (!t) return;
    const clean = String(name || '').trim().slice(0, 24);
    if (clean) t.name = clean;
    room.lastActivity = Date.now();
  }

  setTeamColor(room, teamId, color) {
    const t = this._team(room, teamId);
    if (!t) return;
    if (/^#[0-9a-fA-F]{6}$/.test(color)) t.color = color;
    room.lastActivity = Date.now();
  }

  assignPlayer(room, playerId, teamId) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.LOBBY) throw new Error('Teams können nur in der Lobby geändert werden.');
    if (!this._exists(room, playerId)) throw new Error('Spieler nicht gefunden.');
    for (const t of j.teams) t.playerIds = t.playerIds.filter((id) => id !== playerId);
    if (teamId) {
      const team = this._team(room, teamId);
      if (!team) throw new Error('Team nicht gefunden.');
      team.playerIds.push(playerId);
    }
    room.lastActivity = Date.now();
  }

  /** Spieler benennt sein eigenes Team um. */
  playerRenameTeam(room, player, name) {
    const t = this._teamOfPlayer(room, player.id);
    if (!t) return { ok: false, error: 'Du bist in keinem Team.' };
    if (room.jeopardy.phase !== PHASES.LOBBY) return { ok: false, error: 'Der Name kann nur in der Lobby geändert werden.' };
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return { ok: false, error: 'Der Name darf nicht leer sein.' };
    t.name = clean;
    room.lastActivity = Date.now();
    return { ok: true };
  }

  setBoardMultiplier(room, m) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.LOBBY) throw new Error('Nur in der Lobby einstellbar.');
    const v = Number(m);
    j.boardMultiplier = Number.isFinite(v) && v > 0 ? Math.min(10, v) : 2;
    room.lastActivity = Date.now();
  }
  setTimerSeconds(room, s) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.LOBBY) throw new Error('Nur in der Lobby einstellbar.');
    const v = Math.floor(Number(s));
    j.timerSeconds = Number.isFinite(v) && v >= 5 ? Math.min(600, v) : this.defaultTimer;
    room.lastActivity = Date.now();
  }

  removePlayer(room, playerId) {
    const j = room.jeopardy;
    if (!j) return;
    for (const t of j.teams) t.playerIds = t.playerIds.filter((id) => id !== playerId);
    room.lastActivity = Date.now();
  }
  syncTeams(room) {
    const j = room.jeopardy;
    if (!j) return;
    for (const t of j.teams) t.playerIds = t.playerIds.filter((id) => this._exists(room, id));
  }

  // ---------------------------------------------------------- Spielstart
  startGame(room) {
    const j = room.jeopardy;
    if (this._playableTeams(room).length < 2) {
      throw new Error('Es werden mindestens 2 Teams mit je einem Spieler benötigt.');
    }
    if (!this.rawBoards.length) throw new Error('Keine Fragen/Boards vorhanden.');
    // Boards mit Laufzeit-Status aufbauen. Kategorien-Reihenfolge wird optional
    // durchgemischt; die Fragen einer Kategorie werden nach Punkten sortiert.
    j.boards = this.rawBoards.map((b) => {
      const cats = b.categories.map((c) => ({
        name: c.name,
        questions: [...c.questions]
          .sort((x, y) => x.points - y.points)
          .map((q) => ({
            id: randomUUID(),
            points: q.points,
            question: q.question,
            answer: q.answer,
            done: false,
          })),
      }));
      return {
        name: b.name,
        multiplier: b.multiplier, // kann undefined sein -> Admin-Regel greift
        categories: this.shuffleCategories ? shuffle(cats) : cats,
      };
    });
    j.boardIndex = 0;
    for (const t of j.teams) {
      t.score = 0;
      t.answered = 0;
      t.armedAoN = false;
      t.jokers = { ...this.startJokers };
    }
    j.teamOrder = shuffle(this._playableTeams(room).map((t) => t.id));
    j.turnIndex = 0;
    j.pendingSelection = null;
    j.pendingJokers = [];
    j.coffeeTargets = [];
    j.current = null;
    j.winnerTeamId = null;
    j.phase = PHASES.BOARD;
    room.lastActivity = Date.now();
  }

  _currentBoard(room) {
    const j = room.jeopardy;
    return j.boards ? j.boards[j.boardIndex] : null;
  }
  _boardMultiplierFor(room) {
    // Eigener Board-Multiplikator aus der Datei hat Vorrang; sonst: erstes Board
    // ×1, jedes weitere ×(Admin-Multiplikator).
    const b = this._currentBoard(room);
    if (b && typeof b.multiplier === 'number') return b.multiplier;
    return room.jeopardy.boardIndex === 0 ? 1 : room.jeopardy.boardMultiplier;
  }
  _activeTeamId(room) {
    const j = room.jeopardy;
    return j.teamOrder[j.turnIndex] || null;
  }
  _boardComplete(room) {
    const b = this._currentBoard(room);
    if (!b) return false;
    return b.categories.every((c) => c.questions.every((q) => q.done));
  }

  // ---------------------------------------------------------- Frage auswählen
  /** Aktives Team wählt eine Kachel -> wartet auf Admin-Bestätigung. */
  selectQuestion(room, player, bi, ci, qi) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.BOARD) return { ok: false, error: 'Aktuell kann keine Frage gewählt werden.' };
    const team = this._teamOfPlayer(room, player.id);
    if (!team || team.id !== this._activeTeamId(room)) return { ok: false, error: 'Dein Team ist gerade nicht am Zug.' };
    if (j.pendingSelection) return { ok: false, error: 'Es wartet bereits eine Auswahl auf Bestätigung.' };
    const board = this._currentBoard(room);
    if (bi !== j.boardIndex) return { ok: false, error: 'Falsches Board.' };
    const q = board?.categories?.[ci]?.questions?.[qi];
    if (!q) return { ok: false, error: 'Frage nicht gefunden.' };
    if (q.done) return { ok: false, error: 'Diese Frage ist schon gespielt.' };
    j.pendingSelection = { teamId: team.id, bi, ci, qi };
    room.lastActivity = Date.now();
    return { ok: true };
  }

  /** Admin bestätigt die Auswahl -> Frage öffnet sich. */
  confirmSelection(room) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.BOARD || !j.pendingSelection) throw new Error('Keine Auswahl zu bestätigen.');
    const { teamId, ci, qi } = j.pendingSelection;
    this._openQuestion(room, teamId, ci, qi);
    j.pendingSelection = null;
    room.lastActivity = Date.now();
  }

  cancelSelection(room) {
    room.jeopardy.pendingSelection = null;
    room.lastActivity = Date.now();
  }

  /** Admin öffnet direkt eine Frage (z. B. ohne Spielerauswahl). */
  openQuestion(room, ci, qi) {
    const j = room.jeopardy;
    if (j.phase !== PHASES.BOARD) throw new Error('Aktuell kann keine Frage geöffnet werden.');
    this._openQuestion(room, this._activeTeamId(room), ci, qi);
    j.pendingSelection = null;
    room.lastActivity = Date.now();
  }

  _openQuestion(room, teamId, ci, qi) {
    const j = room.jeopardy;
    const board = this._currentBoard(room);
    const q = board?.categories?.[ci]?.questions?.[qi];
    if (!q) throw new Error('Frage nicht gefunden.');
    if (q.done) throw new Error('Diese Frage ist schon gespielt.');
    const team = this._team(room, teamId);
    const value = q.points * this._boardMultiplierFor(room);
    j.current = {
      ci,
      qi,
      qid: q.id,
      category: board.categories[ci].name,
      points: q.points,
      value,
      question: q.question,
      answer: q.answer,
      answeringTeamId: teamId, // Team, das gerade antworten darf
      stage: 'answering', // 'answering' -> 'stealOpen' -> 'stealAnswering' -> 'done'
      attemptedTeamIds: [], // Teams, die schon geantwortet haben
      buzzedTeamId: null,
      aonTeamId: team && team.armedAoN ? teamId : null, // Alles-oder-Nichts aktiv?
      noRiskTeamId: null, // Kein-Risiko für das aktuell antwortende Team?
      timerRunning: false,
      timerEndsAt: null,
      timerRemainingMs: (j.timerSeconds || this.defaultTimer) * 1000,
      lastOutcome: null, // {teamId, correct, delta} für die Animation
    };
    if (team) team.armedAoN = false; // verbraucht
    j.phase = PHASES.QUESTION;
  }

  // ---------------------------------------------------------- Timer
  startTimer(room) {
    const c = room.jeopardy.current;
    if (!c) return;
    if (!c.timerRunning) {
      c.timerEndsAt = Date.now() + (c.timerRemainingMs ?? 0);
      c.timerRunning = true;
    }
    room.lastActivity = Date.now();
  }
  stopTimer(room) {
    const c = room.jeopardy.current;
    if (!c) return;
    if (c.timerRunning) {
      c.timerRemainingMs = Math.max(0, (c.timerEndsAt || 0) - Date.now());
      c.timerRunning = false;
      c.timerEndsAt = null;
    }
    room.lastActivity = Date.now();
  }
  resetTimer(room) {
    const c = room.jeopardy.current;
    if (!c) return;
    c.timerRunning = false;
    c.timerEndsAt = null;
    c.timerRemainingMs = (room.jeopardy.timerSeconds || this.defaultTimer) * 1000;
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Buzzer (Klauen)
  buzz(room, player) {
    const j = room.jeopardy;
    const c = j.current;
    if (!c || c.stage !== 'stealOpen') return { ok: false, error: 'Der Buzzer ist gerade nicht offen.' };
    const team = this._teamOfPlayer(room, player.id);
    if (!team) return { ok: false, error: 'Du bist in keinem Team.' };
    if (team.id === c.answeringTeamId) return { ok: false, error: 'Dein Team ist bereits dran.' };
    if (c.attemptedTeamIds.includes(team.id)) return { ok: false, error: 'Dein Team hatte schon einen Versuch.' };
    if (j.coffeeTargets.includes(team.id)) return { ok: false, error: 'Kaffeepause – dein Team darf nicht buzzern.' };
    // Nur ein Klau-Versuch: erstes Team schnappt sich die Frage.
    c.buzzedTeamId = team.id;
    c.answeringTeamId = team.id;
    c.stage = 'stealAnswering';
    c.noRiskTeamId = null; // neues Team -> Kein-Risiko neu setzbar
    // Timer für den Klau-Versuch zurücksetzen.
    this.resetTimer(room);
    room.lastActivity = Date.now();
    return { ok: true };
  }

  /** Admin öffnet den Buzzer manuell (falls nötig). */
  openSteal(room) {
    const c = room.jeopardy.current;
    if (!c) return;
    c.stage = 'stealOpen';
    this.resetTimer(room);
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Auswertung
  judge(room, correct) {
    const j = room.jeopardy;
    const c = j.current;
    if (!c) throw new Error('Keine offene Frage.');
    if (!['answering', 'stealAnswering'].includes(c.stage)) {
      throw new Error('Aktuell kann nicht gewertet werden.');
    }
    const team = this._team(room, c.answeringTeamId);
    if (!team) throw new Error('Kein antwortendes Team.');

    this.stopTimer(room);
    const aon = c.aonTeamId === team.id;
    const noRisk = c.noRiskTeamId === team.id;
    let delta = 0;
    if (correct) {
      delta = aon ? 2 * c.value : c.value;
    } else {
      if (noRisk) delta = 0;
      else delta = aon ? -2 * c.value : -this._round(c.value / 2);
    }
    team.score += delta;
    if (correct) team.answered += 1;
    c.attemptedTeamIds.push(team.id);
    c.lastOutcome = { teamId: team.id, teamName: team.name, correct, delta, aon, noRisk };

    if (correct) {
      this._closeQuestion(room);
    } else {
      // Falsch: genau ein Klau-Versuch möglich (erstes anderes Team).
      const stealable = this._eligibleStealTeams(room);
      if (c.stage === 'answering' && stealable.length > 0) {
        c.stage = 'stealOpen';
        c.noRiskTeamId = null;
        this.resetTimer(room);
      } else {
        // War schon ein Klau-Versuch oder niemand mehr übrig -> Frage zu.
        this._closeQuestion(room);
      }
    }
    room.lastActivity = Date.now();
    return { correct, delta };
  }

  _eligibleStealTeams(room) {
    const j = room.jeopardy;
    const c = j.current;
    return this._playableTeams(room).filter(
      (t) =>
        t.id !== c.answeringTeamId &&
        !c.attemptedTeamIds.includes(t.id) &&
        !j.coffeeTargets.includes(t.id)
    );
  }

  /** Admin schließt die Frage ohne (weitere) Wertung. */
  closeQuestion(room) {
    const c = room.jeopardy.current;
    if (!c) return;
    this._closeQuestion(room);
    room.lastActivity = Date.now();
  }

  _closeQuestion(room) {
    const j = room.jeopardy;
    const c = j.current;
    if (!c) return;
    // Frage als gespielt markieren.
    const board = this._currentBoard(room);
    const q = board?.categories?.[c.ci]?.questions?.[c.qi];
    if (q) q.done = true;
    // Kaffeepause galt nur für diese Frage.
    j.coffeeTargets = [];
    j.current = null;
    j.phase = PHASES.BOARD;

    if (this._boardComplete(room)) {
      if (j.boardIndex < j.boards.length - 1) {
        j.boardIndex += 1; // nächstes Board
        j.turnIndex = (j.turnIndex + 1) % j.teamOrder.length;
      } else {
        this._finish(room);
        return;
      }
    } else {
      // Reihum: nächstes Team wählt.
      j.turnIndex = (j.turnIndex + 1) % j.teamOrder.length;
    }
  }

  _finish(room) {
    const j = room.jeopardy;
    const teams = this._playableTeams(room);
    let best = -Infinity;
    for (const t of teams) best = Math.max(best, t.score);
    const leaders = teams.filter((t) => t.score === best);
    j.winnerTeamId = leaders.length ? leaders[0].id : null;
    j.current = null;
    j.phase = PHASES.FINISHED;
    room.lastActivity = Date.now();
  }

  endGame(room) {
    this._finish(room);
  }

  backToLobby(room) {
    const j = room.jeopardy;
    j.phase = PHASES.LOBBY;
    j.boards = null;
    j.boardIndex = 0;
    j.turnIndex = 0;
    j.teamOrder = [];
    j.pendingSelection = null;
    j.pendingJokers = [];
    j.coffeeTargets = [];
    j.current = null;
    j.winnerTeamId = null;
    for (const t of j.teams) {
      t.score = 0;
      t.answered = 0;
      t.armedAoN = false;
      t.jokers = { ...this.startJokers };
    }
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Joker
  /** Spieler beantragt einen Joker -> wartet auf Admin-Bestätigung. */
  requestJoker(room, player, type, targetTeamId) {
    const j = room.jeopardy;
    const team = this._teamOfPlayer(room, player.id);
    if (!team) return { ok: false, error: 'Du bist in keinem Team.' };
    if (!['noRisk', 'allOrNothing', 'coffee'].includes(type)) return { ok: false, error: 'Unbekannter Joker.' };
    if ((team.jokers[type] || 0) <= 0) return { ok: false, error: 'Diesen Joker hat dein Team nicht mehr.' };
    if (j.pendingJokers.some((p) => p.teamId === team.id && p.type === type)) {
      return { ok: false, error: 'Joker-Antrag läuft bereits.' };
    }
    const err = this._jokerUsableError(room, team, type, targetTeamId);
    if (err) return { ok: false, error: err };
    j.pendingJokers.push({ id: randomUUID(), teamId: team.id, type, targetTeamId: targetTeamId || null });
    room.lastActivity = Date.now();
    return { ok: true };
  }

  _jokerUsableError(room, team, type, targetTeamId) {
    const j = room.jeopardy;
    const c = j.current;
    if (type === 'allOrNothing') {
      if (j.phase !== PHASES.BOARD) return 'Der Alles-oder-Nichts-Joker muss vor der Frage benutzt werden.';
      if (team.id !== this._activeTeamId(room)) return 'Nur das Team am Zug kann diesen Joker setzen.';
      if (team.armedAoN) return 'Joker ist bereits aktiv.';
    } else if (type === 'coffee') {
      if (j.phase !== PHASES.BOARD) return 'Der Kaffeepause-Joker muss vor der Frage benutzt werden.';
      if (!targetTeamId) return 'Bitte ein Zielteam wählen.';
      if (targetTeamId === team.id) return 'Du kannst deinen eigenen Joker nicht auf dich anwenden.';
      if (targetTeamId === this._activeTeamId(room)) return 'Das Team am Zug kann nicht kaffeepausiert werden.';
      if (!this._team(room, targetTeamId)) return 'Zielteam nicht gefunden.';
    } else if (type === 'noRisk') {
      if (j.phase !== PHASES.QUESTION || !c) return 'Der Kein-Risiko-Joker gilt nur bei einer offenen Frage.';
      if (team.id !== c.answeringTeamId) return 'Nur das antwortende Team kann diesen Joker setzen.';
      if (!['answering', 'stealAnswering'].includes(c.stage)) return 'Jetzt nicht einsetzbar.';
      if (c.noRiskTeamId === team.id) return 'Joker ist bereits aktiv.';
    }
    // Max. 1 Joker pro Team & Frage: prüfen, ob dieses Team schon einen auf diese Frage gelegt hat.
    if (c && c._jokerTeams && c._jokerTeams.includes(team.id)) {
      return 'Pro Frage darf dein Team nur einen Joker einsetzen.';
    }
    return null;
  }

  confirmJoker(room, reqId) {
    const j = room.jeopardy;
    const idx = j.pendingJokers.findIndex((p) => p.id === reqId);
    if (idx < 0) throw new Error('Joker-Antrag nicht gefunden.');
    const req = j.pendingJokers[idx];
    const team = this._team(room, req.teamId);
    if (!team || (team.jokers[req.type] || 0) <= 0) {
      j.pendingJokers.splice(idx, 1);
      throw new Error('Joker nicht mehr verfügbar.');
    }
    // Effekt anwenden
    if (req.type === 'allOrNothing') {
      team.armedAoN = true;
    } else if (req.type === 'coffee') {
      if (!j.coffeeTargets.includes(req.targetTeamId)) j.coffeeTargets.push(req.targetTeamId);
    } else if (req.type === 'noRisk') {
      if (j.current) {
        j.current.noRiskTeamId = team.id;
        (j.current._jokerTeams = j.current._jokerTeams || []).push(team.id);
      }
    }
    team.jokers[req.type] = (team.jokers[req.type] || 0) - 1;
    j.pendingJokers.splice(idx, 1);
    room.lastActivity = Date.now();
  }

  rejectJoker(room, reqId) {
    const j = room.jeopardy;
    j.pendingJokers = j.pendingJokers.filter((p) => p.id !== reqId);
    room.lastActivity = Date.now();
  }

  /** Admin gibt einem Team einen Joker zurück / verteilt neu. */
  adjustJoker(room, teamId, type, delta) {
    const team = this._team(room, teamId);
    if (!team || !['noRisk', 'allOrNothing', 'coffee'].includes(type)) return;
    team.jokers[type] = Math.max(0, Math.min(9, (team.jokers[type] || 0) + (Number(delta) || 0)));
    room.lastActivity = Date.now();
  }

  /** Admin nimmt aktive Joker-Effekte der laufenden Frage / des Zugs zurück. */
  clearJokerEffects(room) {
    const j = room.jeopardy;
    const c = j.current;
    if (c) {
      c.aonTeamId = null;
      c.noRiskTeamId = null;
    }
    for (const t of j.teams) t.armedAoN = false;
    j.coffeeTargets = [];
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Snapshot
  _timerView(c) {
    if (!c) return null;
    const total = (c.timerRemainingMs ?? 0);
    return {
      running: c.timerRunning,
      endsAt: c.timerRunning ? c.timerEndsAt : null,
      remainingMs: c.timerRunning ? Math.max(0, (c.timerEndsAt || 0) - Date.now()) : total,
    };
  }

  buildState(room, viewer) {
    const j = room.jeopardy;
    const isAdmin = viewer.role === 'admin';
    const meId = viewer.playerId;
    const myTeam = viewer.role === 'player' ? this._teamOfPlayer(room, meId) : null;

    const teams = j.teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      score: t.score,
      answered: t.answered,
      jokers: { ...t.jokers },
      armedAoN: t.armedAoN,
      isCurrent: this._activeTeamId(room) === t.id && j.phase !== PHASES.FINISHED,
      onCoffee: j.coffeeTargets.includes(t.id),
      players: t.playerIds
        .filter((id) => this._exists(room, id))
        .map((id) => ({ id, name: this._name(room, id) })),
    }));

    const base = {
      gameType: 'jeopardy',
      role: viewer.role,
      code: room.code,
      phase: j.phase,
      round: j.boardIndex + 1,
      boardCount: j.boards ? j.boards.length : this.rawBoards.length,
      boardMultiplier: j.boardMultiplier,
      timerSeconds: j.timerSeconds,
      teams,
      standings: [...teams].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
      activeTeamId: this._activeTeamId(room),
      playerCount: room.players.size,
    };
    if (myTeam) {
      base.myTeamId = myTeam.id;
      base.myTeamName = myTeam.name;
      base.myTeamColor = myTeam.color;
      base.myJokers = { ...myTeam.jokers };
    }

    if (j.phase === PHASES.LOBBY) {
      if (isAdmin) {
        const assigned = new Set(j.teams.flatMap((t) => t.playerIds));
        base.unassigned = [...room.players.values()]
          .filter((p) => !assigned.has(p.id))
          .map((p) => ({ id: p.id, name: p.name }));
        base.canStart = this._playableTeams(room).length >= 2;
      }
      return base;
    }

    if (j.phase === PHASES.FINISHED) {
      const wt = j.winnerTeamId ? this._team(room, j.winnerTeamId) : null;
      base.winnerTeamId = j.winnerTeamId;
      base.winnerTeamName = wt ? wt.name : null;
      base.winnerColor = wt ? wt.color : null;
      return base;
    }

    // Board-Ansicht (Kacheln)
    const board = this._currentBoard(room);
    base.boardName = board ? board.name : '';
    base.multiplierActive = this._boardMultiplierFor(room);
    base.board = board
      ? {
          categories: board.categories.map((c, ci) => ({
            name: c.name,
            questions: c.questions.map((q, qi) => ({
              ci,
              qi,
              points: q.points,
              value: q.points * this._boardMultiplierFor(room),
              done: q.done,
            })),
          })),
        }
      : null;

    if (isAdmin) {
      base.pendingSelection = j.pendingSelection
        ? { ...j.pendingSelection, teamName: this._team(room, j.pendingSelection.teamId)?.name }
        : null;
      base.pendingJokers = j.pendingJokers.map((p) => ({
        id: p.id,
        type: p.type,
        teamId: p.teamId,
        teamName: this._team(room, p.teamId)?.name,
        targetTeamId: p.targetTeamId,
        targetTeamName: p.targetTeamId ? this._team(room, p.targetTeamId)?.name : null,
      }));
    } else {
      base.canPick = j.phase === PHASES.BOARD && myTeam && myTeam.id === this._activeTeamId(room) && !j.pendingSelection;
      base.pendingSelectionMine = j.pendingSelection && myTeam && j.pendingSelection.teamId === myTeam.id;
    }

    // Offene Frage
    const c = j.current;
    if (c) {
      const answeringTeam = this._team(room, c.answeringTeamId);
      base.current = {
        category: c.category,
        points: c.points,
        value: c.value,
        question: c.question,
        stage: c.stage,
        answeringTeamId: c.answeringTeamId,
        answeringTeamName: answeringTeam ? answeringTeam.name : '',
        answeringTeamColor: answeringTeam ? answeringTeam.color : null,
        aonTeamId: c.aonTeamId,
        noRiskTeamId: c.noRiskTeamId,
        timer: this._timerView(c),
        lastOutcome: c.lastOutcome,
        // Antwort nur für den Admin.
        answer: isAdmin ? c.answer : undefined,
      };
      if (!isAdmin && myTeam) {
        base.current.iAmAnswering = c.answeringTeamId === myTeam.id;
        base.current.canBuzz =
          c.stage === 'stealOpen' &&
          myTeam.id !== c.answeringTeamId &&
          !c.attemptedTeamIds.includes(myTeam.id) &&
          !j.coffeeTargets.includes(myTeam.id);
        base.current.canNoRisk =
          ['answering', 'stealAnswering'].includes(c.stage) &&
          c.answeringTeamId === myTeam.id &&
          c.noRiskTeamId !== myTeam.id &&
          (myTeam.jokers.noRisk || 0) > 0 &&
          !(c._jokerTeams || []).includes(myTeam.id);
      }
    }

    return base;
  }
}

export { PHASES as JEOPARDY_PHASES };
