// server/google-calendar.js
// Google Calendar OAuth + Create Event
// Tokens werden lokal in server/google-tokens.json gespeichert.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKENS_PATH = path.join(__dirname, "google-tokens.json");

export function getGoogleConfig() {
  const {
    GOOGLE_CLIENT_ID = "",
    GOOGLE_CLIENT_SECRET = "",
    GOOGLE_REDIRECT_URI = "",
    GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.events",
    GOOGLE_CALENDAR_ID = "primary",
    GOOGLE_TIMEZONE = "Europe/Zurich",
  } = process.env;

  return {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_SCOPES,
    GOOGLE_CALENDAR_ID,
    GOOGLE_TIMEZONE,
  };
}

export function isGoogleConfigured() {
  const cfg = getGoogleConfig();
  return !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REDIRECT_URI);
}

function buildOAuthClient() {
  const cfg = getGoogleConfig();
  return new google.auth.OAuth2(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET, cfg.GOOGLE_REDIRECT_URI);
}

export function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return null;
    const raw = fs.readFileSync(TOKENS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed || null;
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

export function isConnected() {
  const t = loadTokens();
  // access_token reicht fürs “connected”, refresh_token ist ideal für dauerhaft
  return !!(t && (t.access_token || t.refresh_token));
}

export function getGoogleStatus() {
  const cfg = getGoogleConfig();
  return {
    ok: true,
    google: {
      configured: isGoogleConfigured(),
      connected: isConnected(),
      scopes: cfg.GOOGLE_SCOPES,
      calendarId: cfg.GOOGLE_CALENDAR_ID,
      timezone: cfg.GOOGLE_TIMEZONE,
    },
  };
}

export function getAuthUrl() {
  if (!isGoogleConfigured()) {
    return { ok: false, message: "Google OAuth nicht konfiguriert (Env Vars fehlen)" };
  }

  const cfg = getGoogleConfig();
  const oauth2 = buildOAuthClient();

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: cfg.GOOGLE_SCOPES.split(" ").filter(Boolean),
  });

  return { ok: true, url };
}

export async function exchangeCodeForTokens(code) {
  if (!isGoogleConfigured()) {
    return { ok: false, message: "Google OAuth nicht konfiguriert (Env Vars fehlen)" };
  }
  if (!code) return { ok: false, message: "code fehlt" };

  const oauth2 = buildOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  saveTokens(tokens);

  return { ok: true, tokensSaved: true, hasRefreshToken: !!tokens.refresh_token };
}

function getAuthedClient() {
  if (!isGoogleConfigured()) throw new Error("Google OAuth nicht konfiguriert");
  const tokens = loadTokens();
  if (!tokens) throw new Error("Nicht verbunden (keine Tokens gespeichert)");
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials(tokens);
  return oauth2;
}

export async function createGoogleEvent({ title, start, end, location = "", notes = "" }) {
  if (!title || !start || !end) {
    return { ok: false, message: "title/start/end required" };
  }

  const cfg = getGoogleConfig();
  const auth = getAuthedClient();
  const calendar = google.calendar({ version: "v3", auth });

  // FIX: timeZone explizit setzen, damit Google nicht "Missing time zone definition" bringt
  // start/end dürfen sein:
  // - "2026-01-16T13:00:00" (ohne Z) -> wird mit cfg.GOOGLE_TIMEZONE interpretiert
  // - oder ISO mit Z -> dann ist timeZone zwar drin, aber Google kann trotzdem korrekt
  const resource = {
    summary: String(title),
    location: String(location || ""),
    description: String(notes || ""),
    start: { dateTime: String(start), timeZone: cfg.GOOGLE_TIMEZONE || "Europe/Zurich" },
    end: { dateTime: String(end), timeZone: cfg.GOOGLE_TIMEZONE || "Europe/Zurich" },
  };

  const res = await calendar.events.insert({
    calendarId: cfg.GOOGLE_CALENDAR_ID || "primary",
    requestBody: resource,
  });

  return { ok: true, googleEvent: res.data };
}

export async function listGoogleEvents({ timeMin, timeMax }) {
  if (!timeMin || !timeMax) {
    return { ok: false, message: "timeMin/timeMax required" };
  }

  const cfg = getGoogleConfig();
  const auth = getAuthedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const res = await calendar.events.list({
    calendarId: cfg.GOOGLE_CALENDAR_ID || "primary",
    timeMin: String(timeMin),
    timeMax: String(timeMax),
    singleEvents: true,
    orderBy: "startTime",
  });

  return { ok: true, events: res.data.items || [], calendarId: cfg.GOOGLE_CALENDAR_ID || "primary" };
}

export async function deleteGoogleEvent({ eventId }) {
  if (!eventId) {
    return { ok: false, message: "eventId required" };
  }

  try {
    const cfg = getGoogleConfig();
    const auth = getAuthedClient();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({
      calendarId: cfg.GOOGLE_CALENDAR_ID || "primary",
      eventId: String(eventId),
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, message: e?.message || "unknown" };
  }
}
