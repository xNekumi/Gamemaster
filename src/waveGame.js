import { randomUUID } from 'node:crypto';

/**
 * "Wellenlänge" (Wavelength-artiges Team-Spiel)
 *
 * Zwei Spieler bilden ein Team. Pro Runde ist ein Team dran; darin gibt ein
 * Spieler (Hinweisgeber) einen Hinweis, der andere (Ratender) rät.
 *
 * Ablauf einer Runde (admin-gesteuert):
 *   'clue'   -> Es gibt eine Kategorie mit einer Skala 0–10 (0 und 10 sind
 *               beschriftet). Der Hinweisgeber sieht eine geheime Zielzahl und
 *               tippt EIN Wort als Hinweis.
 *   'guess'  -> Der Ratende sieht den Hinweis + Skala und tippt, welche Zahl
 *               er vermutet. Die Zielzahl bleibt für ihn verborgen.
 *   'reveal' -> Der Admin deckt auf: Zielzahl, Tipp, Abstand und Punkte werden
 *               für alle sichtbar. Punkte: 0 daneben = 3, 1 daneben = 1,
 *               ab 2 daneben = 0.
 *   danach   -> Reihum ist das nächste Team dran. Die Rolle im Team wechselt
 *               jede Runde. Erreicht ein Team das Punkteziel, wird die laufende
 *               Runde fair zu Ende gespielt (alle Teams gleich oft dran), dann
 *               gewinnt die höchste Punktzahl.
 */

const PHASES = Object.freeze({
  LOBBY: 'lobby',
  CLUE: 'clue',
  GUESS: 'guess',
  REVEAL: 'reveal',
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

export class WaveGame {
  constructor({ categories, config }) {
    // Kategorien: { topic, low, high }
    this.categories = (categories || []).map((c, i) => ({
      id: i,
      topic: c.topic || c.category || c.name || '',
      low: c.low ?? c.min ?? c[0] ?? '',
      high: c.high ?? c.max ?? c[10] ?? '',
    }));
    this.scaleMax = config?.wave?.scaleMax ?? 10;
    this.defaultPointsToWin = config?.wave?.pointsToWin ?? 10;
  }

  initialState() {
    return {
      phase: PHASES.LOBBY,
      round: 0,
      teams: [], // { id, name, playerIds:[], score, clueIdx }
      teamOrder: [], // team-IDs in Spielreihenfolge
      turnIndex: 0,
      current: null, // aktuelle Runde (siehe _beginTurn)
      pointsToWin: this.defaultPointsToWin,
      scaleMax: this.scaleMax,
      usedCategoryIds: [],
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
  _teamById(room, teamId) {
    return room.wave.teams.find((t) => t.id === teamId) || null;
  }
  _teamOfPlayer(room, playerId) {
    return room.wave.teams.find((t) => t.playerIds.includes(playerId)) || null;
  }
  /** Teams, die mindestens 2 vorhandene Spieler haben (spielfähig). */
  _fullTeams(room) {
    return room.wave.teams.filter(
      (t) => t.playerIds.length >= 2 && t.playerIds.every((id) => this._exists(room, id))
    );
  }

  // ---------------------------------------------------------- Lobby / Teams
  addTeam(room) {
    const w = room.wave;
    if (w.phase !== PHASES.LOBBY) throw new Error('Teams können nur in der Lobby geändert werden.');
    const n = w.teams.length + 1;
    w.teams.push({ id: randomUUID(), name: `Team ${n}`, playerIds: [], score: 0, clueIdx: 0 });
    room.lastActivity = Date.now();
  }

  removeTeam(room, teamId) {
    const w = room.wave;
    if (w.phase !== PHASES.LOBBY) throw new Error('Teams können nur in der Lobby geändert werden.');
    w.teams = w.teams.filter((t) => t.id !== teamId);
    room.lastActivity = Date.now();
  }

  renameTeam(room, teamId, name) {
    const t = this._teamById(room, teamId);
    if (!t) return;
    const clean = String(name || '').trim().slice(0, 24);
    if (clean) t.name = clean;
    room.lastActivity = Date.now();
  }

  /** Weist einen Spieler einem Team zu (teamId=null -> ohne Team). */
  assignPlayer(room, playerId, teamId) {
    const w = room.wave;
    if (w.phase !== PHASES.LOBBY) throw new Error('Teams können nur in der Lobby geändert werden.');
    if (!this._exists(room, playerId)) throw new Error('Spieler nicht gefunden.');
    // Aus allen Teams entfernen
    for (const t of w.teams) t.playerIds = t.playerIds.filter((id) => id !== playerId);
    if (teamId) {
      const team = this._teamById(room, teamId);
      if (!team) throw new Error('Team nicht gefunden.');
      if (team.playerIds.length >= 8) throw new Error('Maximal 8 Spieler pro Team.');
      team.playerIds.push(playerId);
    }
    room.lastActivity = Date.now();
  }

  setPointsToWin(room, n) {
    const w = room.wave;
    if (w.phase !== PHASES.LOBBY) throw new Error('Das Punkteziel kann nur in der Lobby geändert werden.');
    const v = Math.max(1, Math.min(100, Math.floor(Number(n) || 0)));
    w.pointsToWin = v;
    room.lastActivity = Date.now();
  }

  /** Entfernt einen Spieler aus allen Teams (bei Kick/Leave). */
  removePlayer(room, playerId) {
    const w = room.wave;
    if (!w) return;
    for (const t of w.teams) t.playerIds = t.playerIds.filter((id) => id !== playerId);
    room.lastActivity = Date.now();
  }

  /** Platzhalter, damit die Aufruf-Konvention wie bei Hearts passt. */
  syncTeams(room) {
    const w = room.wave;
    if (!w) return;
    for (const t of w.teams) t.playerIds = t.playerIds.filter((id) => this._exists(room, id));
  }

  // ---------------------------------------------------------- Spielstart
  startGame(room) {
    const w = room.wave;
    const full = this._fullTeams(room);
    if (full.length < 2) {
      throw new Error('Es werden mindestens 2 vollständige Teams (je 2 Spieler) benötigt.');
    }
    for (const t of w.teams) {
      t.score = 0;
      t.clueIdx = 0;
    }
    w.teamOrder = shuffle(full.map((t) => t.id));
    w.turnIndex = 0;
    w.round = 0;
    w.usedCategoryIds = [];
    w.winnerTeamId = null;
    this._beginTurn(room);
    room.lastActivity = Date.now();
  }

  _drawCategory(room) {
    const w = room.wave;
    let pool = this.categories.filter((c) => !w.usedCategoryIds.includes(c.id));
    if (!pool.length) {
      w.usedCategoryIds = [];
      pool = this.categories;
    }
    if (!pool.length) return { id: -1, topic: '—', low: '0', high: '10' };
    const c = pool[Math.floor(Math.random() * pool.length)];
    w.usedCategoryIds.push(c.id);
    return c;
  }

  _beginTurn(room) {
    const w = room.wave;
    // Nächstes spielfähiges Team ab turnIndex finden.
    const order = w.teamOrder;
    let scanned = 0;
    while (scanned < order.length) {
      const teamId = order[w.turnIndex];
      const team = this._teamById(room, teamId);
      if (team && team.playerIds.length >= 2 && team.playerIds.every((id) => this._exists(room, id))) {
        break;
      }
      w.turnIndex = (w.turnIndex + 1) % order.length;
      scanned++;
    }
    if (scanned >= order.length) {
      // Kein spielfähiges Team mehr -> beenden.
      this._finish(room);
      return;
    }

    const team = this._teamById(room, order[w.turnIndex]);
    // Rollen rotieren durch alle Team-Mitglieder. Bei >2 Spielern gibt es
    // mehrere Ratende – aber nur einer (guesserId) gibt den Tipp ab.
    const n = team.playerIds.length;
    const clueGiverId = team.playerIds[team.clueIdx % n];
    const guesserId = team.playerIds[(team.clueIdx + 1) % n];
    team.clueIdx += 1; // Rollen wechseln bei der nächsten Runde des Teams

    const cat = this._drawCategory(room);
    const target = Math.floor(Math.random() * (w.scaleMax + 1)); // 0..scaleMax

    w.round += 1;
    w.current = {
      teamId: team.id,
      clueGiverId,
      guesserId,
      category: { topic: cat.topic, low: cat.low, high: cat.high },
      target,
      clue: null,
      guess: null,
      distance: null,
      points: null,
      guessShown: false, // Schritt 1 der Auflösung: Tipp sichtbar
      revealed: false, // Schritt 2: Ergebnis sichtbar
    };
    w.phase = PHASES.CLUE;
  }

  // ---------------------------------------------------------- Runde
  submitClue(room, player, text) {
    const w = room.wave;
    if (w.phase !== PHASES.CLUE || !w.current) return { ok: false, error: 'Aktuell kein Hinweis gefragt.' };
    if (player.id !== w.current.clueGiverId) return { ok: false, error: 'Du bist nicht der Hinweisgeber.' };
    const clean = String(text || '').trim().slice(0, 60);
    if (!clean) return { ok: false, error: 'Der Hinweis darf nicht leer sein.' };
    w.current.clue = clean;
    w.phase = PHASES.GUESS;
    room.lastActivity = Date.now();
    return { ok: true };
  }

  submitGuess(room, player, value) {
    const w = room.wave;
    if (w.phase !== PHASES.GUESS || !w.current) return { ok: false, error: 'Aktuell kann nicht geraten werden.' };
    if (player.id !== w.current.guesserId) return { ok: false, error: 'Du bist nicht der Ratende.' };
    const v = Math.floor(Number(value));
    if (!Number.isFinite(v) || v < 0 || v > w.scaleMax) {
      return { ok: false, error: 'Bitte einen Wert auf der Skala wählen.' };
    }
    w.current.guess = v;
    w.phase = PHASES.REVEAL; // Admin deckt anschließend auf
    room.lastActivity = Date.now();
    return { ok: true };
  }

  /** Admin kann den Hinweis des Hinweisgebers korrigieren (nur in guess/reveal). */
  editClue(room, text) {
    const w = room.wave;
    if (![PHASES.GUESS, PHASES.REVEAL].includes(w.phase) || !w.current) return;
    if (w.current.revealed) return;
    const clean = String(text || '').trim().slice(0, 60);
    if (clean) w.current.clue = clean;
    room.lastActivity = Date.now();
  }

  _points(distance) {
    if (distance === 0) return 3;
    if (distance === 1) return 1;
    return 0;
  }

  /** Schritt 1 der Auflösung: den Tipp des Ratenden für alle sichtbar machen. */
  showGuess(room) {
    const w = room.wave;
    if (w.phase !== PHASES.REVEAL || !w.current) throw new Error('Es gibt keinen Tipp anzuzeigen.');
    if (w.current.guess === null) throw new Error('Der Ratende hat noch nicht getippt.');
    w.current.guessShown = true;
    room.lastActivity = Date.now();
  }

  /** Schritt 2 der Auflösung: Zielzahl + Punkte aufdecken und vergeben. */
  revealResult(room) {
    const w = room.wave;
    if (w.phase !== PHASES.REVEAL || !w.current) throw new Error('Es gibt nichts aufzudecken.');
    if (w.current.revealed) return;
    const cur = w.current;
    if (cur.guess === null) throw new Error('Der Ratende hat noch nicht getippt.');
    if (!cur.guessShown) throw new Error('Zeige zuerst den Tipp an.');
    cur.distance = Math.abs(cur.target - cur.guess);
    cur.points = this._points(cur.distance);
    const team = this._teamById(room, cur.teamId);
    if (team) team.score += cur.points;
    cur.revealed = true;
    room.lastActivity = Date.now();
  }

  /** Nächstes Team (bzw. Spielende bei erreichtem Ziel am Rundenende). */
  nextTurn(room) {
    const w = room.wave;
    if (w.phase !== PHASES.REVEAL || !w.current || !w.current.revealed) {
      throw new Error('Erst das aktuelle Ergebnis aufdecken.');
    }
    w.turnIndex = (w.turnIndex + 1) % w.teamOrder.length;
    // Ein voller Zyklus ist vorbei, sobald turnIndex wieder auf 0 steht.
    if (w.turnIndex === 0 && this._someoneReachedGoal(room)) {
      // Fair zu Ende: nur beenden, wenn es einen eindeutigen Führenden gibt.
      const leaders = this._leaders(room);
      if (leaders.length === 1) {
        this._finish(room);
        return;
      }
      // Gleichstand an der Spitze -> weitere Runde spielen.
    }
    this._beginTurn(room);
    room.lastActivity = Date.now();
  }

  /** Admin überspringt die aktuelle Runde ohne Wertung. */
  skipTurn(room) {
    const w = room.wave;
    if (![PHASES.CLUE, PHASES.GUESS, PHASES.REVEAL].includes(w.phase)) {
      throw new Error('Die Runde kann jetzt nicht übersprungen werden.');
    }
    // Rolle nicht doppelt weiterdrehen: clueIdx wurde in _beginTurn bereits erhöht.
    w.turnIndex = (w.turnIndex + 1) % w.teamOrder.length;
    if (w.turnIndex === 0 && this._someoneReachedGoal(room) && this._leaders(room).length === 1) {
      this._finish(room);
      return;
    }
    this._beginTurn(room);
    room.lastActivity = Date.now();
  }

  _someoneReachedGoal(room) {
    return room.wave.teams.some((t) => t.score >= room.wave.pointsToWin);
  }
  _leaders(room) {
    const teams = this._fullTeams(room);
    let max = -1;
    for (const t of teams) max = Math.max(max, t.score);
    return teams.filter((t) => t.score === max);
  }

  _finish(room) {
    const w = room.wave;
    const leaders = this._leaders(room);
    w.winnerTeamId = leaders.length ? leaders[0].id : null;
    w.phase = PHASES.FINISHED;
    w.current = null;
    room.lastActivity = Date.now();
  }

  endGame(room) {
    this._finish(room);
  }

  backToLobby(room) {
    const w = room.wave;
    // Teams + Punkteziel behalten, Rest zurücksetzen.
    w.phase = PHASES.LOBBY;
    w.round = 0;
    w.turnIndex = 0;
    w.current = null;
    w.teamOrder = [];
    w.usedCategoryIds = [];
    w.winnerTeamId = null;
    for (const t of w.teams) {
      t.score = 0;
      t.clueIdx = 0;
    }
    room.lastActivity = Date.now();
  }

  // ---------------------------------------------------------- Snapshot
  buildState(room, viewer) {
    const w = room.wave;
    const isAdmin = viewer.role === 'admin';
    const meId = viewer.playerId;

    const teams = w.teams.map((t) => ({
      id: t.id,
      name: t.name,
      score: t.score,
      players: t.playerIds.map((id) => ({ id, name: this._name(room, id) })),
      isCurrent: w.current ? w.current.teamId === t.id : false,
      full: t.playerIds.length === 2,
    }));

    const base = {
      gameType: 'wave',
      role: viewer.role,
      code: room.code,
      phase: w.phase,
      round: w.round,
      scaleMax: w.scaleMax,
      pointsToWin: w.pointsToWin,
      teams,
      playerCount: room.players.size,
    };

    // Rangliste (Teams nach Punkten)
    base.standings = [...teams].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    if (w.phase === PHASES.LOBBY) {
      if (isAdmin) {
        const assigned = new Set(w.teams.flatMap((t) => t.playerIds));
        base.unassigned = [...room.players.values()]
          .filter((p) => !assigned.has(p.id))
          .map((p) => ({ id: p.id, name: p.name }));
        base.canStart = this._fullTeams(room).length >= 2;
      } else {
        const myTeam = this._teamOfPlayer(room, meId);
        base.myTeamId = myTeam?.id || null;
        base.myTeamName = myTeam?.name || null;
      }
      return base;
    }

    if (w.phase === PHASES.FINISHED) {
      const wt = w.winnerTeamId ? this._teamById(room, w.winnerTeamId) : null;
      base.winnerTeamId = w.winnerTeamId;
      base.winnerTeamName = wt ? wt.name : null;
      return base;
    }

    // Laufende Runde
    const cur = w.current;
    const team = this._teamById(room, cur.teamId);
    const myTeam = this._teamOfPlayer(room, meId);
    const inCurrentTeam = viewer.role === 'player' && myTeam && myTeam.id === cur.teamId;
    const amClue = viewer.role === 'player' && meId === cur.clueGiverId;
    const amGuess = viewer.role === 'player' && meId === cur.guesserId; // aktiver Ratender
    const revealed = cur.revealed;
    const guessShown = cur.guessShown;

    // Zielzahl sehen nur: Admin, Hinweisgeber, und bei der Auflösung alle.
    const showTarget = isAdmin || amClue || revealed;
    // Tipp sehen: Admin, der aktive Ratende, und ab Schritt 1 der Auflösung alle.
    const showGuessVal = isAdmin || amGuess || guessShown || revealed;

    base.turn = {
      teamId: cur.teamId,
      teamName: team ? team.name : '',
      clueGiverId: cur.clueGiverId,
      clueGiverName: this._name(room, cur.clueGiverId),
      guesserId: cur.guesserId,
      guesserName: this._name(room, cur.guesserId),
      category: cur.category, // { topic, low, high }
      clue: w.phase === PHASES.CLUE ? (isAdmin ? cur.clue : null) : cur.clue,
      target: showTarget ? cur.target : null,
      guess: showGuessVal ? cur.guess : null,
      distance: revealed ? cur.distance : null,
      points: revealed ? cur.points : null,
      guessShown,
      revealed,
    };

    if (isAdmin) {
      base.currentTeamId = cur.teamId;
    } else {
      base.myTeamId = myTeam?.id || null;
      // Bei >2 Spielern sind die übrigen Team-Mitglieder "teammate" (Ratende,
      // die mitraten/beraten, aber nicht selbst tippen dürfen).
      base.myRole = amClue ? 'clue' : amGuess ? 'guess' : inCurrentTeam ? 'teammate' : 'spectator';
      base.awaitingClue = w.phase === PHASES.CLUE && amClue;
      base.awaitingGuess = w.phase === PHASES.GUESS && amGuess;
    }

    return base;
  }
}

export { PHASES as WAVE_PHASES };
