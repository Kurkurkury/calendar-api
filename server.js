import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  getGoogleStatus,
  getAuthUrl,
  exchangeCodeForTokens,
  createGoogleEvent,
  getGoogleConfig,
} from "./google-calendar.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "db.json");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// ---- Mini-DB (JSON Datei) ----
function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ events: [], tasks: [] }, null, 2), "utf-8");
  }
}
function readDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    if (!Array.isArray(parsed.events)) parsed.events = [];
    if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
    return parsed;
  } catch {
    const safe = { events: [], tasks: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(safe, null, 2), "utf-8");
    return safe;
  }
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}
function uid(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// ---- Auth (API Key) ----
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const key =
    req.header("x-api-key") ||
    req.header("X-Api-Key") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");

  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
}

// ---- Health ----
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "calendar-api", authEnabled: !!API_KEY });
});

// ---- Google OAuth + Status ----
app.get("/api/google/status", (req, res) => {
  res.json(getGoogleStatus());
});

app.get("/api/google/auth-url", (req, res) => {
  res.json(getAuthUrl());
});

// Callback: Google redirectet zu GOOGLE_REDIRECT_URI?code=...
app.get("/api/google/callback", async (req, res) => {
  try {
    const code = req.query.code ? String(req.query.code) : "";
    const out = await exchangeCodeForTokens(code);

    if (out.ok) {
      res
        .status(200)
        .send(
          `<h2>✅ Google verbunden</h2>
           <p>Tokens gespeichert.</p>
           <p>Du kannst dieses Fenster schließen.</p>`
        );
    } else {
      res.status(400).send(`<h2>❌ Fehler</h2><pre>${escapeHtml(out.message || "unknown")}</pre>`);
    }
  } catch (e) {
    res.status(500).send(`<h2>❌ Fehler</h2><pre>${escapeHtml(e?.message || "unknown")}</pre>`);
  }
});

// ---- Create event in Google Calendar (direkt) + Spiegelung in db.json ----
app.post("/api/google/events", requireApiKey, async (req, res) => {
  try {
    const { title, start, end, location = "", notes = "" } = req.body || {};
    const out = await createGoogleEvent({ title, start, end, location, notes });
    if (!out.ok) return res.status(400).json(out);

    // Spiegeln in lokale DB, damit UI es sieht
    const googleId = out.googleEvent?.id ? String(out.googleEvent.id) : uid("gcal");
    const db = readDb();
    const ev = {
      id: `gcal_${googleId}`,
      title: String(title),
      start: String(start),
      end: String(end),
      location: String(location || ""),
      notes: String(notes || ""),
      color: "",
      googleEventId: googleId,
    };
    db.events.push(ev);
    writeDb(db);

    res.json({ ok: true, googleEvent: out.googleEvent, mirroredEvent: ev });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
});

// ---- Quick Add: Text -> Datum/Uhrzeit -> Google Event ----
// Beispiele:
// "coiffeur morgen 13:00 60min"
// "bio lernen 16:30 90min"
// "arzt 24.01 09:15 30min"
app.post("/api/google/quick-add", requireApiKey, async (req, res) => {
  try {
    const { text = "", defaultMinutes = 60, location = "", notes = "" } = req.body || {};
    const parsed = parseQuickText(String(text || ""), Number(defaultMinutes || 60));

    if (!parsed.ok) return res.status(400).json(parsed);

    // IMPORTANT: keine toISOString() mehr (macht Z/UTC) -> wir senden Local RFC3339 ohne Z
    const startStr = formatLocalDateTime(parsed.start);
    const endStr = formatLocalDateTime(parsed.end);

    const out = await createGoogleEvent({
      title: parsed.title,
      start: startStr,
      end: endStr,
      location: location || "",
      notes: notes || "",
    });
    if (!out.ok) return res.status(400).json(out);

    // Spiegeln in lokale DB
    const googleId = out.googleEvent?.id ? String(out.googleEvent.id) : uid("gcal");
    const db = readDb();
    const ev = {
      id: `gcal_${googleId}`,
      title: parsed.title,
      start: startStr,
      end: endStr,
      location: String(location || ""),
      notes: String(notes || ""),
      color: "",
      googleEventId: googleId,
    };
    db.events.push(ev);
    writeDb(db);

    res.json({ ok: true, parsed: { ...parsed, start: startStr, end: endStr }, googleEvent: out.googleEvent, mirroredEvent: ev });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
});

// ---- Events (local db.json) ----
app.get("/api/events", (req, res) => {
  const db = readDb();
  res.json({ ok: true, events: db.events });
});

app.post("/api/events", requireApiKey, (req, res) => {
  const { title, start, end, location = "", notes = "", color = "" } = req.body || {};
  if (!title || !start || !end) {
    return res.status(400).json({ ok: false, message: "title/start/end required" });
  }

  const db = readDb();
  const ev = {
    id: uid("evt"),
    title: String(title),
    start: String(start),
    end: String(end),
    location: String(location || ""),
    notes: String(notes || ""),
    color: String(color || ""),
  };
  db.events.push(ev);
  writeDb(db);
  res.json({ ok: true, event: ev });
});

// ---- Tasks (local db.json) ----
app.get("/api/tasks", (req, res) => {
  const db = readDb();
  res.json({ ok: true, tasks: db.tasks });
});

app.post("/api/tasks", requireApiKey, (req, res) => {
  const {
    title,
    durationMinutes,
    deadline = null,
    importance = false,
    urgency = false,
    status = "open",
    scheduledStart = null,
    scheduledEnd = null,
  } = req.body || {};

  if (!title || !durationMinutes) {
    return res.status(400).json({ ok: false, message: "title/durationMinutes required" });
  }

  const db = readDb();
  const task = {
    id: uid("tsk"),
    title: String(title),
    durationMinutes: Number(durationMinutes),
    deadline: deadline ? String(deadline) : null,
    importance: !!importance,
    urgency: !!urgency,
    status: String(status || "open"),
    scheduledStart: scheduledStart ? String(scheduledStart) : null,
    scheduledEnd: scheduledEnd ? String(scheduledEnd) : null,
    createdAt: Date.now(),
  };
  db.tasks.push(task);
  writeDb(db);
  res.json({ ok: true, task });
});

app.listen(PORT, () => {
  const cfg = getGoogleConfig();
  console.log(`calendar-api running on port ${PORT}`);
  console.log(`google timezone: ${cfg.GOOGLE_TIMEZONE || "Europe/Zurich"}`);
});

// ---- Quick Add Parser (deutsch, MVP) ----
function parseQuickText(input, defaultMinutes) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, message: "text fehlt" };

  // duration: "90min" / "1h" / "2h"
  let minutes = defaultMinutes > 0 ? defaultMinutes : 60;
  const durMinMatch = raw.match(/(\d{1,3})\s*min\b/i);
  const durHMatch = raw.match(/(\d{1,2})\s*h\b/i);
  if (durMinMatch) minutes = clampInt(parseInt(durMinMatch[1], 10), 5, 12 * 60);
  if (durHMatch) minutes = clampInt(parseInt(durHMatch[1], 10) * 60, 5, 12 * 60);

  // date: heute/morgen/übermorgen or dd.mm(.yyyy)
  const now = new Date();
  let day = new Date(now);
  day.setSeconds(0, 0);

  const lower = raw.toLowerCase();

  let hasExplicitDate = false;

  if (/\bübermorgen\b/i.test(lower)) {
    day.setDate(day.getDate() + 2);
    hasExplicitDate = true;
  } else if (/\bmorgen\b/i.test(lower)) {
    day.setDate(day.getDate() + 1);
    hasExplicitDate = true;
  } else if (/\bheute\b/i.test(lower)) {
    hasExplicitDate = true;
  } else {
    const dm = raw.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/);
    if (dm) {
      const dd = parseInt(dm[1], 10);
      const mm = parseInt(dm[2], 10);
      let yyyy = dm[3] ? parseInt(dm[3], 10) : now.getFullYear();
      if (yyyy < 100) yyyy += 2000;
      day = new Date(yyyy, mm - 1, dd, day.getHours(), day.getMinutes(), 0, 0);
      hasExplicitDate = true;
    }
  }

  // time: HH:MM or HH.MM
  let hh = 9;
  let min = 0;

  const timeMatch = raw.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (timeMatch) {
    hh = clampInt(parseInt(timeMatch[1], 10), 0, 23);
    min = clampInt(parseInt(timeMatch[2], 10), 0, 59);
  } else {
    // hour-only nur wenn NICHT bereits ein Datum wie 24.01 drin ist
    // und wenn die Zahl eher wie "13" alleine steht (nicht Teil von 60min etc.)
    const hourOnlyMatch = raw.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
    if (hourOnlyMatch) {
      hh = clampInt(parseInt(hourOnlyMatch[1], 10), 0, 23);
      min = 0;
    }
  }

  const start = new Date(day);
  start.setHours(hh, min, 0, 0);

  const end = new Date(start);
  end.setMinutes(end.getMinutes() + minutes);

  // title: input ohne erkannte tokens (MVP)
  let title = raw;
  title = title.replace(/\b(heute|morgen|übermorgen)\b/gi, "").trim();
  title = title.replace(/\b\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\b/g, "").trim();
  title = title.replace(/\b\d{1,2}[:.]\d{2}\b/g, "").trim();
  title = title.replace(/\b\d{1,3}\s*min\b/gi, "").trim();
  title = title.replace(/\b\d{1,2}\s*h\b/gi, "").trim();
  // wenn wir hour-only genutzt haben, entfernen wir das auch aus title
  title = title.replace(/(?:^|\s)\d{1,2}(?:\s|$)/, " ").trim().replace(/\s+/g, " ");

  if (!title) title = "Termin";

  return { ok: true, title, start, end, minutes };
}

function clampInt(n, a, b) {
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

// Format: YYYY-MM-DDTHH:MM:SS (OHNE Z) => dann wird timeZone in google-calendar.js genutzt
function formatLocalDateTime(d) {
  const pad = (x) => String(x).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
