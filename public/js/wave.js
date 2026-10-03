/* Gemeinsame Skala für "Wellenlänge" (Admin- und Spieler-Ansicht). */
(function () {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  /**
   * @param {HTMLElement} container
   * @param {object} o { scaleMax, topic, low, high, target, guess, revealed,
   *                     selectable, selected, onSelect, clue }
   */
  function render(container, o = {}) {
    const max = o.scaleMax ?? 10;
    const target = o.target ?? null; // Zielzahl (nur wenn sichtbar)
    const guess = o.guess ?? null; // abgegebener Tipp
    const selected = o.selected ?? null; // aktuelle (noch nicht gesendete) Auswahl
    const cells = [];
    for (let i = 0; i <= max; i++) {
      const cls = ['wv-cell'];
      if (target !== null && i === target) cls.push('is-target');
      if (guess !== null && i === guess) cls.push('is-guess');
      if (selected !== null && i === selected) cls.push('is-selected');
      cells.push(
        `<button type="button" class="${cls.join(' ')}" data-v="${i}"${
          o.selectable ? '' : ' disabled'
        }><span class="wv-cell-num">${i}</span></button>`
      );
    }

    const clueHtml = o.clue
      ? `<div class="wv-clue">💬 <b>${esc(o.clue)}</b></div>`
      : '';

    container.innerHTML = `
      <div class="wv-cat">
        <div class="wv-cat-topic">🎯 ${esc(o.topic || '')}</div>
        ${clueHtml}
      </div>
      <div class="wv-scale-labels">
        <span class="wv-lab low"><b>0</b> ${esc(o.low || '')}</span>
        <span class="wv-lab high">${esc(o.high || '')} <b>${max}</b></span>
      </div>
      <div class="wv-cells">${cells.join('')}</div>
      <div class="wv-legend">
        ${target !== null ? '<span class="wv-key target">Zielzahl</span>' : ''}
        ${guess !== null ? '<span class="wv-key guess">Tipp</span>' : ''}
      </div>`;

    if (o.selectable && typeof o.onSelect === 'function') {
      container.querySelectorAll('.wv-cell').forEach((el) =>
        el.addEventListener('click', () => o.onSelect(Number(el.dataset.v)))
      );
    }
  }

  window.WaveScale = { render };
})();
