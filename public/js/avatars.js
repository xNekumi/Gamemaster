/* Gemeinsame Avatar-Hilfsfunktionen für Spieler- und Admin-Ansicht. */
(function () {
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // Deterministische Farbe aus dem Namen (Fallback-Avatar).
  function avatarColor(name) {
    const h = hash(String(name || '?')) % 360;
    return `hsl(${h} 52% 46%)`;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(name || '?').trim().slice(0, 2).toUpperCase();
  }

  // Innere Darstellung: Bild oder farbiger Initialen-Fallback.
  function avatarInner(name, url) {
    if (url) return `<img class="av-img" src="${url}" alt="" draggable="false">`;
    return `<div class="av-fallback" style="background:${avatarColor(name)}">${escapeHtml(
      initials(name)
    )}</div>`;
  }

  // Kleiner runder Avatar (für Autor/Wähler in der Auflösung).
  function avatarCircle(name, url, extraClass) {
    return `<div class="av-circle ${extraClass || ''}" title="${escapeHtml(name || '')}">${avatarInner(
      name,
      url
    )}</div>`;
  }

  // Datei -> quadratisch zugeschnittenes, verkleinertes JPEG (data-URL).
  function fileToAvatar(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size); // center-crop (cover)
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Bild konnte nicht geladen werden.'));
      };
      img.src = url;
    });
  }

  window.GM = { escapeHtml, avatarColor, initials, avatarInner, avatarCircle, fileToAvatar };
})();
