# 🎉 Gamemaster – Party Games

Selbst-gehostete Webanwendung für Party-Spiele mit Freunden. Ein **Gamemaster**
(Admin) steuert das Spiel über ein eigenes Interface, beliebig viele **Spieler**
treten von überall per Website bei – nur mit ihrem Namen, kein Login nötig.

Der Gamemaster **wählt beim Erstellen einer Runde das Spiel aus**. Aktuell
verfügbar:

- **Bluff-Quiz** (à la Fibbage/Psych) – erfinde Antworten und errate die echte Lösung.
- **Der dümmste fliegt** – Antworten geben, für den „Dümmsten" abstimmen, Herzen verlieren; wer zuletzt übrig bleibt, gewinnt.

Die Architektur ist modular, sodass weitere Spiele leicht ergänzt werden können.

---

## 🎮 Das Spiel: Bluff-Quiz

1. Der Gamemaster erstellt eine Runde und teilt den **Raum-Code** / Einladungslink.
2. Spieler treten mit ihrem Namen bei.
3. Eine zufällige **Frage** wird gestellt. Jeder Spieler schreibt eine
   (erfundene, überzeugend klingende) **Antwort**.
4. Sobald alle geantwortet haben, werden **alle Antworten + die echte Lösung**
   in zufälliger Reihenfolge angezeigt – niemand weiß, welche von wem ist.
5. Die Spieler **stimmen ab**, welche Antwort sie für die richtige halten
   (die eigene Antwort ist dabei nicht wählbar).
6. **Punkte:**
   - +1 Punkt, wenn ein anderer Spieler für deine (erfundene) Antwort stimmt.
   - +1 Punkt, wenn du die richtige Antwort errätst.
7. Der Gamemaster deckt danach jede Antwort einzeln auf (wer sie geschrieben
   hat und wer dafür gestimmt hat) und geht dann zur nächsten Frage weiter.

## 💀 Das Spiel: Der dümmste fliegt

1. Der Gamemaster wählt beim Erstellen „Der dümmste fliegt" und startet das Spiel
   (die Spieler werden zufällig auf dem Brett angeordnet, jeder mit **3 Herzen**).
2. Reihum ist ein Spieler im **Hot-Seat** (leuchtender Rand). Er bekommt seine
   **Frage als Popup** auf den Bildschirm; der Gamemaster liest sie vor und trägt
   die **Antwort** des Spielers ein und markiert sie **grün (richtig)** / **rot (falsch)**.
3. Sobald **jeder lebende Spieler mind. 2 Fragen** hatte, startet der Gamemaster das **Voting**.
4. Jeder lebende Spieler stimmt für einen **anderen** Spieler (den „Dümmsten").
5. Der Gamemaster deckt die Stimmen einzeln auf (Wähler-Avatare erscheinen unten
   links an der Kachel) und bestätigt das Ergebnis. Der Spieler mit den **meisten
   Stimmen verliert ein Herz** (**Gleichstand → Stichwahl**).
6. Bei **0 Herzen** scheidet ein Spieler aus (Kachel ausgegraut, wird übersprungen).
   Ausgeschiedene Spieler dürfen nicht mehr abstimmen.
7. **Sudden Death:** Sobald nur noch **2 Spieler** leben, bekommen beide **5 Fragen**.
   Danach stimmen **alle ausgeschiedenen Spieler** ab – der Gewählte verliert
   **alle** verbleibenden Herzen, der andere gewinnt.
8. Ansonsten geht es rundenweise weiter, bis nur noch **ein Spieler übrig** ist.

Fragen liegen in `data/questions-hearts.json` (einfache Liste von Strings, nur der
Admin sieht sie).

### 🖼️ Profilbilder

Spieler können beim Beitritt **optional ein Profilbild hochladen** (wird im
Browser quadratisch zugeschnitten und verkleinert). Ohne Bild gibt es einen
farbigen Avatar mit Initialen. Unten auf Spieler- und Gamemaster-Bildschirm
erscheint eine **Avatar-Leiste** ("Wall of Faces") mit der Punktzahl als
Badge. In der Auflösung werden Autor und Abstimmende als Avatar-Kreise
angezeigt (statt nur als Namen). Die Bildquelle ist so gekapselt, dass später
**Kamera-Schnappschüsse** einfach ergänzt werden können.

---

## 🧩 Technik

- **Backend:** Node.js + Express + Socket.IO (Echtzeit, kein Polling)
- **Frontend:** Vanilla JS + modernes CSS, keine Build-Tools
- **Zustand:** komplett im Arbeitsspeicher (kein Datenbank-Setup nötig)

Projektstruktur:

```
├── src/
│   ├── server.js       # Express + Socket.IO, Event-Handling, Spielauswahl
│   ├── gameManager.js  # Räume/Spieler/Avatare + Bluff-Quiz-Logik
│   └── heartsGame.js   # Logik für "Der dümmste fliegt"
├── public/
│   ├── index.html      # Spieler-Ansicht (Beitritt + beide Spiele)
│   ├── admin.html      # Gamemaster-Steuerung (beide Spiele)
│   ├── css/style.css
│   └── js/{avatars,hearts,player,admin}.js
├── data/questions.json         # Bluff-Quiz-Fragen
├── data/questions-hearts.json  # Fragen für "Der dümmste fliegt"
├── config/config.json          # Punkte-, Herzen- & Raum-Konfiguration
├── Dockerfile · docker-compose.yml
└── deploy/gamemaster.service    # systemd-Alternative
```

---

## 🚀 Schnellstart (lokal)

```bash
npm install
ADMIN_PASSWORD="dein-passwort" npm start
```

- Spieler:    <http://localhost:3000/>
- Gamemaster: <http://localhost:3000/admin>

---

## 🐳 Deployment auf dem Ubuntu-Home-Server

### Variante A: Docker (empfohlen)

```bash
git clone <dein-repo> gamemaster && cd gamemaster
export ADMIN_PASSWORD="ein-sicheres-passwort"
docker compose up -d --build
```

Läuft dann auf Port **3000**. Fragen und Konfiguration sind als Volume
eingebunden – Änderungen an `data/questions.json` bzw. `config/config.json`
werden nach einem `docker compose restart` übernommen.

### Variante B: systemd (ohne Docker)

```bash
sudo cp -r . /opt/gamemaster && cd /opt/gamemaster
npm install --omit=dev
sudo cp deploy/gamemaster.service /etc/systemd/system/
# Datei anpassen: User, WorkingDirectory, ADMIN_PASSWORD
sudo systemctl daemon-reload
sudo systemctl enable --now gamemaster
```

### Deine Domain + HTTPS (Reverse Proxy)

Damit Freunde weltweit über deine Domain beitreten können, stelle die App
hinter einen Reverse Proxy mit TLS. WebSockets müssen durchgereicht werden.

**nginx-Beispiel** (`/etc/nginx/sites-available/gamemaster`):

```nginx
server {
    server_name party.deine-domain.de;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Danach kostenloses Zertifikat via `sudo certbot --nginx -d party.deine-domain.de`.

> Router-Portfreigabe (Port 443 → Home-Server) nicht vergessen, damit die
> Domain von außen erreichbar ist.

---

## ⚙️ Konfiguration

| Variable         | Standard      | Beschreibung                                    |
|------------------|---------------|-------------------------------------------------|
| `ADMIN_PASSWORD` | `gamemaster`  | Passwort, um eine neue Spielrunde zu erstellen  |
| `PORT`           | `3000`        | HTTP-Port                                        |
| `QUESTIONS_FILE` | `data/questions.json` | Alternativer Pfad zur Fragen-Datei      |

**`config/config.json`** – Punkte und Raum-Einstellungen:

```json
{
  "scoring": {
    "pointsForVoteOnYourAnswer": 1,
    "pointsForGuessingCorrectAnswer": 1
  },
  "room": { "codeLength": 4, "maxPlayers": 100, "inactiveRoomTtlMinutes": 240 }
}
```

---

## ✍️ Eigene Fragen hinzufügen

`data/questions.json` ist eine einfache Liste:

```json
[
  { "question": "Deine Frage?", "answer": "Die richtige Antwort" }
]
```

Nach Änderungen den Server neu starten (bzw. `docker compose restart`).

---

## 🔮 Ausblick

- Weitere Spiele über das Admin-Interface auswählbar
- Persistente Statistiken / Bestenlisten
- Fragen-Kategorien und eigene Fragenpakete pro Runde
