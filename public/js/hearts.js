/* Gemeinsames Spielbrett für "Der dümmste fliegt" (Spieler- und Admin-Ansicht). */
(function () {
  function heartsHtml(remaining, max) {
    let out = '';
    for (let i = 0; i < max; i++) {
      out += i < remaining ? '<span class="ht-heart full">♥</span>' : '<span class="ht-heart">♡</span>';
    }
    return out;
  }

  // Antworten eines Spielers (dieser Runde) als Overlay.
  function answersHtml(playerId, answers) {
    const mine = answers.filter((a) => a.playerId === playerId);
    if (!mine.length) return '';
    const rows = mine
      .map((a) => {
        const dot =
          a.correct === true
            ? '<span class="ht-dot ok" title="richtig"></span>'
            : a.correct === false
            ? '<span class="ht-dot no" title="falsch"></span>'
            : '<span class="ht-dot" title="offen"></span>';
        return `<div class="ht-ans">${dot}<span class="ht-ans-text">${GM.escapeHtml(a.text)}</span></div>`;
      })
      .join('');
    return `<div class="ht-answers">${rows}</div>`;
  }

  function votersHtml(playerId, votesByTarget, avatars, nameOf) {
    const voters = (votesByTarget && votesByTarget[playerId]) || [];
    if (!voters.length) return '';
    const circles = voters
      .map((vid) => GM.avatarCircle(nameOf(vid), avatars[vid], 'ht-voter'))
      .join('');
    return `<div class="ht-voters">${circles}</div>`;
  }

  /**
   * @param {HTMLElement} container
   * @param {object} state   Hearts-Zustand (board, answers, votesByTarget, ...)
   * @param {object} avatars id -> data-URL
   * @param {object} opts    { votableIds, myVote, onTileClick, myId }
   */
  function render(container, state, avatars, opts = {}) {
    const board = state.board || [];
    const nameOf = (id) => {
      const c = board.find((x) => x.id === id);
      return c ? c.name : '?';
    };
    const votable = new Set(opts.votableIds || []);

    const n = board.length || 1;
    if (!opts.fit) {
      // Admin: einfaches, möglichst quadratisches Raster.
      container.style.setProperty('--ht-cols', Math.max(1, Math.ceil(Math.sqrt(n))));
    }

    container.innerHTML = board
      .map((c) => {
        const isVotable = votable.has(c.id);
        const cls = [
          'ht-tile',
          c.eliminated ? 'out' : '',
          c.isActive ? 'active' : '',
          isVotable ? 'votable' : '',
          opts.myVote === c.id ? 'voted' : '',
          opts.myId === c.id ? 'self' : '',
          opts.hurtIds && opts.hurtIds.includes(c.id) ? 'ht-hurt' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<div class="${cls}" data-id="${c.id}">
          <div class="ht-media">${GM.avatarInner(c.name, avatars[c.id])}</div>
          <div class="ht-hearts">${heartsHtml(c.hearts, c.maxHearts)}</div>
          ${answersHtml(c.id, state.answers || [])}
          ${votersHtml(c.id, state.votesByTarget, avatars, nameOf)}
          <div class="ht-name">${GM.escapeHtml(c.name)}${opts.myId === c.id ? ' (Du)' : ''}</div>
          ${c.eliminated ? '<div class="ht-out-badge">Ausgeschieden</div>' : ''}
        </div>`;
      })
      .join('');

    if (opts.onTileClick) {
      container.querySelectorAll('.ht-tile.votable').forEach((el) =>
        el.addEventListener('click', () => opts.onTileClick(el.dataset.id))
      );
    }

    // Spieler-Ansicht: Kacheln an den Bildschirm anpassen (kein Scrollen).
    if (opts.fit) fit(container, n);
  }

  /**
   * Berechnet Spaltenzahl + Kachelgröße so, dass alle N quadratischen Kacheln
   * in die verfügbare Fläche passen und dabei möglichst groß sind.
   */
  function fit(container, n) {
    const run = () => {
      const gap = 16;
      const W = container.clientWidth;
      const H = container.clientHeight;
      if (!W || !H) return;
      let best = 0, bestCols = 1;
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const tw = (W - gap * (cols - 1)) / cols;
        const th = (H - gap * (rows - 1)) / rows;
        const size = Math.min(tw, th);
        if (size > best) { best = size; bestCols = cols; }
      }
      best = Math.max(80, Math.min(best, 460)); // sinnvolle Grenzen
      container.style.setProperty('--ht-cols', bestCols);
      container.style.setProperty('--ht-size', Math.floor(best) + 'px');
    };
    requestAnimationFrame(run);
  }

  window.HeartsBoard = { render, heartsHtml, fit };
})();
