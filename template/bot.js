// talbs-whatsapp-bot — בוט WhatsApp + Claude עם תיקון self-chat
// טל בשור · עסק שעובד בשבילך.
// נקודות מפתח:
//   1. self-chat עובד מהקופסה — אין צורך במספר טלפון שני
//   2. ה-JID של המכשיר נכנס אוטומטית ל-whitelist בעת ההתחברות
//   3. שיחה עם Claude CLI שכבר מותקן אצל המשתמש (אפס עלות API נוספת)

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import qrcode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Config -----
const CONFIG_PATH = path.join(__dirname, "config.json");
const SESSIONS_PATH = path.join(__dirname, "sessions.json");
const FEED_PATH = path.join(__dirname, "feed.json");
const AUTH_DIR = path.join(__dirname, "auth");
const PORT = 7655;

// ----- אבטחה: רק המסך של העוזר עצמו יכול לשנות אותו -----
// העוזר רץ על המחשב ומקבל פקודות מהדפדפן. בלי הגנה, כל אתר שפתוח בדפדפן
// יכול לשלוח לו POST (למשל "תתחבר ל-Green API של התוקף") — והוואטסאפ של
// התוקף היה שולט במחשב. הפתרון: מפתח חד-פעמי (nonce) שנוצר בכל הפעלה,
// מוזרק רק לתוך הדף שהעוזר מגיש, וכל בקשת שינוי חייבת לשאת אותו.
// אתר זר לא יכול לקרוא את הדף שלנו (same-origin) → לא יכול להשיג את המפתח.
const APP_NONCE = randomBytes(24).toString("hex");
function hasValidNonce(req) {
  const got = String(req.headers["x-app-nonce"] || "");
  if (got.length !== APP_NONCE.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(APP_NONCE));
}

// ----- סודות: קובץ .env בלבד (לא config.json) -----
// launchd לא טוען .env לבד, אז המנוע קורא אותו בעצמו בעלייה.
// הטוקן של Green API חי רק כאן — לא ב-config.json, לא ב-/state, לא בלוג.
const ENV_PATH = path.join(__dirname, ".env");
function loadDotEnv() {
  try {
    const text = fs.readFileSync(ENV_PATH, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadDotEnv();
// כתיבה/עדכון של מפתח ב-.env, עם הרשאות 600 (רק המשתמש קורא)
function setDotEnv(key, value) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  } catch {}
  const re = new RegExp(`^\\s*${key}\\s*=`);
  lines = lines.filter((l) => !re.test(l) && l.trim() !== "");
  if (value) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + (lines.length ? "\n" : ""), {
    mode: 0o600,
  });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {}
  if (value) process.env[key] = value;
  else delete process.env[key];
}

// וודא שתיקיית auth קיימת — Baileys צריך אותה לפני הראשון
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// ----- Watchdog לזיהוי "דריפט" של Baileys -----
// Baileys מאבד סנכרון עם WhatsApp אחרי 24-48 שעות (Bad MAC, key counter errors).
// כשזה קורה הסשן הגרוע נשאר חי אבל לא קורא/כותב כמו שצריך.
// פתרון: סופרים ניתוקים לא-צפויים. אם 5+ ב-30 דקות → מאתחלים auth ומציגים QR חדש.
const driftEvents = []; // timestamps של ניתוקים לא-צפויים
const DRIFT_WINDOW_MS = 30 * 60 * 1000; // 30 דקות
const DRIFT_THRESHOLD = 5; // 5 ניתוקים בחלון = דריפט מאומת
let driftRecoveryInProgress = false;

function trackDisconnect() {
  const now = Date.now();
  driftEvents.push(now);
  const cutoff = now - DRIFT_WINDOW_MS;
  while (driftEvents.length && driftEvents[0] < cutoff) {
    driftEvents.shift();
  }
  console.log(
    `[watchdog] ניתוקים ב-30 דק' אחרונות: ${driftEvents.length}/${DRIFT_THRESHOLD}`,
  );
  return driftEvents.length >= DRIFT_THRESHOLD;
}

function resetDriftCounter() {
  driftEvents.length = 0;
}

// 3 modes that map to Claude CLI permission modes
const MODE_PERMISSIONS = {
  personal: "bypassPermissions", // עוזר אישי - יוצר ועורך בלי לשאול
  careful: "acceptEdits", // עוזר זהיר - שואל לפני קבצים
  chat: "plan", // צ'אט בלבד - לא נוגע
};

const DEFAULT_SYSTEM_PROMPT = `אתה "{agentName}" — Claude Code המלא, מחובר ל-WhatsApp ורץ על המחשב של המשתמש.

הכלים שלך:
יש לך גישה מלאה לכל כלי Claude Code: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch.
אתה יכול:
- לקרוא ולערוך קבצים בכל מקום על המחשב (לא רק ב-workdir הנוכחי)
- להריץ פקודות bash, לבנות קוד, להתקין חבילות
- לחקור פרויקטים (אם המשתמש מציין נתיב כמו ~/Projects/X)
- לחפש באינטרנט ולמשוך דפים

הקהל שלך:
בעל/ת עסק שמשתמש/ת בך לניהול היום-יום העסקי דרך WhatsApp — לידים, פגישות, משימות, תוכן, כסף.

איך אתה מדבר:
- עברית מדוברת, חמה אבל ישירה
- תשובות קצרות. זה WhatsApp — לא דו"ח
- בלי "איך אפשר לעזור" בהתחלה. בלי "מקווה שעזרתי" בסוף. בלי "שאלה מעולה" — בלי באזוורדס
- תוצאה לפני הסבר. אם ביקשו הודעה — תן את ההודעה ואז שורה איך לשפר
- שאלה עמומה? שאל שאלה אחת ממוקדת — לא רשימה
- לא "אולי כדאי לחשוב על X" — ישר: "X" / "Y". ההחלטה של בעל/ת העסק, לא שלך
- משימות ארוכות (בנייה, רפקטור, חיפוש מעמיק) — בצע עד הסוף, אחר כך דווח קצר מה עשית

הודעה ראשונה ("שלום" / "היי" בלי הקשר) — הצג את עצמך בשורה אחת:
"🤖 היי 👋 אני {agentName}. מה לעשות?"

תמליל קולי? — מתחיל ב-"[תמליל קולי]:" — התייחס כטקסט רגיל.

חשוב: התחל כל תשובה שלך באמוג'י רובוט 🤖 ורווח (לדוגמה: "🤖 הוספתי לקלנדר..."). זה הסימן הויזואלי שמבדיל בין מה שאתה עונה לבין מה שנכתב בצ'אט על ידי בעל/ת העסק.`;

const DEFAULT_WELCOME_MESSAGE = `היי 💛 אני העוזר האישי שלך — טל בשור, עסק שעובד בשבילך.

לפני שמתחילים — *לפנות אליך בלשון זכר או נקבה?*
תענה/י לי במילה אחת: *זכר* או *נקבה*

אחר כך תוכל/י לבקש ממני דברים אמיתיים מהיום שלך, למשל:
• "תכתוב הודעת מעקב ללקוח שלא חזר אליי"
• "סכם לי את הפגישה האחרונה"
• "אני תקוע/ה עם המחיר ללקוח, איך לנסח?"

אני פה.`;

function defaultConfig() {
  return {
    agentName: "העוזר האישי שלי",
    workdir: process.env.HOME,
    model: "sonnet",
    mode: "personal",
    provider: "baileys", // "baileys" (כרום — QR מקומי) | "green-api"
    // Green API — מוזן מהמסך ונשמר רק במחשב הזה. fallback: GREEN_API_INSTANCE_ID / GREEN_API_TOKEN מהסביבה
    // Green API: רק המזהה (לא סודי). הטוקן חי אך ורק ב-.env — אף פעם לא כאן.
    greenApi: { instanceId: "" },
    // זהות ותפקיד — נכתב מהמסך, מרכיב את המוח יחד עם ה-systemPrompt
    botRole: "",
    botTone: "",
    botDos: "",
    botDonts: "",
    gender: "", // "male" | "female" | "" - מתעדכן אוטומטית מתשובת המשתמש
    // אבטחה: כשדגל זה דלוק, רק self-chat (המספר שסרק את ה-QR) יכול להשתמש בבוט.
    // הודעות ממספרים אחרים נדחות לחלוטין — גם אם הם ב-whitelist.
    // ניתן לכבות ידנית רק על ידי עריכת config.json. ה-API הפנימי לא יכבה אותו.
    lockdownMode: true,
    whitelist: [],
    systemPromptAppend: DEFAULT_SYSTEM_PROMPT,
    welcomeMessage: DEFAULT_WELCOME_MESSAGE,
    welcomeSent: false,
  };
}

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  // merge with defaults so missing fields get filled
  return { ...defaultConfig(), ...saved };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ----- Sessions (per-user Claude session id) -----
let sessions = {};
try {
  sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
} catch {
  sessions = {};
}
function saveSessions() {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

// ----- Feed (last messages for UI) -----
let feed = [];
try {
  feed = JSON.parse(fs.readFileSync(FEED_PATH, "utf8"));
} catch {
  feed = [];
}
function pushFeed(entry) {
  feed.unshift({ ...entry, ts: Date.now() });
  feed = feed.slice(0, 60);
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));
}

// ----- State (broadcast to UI) -----
const state = {
  status: "starting",
  qr: null,
  meJid: null,
  meLid: null,
  meName: null,
  stats: { messagesIn: 0, messagesOut: 0, errors: 0 },
  lastError: null,
  greenLastPoll: null, // Green API — מתי נמשכו הודעות לאחרונה
  greenWebhookConflict: false, // Green API — מוגדר webhookUrl שגוזל את ההודעות מהבוט
};

// IDs של הודעות שאני בעצמי שלחתי — כדי לזהות echo ולא ליפול ללופ
const myMessageIds = new Set();
function rememberSentId(id) {
  if (!id) return;
  myMessageIds.add(id);
  if (myMessageIds.size > 200) {
    const arr = Array.from(myMessageIds);
    myMessageIds.clear();
    arr.slice(-100).forEach((x) => myMessageIds.add(x));
  }
}

// IDs של הודעות נכנסות שכבר טיפלתי בהן — כדי לא לטפל פעמיים (Baileys שולח notify+append)
const handledIncomingIds = new Set();
function isAlreadyHandled(id) {
  if (!id) return false;
  if (handledIncomingIds.has(id)) return true;
  handledIncomingIds.add(id);
  if (handledIncomingIds.size > 500) {
    const arr = Array.from(handledIncomingIds);
    handledIncomingIds.clear();
    arr.slice(-250).forEach((x) => handledIncomingIds.add(x));
  }
  return false;
}

// פונקציה אחת לכל שליחת הודעה - שמרשמת את ה-id כדי שלא נטפל בה כשנקבל אותה כ-echo
async function sendBotMessage(jid, text) {
  try {
    // 🛡️ אבטחה קריטית — שכבת הגנה אחרונה ביציאה:
    // לעולם אל תשלח למספר שאינו של בעל המכשיר. גם אם בלוגיקה הפנימית
    // הייתה בעיה שאיפשרה לעבד הודעה זרה — כאן זה נחסם בכל מקרה.
    if (config.lockdownMode !== false) {
      const targetUser = jidUser(jid);
      const meUser = jidUser(state.meJid);
      const meLidUser = state.meLid ? jidUser(state.meLid) : null;
      const isMe = targetUser === meUser || targetUser === meLidUser;
      if (!isMe) {
        console.log(
          `[BLOCKED-SEND] 🚨 חסום שליחה ל-${targetUser} — אינו בעל המכשיר (me=${meUser}, lid=${meLidUser})`,
        );
        state.stats.errors++;
        state.lastError = `blocked send to non-owner ${targetUser}`;
        return null;
      }
    }
    // סימן ויזואלי קבוע — מבדיל את התשובות של הבוט מההודעות שהמשתמש כתב לעצמו ב-self-chat
    const message = text.startsWith("🤖") ? text : `🤖 ${text}`;
    const sent = await providerSend(jid, message);
    rememberSentId(sent?.key?.id);
    return sent;
  } catch (e) {
    console.error("[send] failed:", e.message);
    state.stats.errors++;
    state.lastError = e.message;
    return null;
  }
}

// ----- Helpers -----
function jidUser(jid) {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0];
}

function ensureSelfWhitelisted() {
  if (!state.meJid) return;
  const me = jidUser(state.meJid);
  if (!config.whitelist.includes(me)) {
    config.whitelist.push(me);
    saveConfig(config);
    console.log(`[whitelist] auto-added own number: ${me}`);
  }
}

// ----- Claude CLI invocation -----
function askClaude(userJid, text, opts = {}) {
  return new Promise((resolve) => {
    const sessionId = opts.noResumeRetry ? null : sessions[userJid];
    // mode (personal/careful/chat) → CLI permission-mode
    const permissionMode =
      MODE_PERMISSIONS[config.mode] ||
      config.permissionMode ||
      "bypassPermissions";
    const args = [
      "-p",
      text,
      "--model",
      config.model || "sonnet",
      "--permission-mode",
      permissionMode,
      "--output-format",
      "json",
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    // בניית system prompt — מילוי placeholders + זהות/תפקיד מהמסך + gender
    let systemPrompt = (config.systemPromptAppend || "").replace(
      /\{agentName\}/g,
      config.agentName || "העוזר שלך",
    );
    // זהות ותפקיד שהמשתמש הגדיר במסך — מתווספים על גבי המוח הבסיסי
    const idParts = [];
    if (config.botRole) idParts.push(`התפקיד שלך: ${config.botRole}`);
    if (config.botTone) idParts.push(`הטון שלך: ${config.botTone}`);
    if (config.botDos) idParts.push(`חשוב שתעשה: ${config.botDos}`);
    if (config.botDonts) idParts.push(`אסור לך: ${config.botDonts}`);
    if (idParts.length) {
      systemPrompt += `\n\n--- ההגדרות של בעל העסק (גובר על הכל) ---\n${idParts.join("\n")}`;
    }
    // קובץ ההנחיות (העוזר-שלי.md בתיקיית העבודה) — המוח של העוזר, נקרא בכל הודעה.
    // המשתמש עורך אותו מהמסך או ישירות במחשב; שינוי נכנס לתוקף מיד.
    try {
      const brainPath = path.join(
        config.workdir || process.env.HOME,
        "העוזר-שלי.md",
      );
      const brain = fs.readFileSync(brainPath, "utf8").trim();
      if (brain) {
        systemPrompt += `\n\n--- קובץ ההנחיות של בעל העסק (גובר על הכל) ---\n${brain}`;
      }
    } catch {}
    if (config.gender === "male") {
      systemPrompt += "\n\nחשוב: התייחס למשתמש בלשון זכר תמיד.";
    } else if (config.gender === "female") {
      systemPrompt += "\n\nחשוב: התייחסי למשתמשת בלשון נקבה תמיד.";
    }
    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }

    const claudeBin = process.env.CLAUDE_BIN || "claude";
    const workdir = config.workdir || process.env.HOME;

    const child = spawn(claudeBin, args, {
      cwd: workdir,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const killer = setTimeout(
      () => {
        try {
          child.kill("SIGTERM");
        } catch {}
      },
      1000 * 60 * 5,
    );

    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        console.error("[claude] exit", code, stderr.slice(0, 500));
        // Claude Code שומר שיחות לפי תיקייה. אם ה-session נוצר בתיקייה אחרת (המשתמש
        // בחר תיקייה חדשה) — "No conversation found". לא להציג שגיאה: לשכוח את ה-session
        // ולנסות שוב פעם אחת בלי --resume. התלמיד מקבל תשובה, לא "❌".
        if (
          sessionId &&
          !opts.noResumeRetry &&
          /No conversation found|session/i.test(stderr)
        ) {
          console.log("[claude] session לא תקף בתיקייה הזו — מתחיל שיחה חדשה");
          delete sessions[userJid];
          saveSessions();
          resolve(askClaude(userJid, text, { noResumeRetry: true }));
          return;
        }
        // שגיאה אמיתית — להראות מה קרה, לא משפט גנרי שמפנה למקום הלא נכון
        const why = stderr.trim().split("\n").pop() || `קוד ${code}`;
        resolve({
          ok: false,
          text: `❌ Claude לא הצליח לענות: ${why.slice(0, 160)}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.session_id) {
          sessions[userJid] = parsed.session_id;
          saveSessions();
        }
        const reply = parsed.result || parsed.text || "✓";
        resolve({ ok: true, text: reply });
      } catch {
        resolve({ ok: true, text: stdout.trim() || "✓" });
      }
    });
  });
}

// ----- החלפת מודל מהוואטסאפ ("תעבור לאופוס" / "תחזור לסונט") -----
// עובד לכל provider (כרום/Green). משותף.
const MODEL_ALIASES = [
  { rx: /(אופוס|opus)/i, model: "opus", name: "אופוס 5" },
  { rx: /(סונטה|סונט|sonnet)/i, model: "sonnet", name: "סונט" },
  { rx: /(הייקו|haiku)/i, model: "haiku", name: "הייקו" },
];
function detectModelSwitch(text) {
  const t = (text || "").trim();
  // חייבת להיות כוונת החלפה מפורשת — לא סתם אזכור המילה במשפט
  const hasVerb =
    /^(תעבור|עבור|תחזור|חזור|תחליף|החלף|תשנה|שנה|מודל|model|switch|use)(\s|ל|$)/i.test(
      t,
    );
  const bare = t.replace(/^(ל|מודל\s*|model\s*)/i, "").trim();
  const isBareModel = /^(אופוס|opus|סונטה|סונט|sonnet|הייקו|haiku)$/i.test(
    bare,
  );
  if (!hasVerb && !isBareModel) return null;
  for (const a of MODEL_ALIASES) {
    if (a.rx.test(t)) return a;
  }
  return null;
}
// מחזיר טקסט אישור אם הייתה החלפה, אחרת null (ואז ההודעה ממשיכה כרגיל ל-Claude)
function applyModelSwitch(text) {
  const m = detectModelSwitch(text);
  if (!m) return null;
  if (config.model === m.model) return `כבר על ${m.name} 👍`;
  config.model = m.model;
  saveConfig(config);
  console.log(`[model] switched to ${m.model}`);
  return `עברתי ל${m.name}. מעכשיו אני עונה עם המודל הזה 💪`;
}

// ----- WhatsApp socket -----
let sock;

// ----- Provider abstraction (כרום/Baileys או Green API) -----
function isGreen() {
  return (config.provider || "baileys") === "green-api";
}

// שליחה דרך הספק הפעיל. מחזיר אובייקט עם key.id כדי שזיהוי ה-echo יעבוד בשני הספקים.
async function providerSend(jid, text) {
  if (isGreen()) {
    const r = await greenCall("sendMessage", {
      verb: "POST",
      body: { chatId: greenChatId(jid), message: text },
      timeoutMs: 30000,
    });
    return { key: { id: r?.idMessage || null } };
  }
  if (!sock) throw new Error("WhatsApp socket not ready");
  return sock.sendMessage(jid, { text });
}

// "מקליד..." — רק בכרום. ב-Green API אין את זה, ומתעלמים בשקט.
async function presence(jid, kind) {
  if (isGreen() || !sock) return;
  try {
    await sock.sendPresenceUpdate(kind, jid);
  } catch {}
}

// הפעלה מחדש של התהליך. קוד יציאה 1 בכוונה: launchd מוגדר להרים מחדש רק
// אחרי יציאה לא-תקינה (SuccessfulExit=false) — יציאה עם 0 הייתה משאירה את הבוט מת.
function restartProcess(reason) {
  console.log(`[restart] ${reason} — יוצא (קוד 1) כדי שהשירות ירים מחדש`);
  setTimeout(() => process.exit(1), 600);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Green API provider -----
// חיבור דרך Green API: יציב יותר מכרום, לא תלוי בדפדפן. הבוט מושך הודעות ב-polling
// (receiveNotification) — בלי שרת ובלי כתובת ציבורית. ה-QR מגיע מ-Green API ומוצג באותו מסך.
function greenCreds() {
  // ה-instanceId (לא סודי) ב-config; הטוקן (סודי) רק ב-.env דרך process.env.
  const g = config.greenApi || {};
  const instanceId = String(
    g.instanceId || process.env.GREEN_API_INSTANCE_ID || "",
  ).replace(/\D/g, "");
  const token = String(process.env.GREEN_API_TOKEN || "").trim();
  const source = instanceId && token ? "env" : "none";
  return { instanceId, token, source };
}

// מה שמותר להראות למסך — בלי ה-token
function greenPublicInfo() {
  const c = greenCreds();
  return { instanceId: c.instanceId, hasToken: !!c.token, source: c.source };
}

// Green API מפנה כל instance לשרת לפי 4 הספרות הראשונות (למשל 7105 → 7105.api.greenapi.com)
function greenBaseUrl(creds) {
  const prefix = creds.instanceId.slice(0, 4);
  const host =
    prefix.length === 4
      ? `https://${prefix}.api.greenapi.com`
      : "https://api.green-api.com";
  return `${host}/waInstance${creds.instanceId}`;
}

async function greenCall(
  method,
  {
    verb = "GET",
    body,
    query = "",
    extraPath = "",
    timeoutMs = 15000,
    creds,
  } = {},
) {
  const c = creds || greenCreds();
  if (!c.instanceId || !c.token)
    throw new Error("missing Green API credentials");
  const opts = {
    method: verb,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  };
  const tail = `/${method}/${c.token}${extraPath}${query}`;
  let r;
  try {
    r = await fetch(`${greenBaseUrl(c)}${tail}`, opts);
  } catch (e) {
    // Instance ID עם קידומת לא קיימת → הכתובת הייעודית לא נפתרת ב-DNS. מנסים את הכתובת הכללית,
    // שמחזירה תשובה מסודרת (למשל 401/403) במקום "אין תקשורת" מטעה.
    r = await fetch(
      `https://api.green-api.com/waInstance${c.instanceId}${tail}`,
      opts,
    );
  }
  const text = await r.text();
  // Green API מחזיר 408 על receiveNotification כשאין הודעות חדשות — זה תקין ומתועד, לא שגיאה.
  // בלי זה: כל בדיקה ריקה נספרת ככשל → האטה מצטברת עד 30 שניות בין בדיקות → במספר שקט
  // (בדיוק מה שמומלץ לתלמידים) העוזר "לא עונה". רק ל-polling — ב-sendMessage 408 הוא כשל אמיתי.
  if (r.status === 408 && method === "receiveNotification") return null;
  if (!r.ok)
    throw new Error(`${method} → HTTP ${r.status}: ${text.slice(0, 160)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function greenErrorHe(msg) {
  const m = String(msg || "");
  if (/expired/i.test(m))
    return "ה-instance ב-Green API פג תוקף. מחדשים אותו בקונסול (console.green-api.com) והעוזר יתחבר לבד.";
  if (/HTTP 401|HTTP 403|unauthorized|forbidden/i.test(m))
    return "Green API דחה את הפרטים — בודקים Instance ID ו-API Token בהגדרות.";
  if (/HTTP 404/i.test(m))
    return "Instance ID לא נמצא ב-Green API — בודקים את המספר בהגדרות.";
  if (/HTTP 429/i.test(m))
    return "Green API מגביל קצב כרגע (429). העוזר ינסה שוב בעוד רגע.";
  if (/abort|timeout|fetch failed|ENOTFOUND|ECONN/i.test(m))
    return "אין תקשורת עם Green API — בודקים חיבור לאינטרנט. העוזר ינסה שוב.";
  return `שגיאת Green API: ${m.slice(0, 160)}`;
}

const GREEN_STATE_HE = {
  authorized: "מחובר לוואטסאפ",
  notAuthorized: "מחכה לסריקת QR",
  blocked: "חסום",
  starting: "מתחיל",
  yellowCard:
    "מוגבל זמנית על ידי Green (yellowCard) — קורה אחרי הרבה הודעות ברצף. עובר לבד תוך דקות; לא צריך לעשות כלום",
  sleepMode: "במצב שינה",
};

function greenChatId(jid) {
  return String(jid || "").replace("@s.whatsapp.net", "@c.us");
}

let greenGeneration = 0; // כל הפעלה מחדש מקדמת את המונה — לולאות ישנות מפסיקות לבד

function greenRestart(delayMs = 1500) {
  greenGeneration++;
  setTimeout(() => startGreenApi(), delayMs);
}

// מוודא שההודעות מגיעות לבוט: נכנסות + יוצאות מהטלפון (self-chat), בלי echo של מה שהבוט עצמו שולח.
// ב-webhookUrl לא נוגעים אוטומטית — אם מוגדר, ההודעות הולכות לשם ולא לבוט, ומדווחים על זה במסך.
async function greenEnsureSettings() {
  let s = null;
  try {
    s = await greenCall("getSettings");
  } catch (e) {
    console.log("[green] getSettings failed:", e.message);
    return;
  }
  state.greenWebhookConflict = !!(s?.webhookUrl && String(s.webhookUrl).trim());
  if (state.greenWebhookConflict) {
    console.log(
      `[green] ⚠️ webhookUrl מוגדר ב-instance (${s.webhookUrl}) — ההודעות לא יגיעו לעוזר עד שינוקה`,
    );
    // מצב יציב למסך (לא מהבהב): הבעיה + מה עושים. ה-polling לא ידרוס אותו.
    state.status = "green-webhook";
    state.lastError =
      "ב-Green API מוגדרת כתובת webhook — ההודעות הולכות לשם ולא לעוזר. בקונסול של Green: הגדרות ← Webhook URL ← למחוק, ואז 'התחבר מחדש'.";
  }
  const want = {
    incomingWebhook: "yes",
    outgoingMessageWebhook: "yes",
    outgoingAPIMessageWebhook: "no",
    stateWebhook: "yes",
  };
  const patch = {};
  for (const [k, v] of Object.entries(want)) {
    if (s?.[k] !== v) patch[k] = v;
  }
  if (Object.keys(patch).length) {
    try {
      await greenCall("setSettings", { verb: "POST", body: patch });
      console.log("[green] settings updated:", JSON.stringify(patch));
    } catch (e) {
      console.log("[green] setSettings failed:", e.message);
    }
  }
}

async function startGreenApi() {
  const gen = ++greenGeneration;
  const creds = greenCreds();
  state.qr = null;
  state.meLid = null;
  if (!creds.instanceId || !creds.token) {
    state.status = "green-setup";
    state.lastError =
      "חסרים Instance ID ו-API Token של Green API — מזינים אותם בהגדרות ← איך העוזר מחובר.";
    console.log("[green] no credentials — waiting for setup");
    return;
  }
  console.log(
    `[green] starting (instance ${creds.instanceId}, credentials from ${creds.source})`,
  );
  state.status = "connecting";
  state.lastError = null;

  // 1) מחכים לאישור (סריקת QR)
  while (gen === greenGeneration) {
    let st;
    try {
      st = await greenCall("getStateInstance");
    } catch (e) {
      state.status = "error";
      state.lastError = greenErrorHe(e.message);
      state.stats.errors++;
      console.log("[green] state error:", e.message);
      await sleep(15000);
      continue;
    }
    const s = st?.stateInstance;
    if (s === "authorized") break;
    if (s === "notAuthorized") {
      try {
        const q = await greenCall("qr");
        if (q?.type === "qrCode" && q.message) {
          state.qr = `data:image/png;base64,${q.message}`;
          state.status = "qr";
          state.lastError = null;
        } else if (q?.type !== "alreadyLogged") {
          state.status = "connecting";
          state.lastError = q?.message ? `Green API: ${q.message}` : null;
        }
      } catch (e) {
        state.lastError = greenErrorHe(e.message);
      }
      await sleep(3500);
      continue;
    }
    // starting / yellowCard / blocked / sleepMode
    state.status = s === "blocked" ? "error" : "connecting";
    state.lastError =
      s === "blocked"
        ? "החשבון חסום ב-Green API (blocked) — בודקים בקונסול."
        : `Green API במצב "${GREEN_STATE_HE[s] || s || "לא ידוע"}" — ממתין...`;
    await sleep(5000);
  }
  if (gen !== greenGeneration) return;

  // 2) מחובר — מזהים את המספר שלנו (בשביל self-chat ו-lockdown)
  let phone = "";
  try {
    const wa = await greenCall("getWaSettings");
    phone = String(wa?.phone || "").replace(/\D/g, "");
    state.meName = wa?.name || "";
  } catch (e) {
    console.log("[green] getWaSettings failed:", e.message);
  }
  // אין fallback ממשתנה סביבה: המספר שמותר לדבר עם העוזר נקבע רק על ידי
  // Green (getWaSettings) או על ידי ההודעה הראשונה מהטלפון (wid) — לא על ידי
  // ערך שמישהו הגדיר במחשב. אחרת משתנה סביבה יכול להחליף את גבול האבטחה.
  state.meJid = phone ? `${phone}@c.us` : null;
  state.qr = null;
  state.status = "connected";
  state.lastError = null;
  state.greenLastPoll = Date.now();
  if (state.meJid) ensureSelfWhitelisted();
  // לפני שמתחילים לענות — מנקים הודעות ישנות שנשארו בתור (מונע תשובות כפולות אחרי ריסטארט)
  await greenDrainStaleQueue(gen);
  if (gen !== greenGeneration) return;
  console.log(
    `[green] connected as ${state.meJid || "(המספר יזוהה בהודעה הראשונה)"}`,
  );
  if (config.lockdownMode !== false) {
    console.log(
      `🔒 LOCKDOWN פעיל — רק ${jidUser(state.meJid) || "המספר של ה-instance"} יכול להשתמש בעוזר.`,
    );
  }
  await greenEnsureSettings();

  // הודעת ברכה אוטומטית בחיבור הראשון (כמו בכרום)
  if (!config.welcomeSent && config.welcomeMessage && state.meJid) {
    setTimeout(async () => {
      if (gen !== greenGeneration) return;
      const sent = await sendBotMessage(state.meJid, config.welcomeMessage);
      if (sent) {
        config.welcomeSent = true;
        saveConfig(config);
        state.stats.messagesOut++;
        pushFeed({
          dir: "out",
          to: jidUser(state.meJid),
          text: config.welcomeMessage,
        });
        console.log(`[welcome] sent to ${state.meJid}`);
      }
    }, 3000);
  }

  greenPollLoop(gen);
}

async function greenPollLoop(gen) {
  let errs = 0;
  while (gen === greenGeneration) {
    try {
      const n = await greenCall("receiveNotification", {
        query: "?receiveTimeout=20",
        timeoutMs: 40000,
      });
      state.greenLastPoll = Date.now();
      errs = 0;
      // חיבור חזר. אבל אם יש webhook שגוזל את ההודעות — נשארים במצב היציב "green-webhook"
      // (ולא מהבהבים בין "מחובר" ל"בעיה" בכל סבב polling).
      if (state.greenWebhookConflict) {
        if (state.status !== "green-webhook") state.status = "green-webhook";
      } else if (
        state.status === "reconnecting" ||
        state.status === "error" ||
        state.status === "green-webhook"
      ) {
        state.status = "connected";
        state.lastError = null;
      }
      if (!n || n.receiptId == null) continue;
      try {
        await handleGreenNotification(n.body || {});
      } catch (e) {
        console.error("[green/handler]", e);
        state.stats.errors++;
        state.lastError = e.message;
      }
      try {
        await greenCall("deleteNotification", {
          verb: "DELETE",
          extraPath: `/${n.receiptId}`,
          timeoutMs: 10000,
        });
      } catch (e) {
        console.log("[green] deleteNotification failed:", e.message);
      }
    } catch (e) {
      errs++;
      const msg = e.message || "";
      console.log(`[green] poll error #${errs}: ${msg}`);
      state.lastError = greenErrorHe(msg);
      if (/expired|HTTP 401|HTTP 403|HTTP 404/i.test(msg)) {
        state.status = "error";
        state.stats.errors++;
      } else if (errs >= 3) {
        state.status = "reconnecting";
      }
      await sleep(Math.min(30000, 2000 * errs));
      // אחרי כמה כשלונות רצופים — בודקים מחדש את מצב ה-instance (אולי נותק וצריך QR חדש)
      if (errs % 5 === 0 && gen === greenGeneration) {
        greenRestart(0);
        return;
      }
    }
  }
}

// מתרגם הודעה של Green API למבנה שה-handleMessage המשותף מכיר (אותה לוגיקה: self-chat, lockdown, echo)
// ----- Green: מניעת תשובות כפולות -----
// Green שומר תור של הודעות. אחרי ריסטארט/החלפת ספק, הודעות שכבר נענו (או שהגיעו
// בזמן שהעוזר היה כבוי) מוגשות שוב — והעוזר היה עונה עליהן פעם נוספת.
// פתרון: (1) זוכרים אילו idMessage כבר טופלו — גם אחרי ריסטארט (נשמר לקובץ);
//         (2) בעלייה מרוקנים את התור הישן לפני שמתחילים לענות.
const GREEN_SEEN_PATH = path.join(__dirname, "green-seen.json");
let greenSeen = [];
try {
  greenSeen = JSON.parse(fs.readFileSync(GREEN_SEEN_PATH, "utf8"));
  if (!Array.isArray(greenSeen)) greenSeen = [];
} catch {}
const greenSeenSet = new Set(greenSeen);
function greenAlreadyHandled(id) {
  if (!id) return false;
  if (greenSeenSet.has(id)) return true;
  greenSeenSet.add(id);
  greenSeen.push(id);
  if (greenSeen.length > 500) {
    const drop = greenSeen.splice(0, greenSeen.length - 300);
    drop.forEach((x) => greenSeenSet.delete(x));
  }
  try {
    fs.writeFileSync(GREEN_SEEN_PATH, JSON.stringify(greenSeen));
  } catch {}
  return false;
}
// מרוקן את התור שנשאר ב-Green מלפני העלייה (הודעות ישנות — לא עונים עליהן שוב)
async function greenDrainStaleQueue(gen) {
  let drained = 0;
  for (let i = 0; i < 200 && gen === greenGeneration; i++) {
    let n;
    try {
      n = await greenCall("receiveNotification", {
        query: "?receiveTimeout=1",
        timeoutMs: 8000,
      });
    } catch {
      break;
    }
    if (!n || n.receiptId == null) break;
    // הודעות: מסמנים כטופלו ומוחקים. אירועי מצב: נותנים להם לעבור (חשובים).
    const t = n.body?.typeWebhook;
    if (t === "incomingMessageReceived" || t === "outgoingMessageReceived") {
      greenAlreadyHandled(n.body?.idMessage);
      drained++;
    } else {
      try {
        await handleGreenNotification(n.body || {});
      } catch {}
    }
    try {
      await greenCall("deleteNotification", {
        verb: "DELETE",
        extraPath: `/${n.receiptId}`,
        timeoutMs: 10000,
      });
    } catch {
      break;
    }
  }
  if (drained)
    console.log(
      `[green] ניקיתי ${drained} הודעות ישנות מהתור — לא עונים עליהן שוב`,
    );
}

// מצבים חולפים של Green מיד אחרי סריקה (starting/…) — לא ניתוק. ריסטארט רק על ניתוק אמיתי.
const GREEN_REAL_DISCONNECT = new Set([
  "notAuthorized",
  "blocked",
  "sleepMode",
]);

async function handleGreenNotification(body) {
  const type = body.typeWebhook;
  if (type === "stateInstanceChanged") {
    console.log(`[green] state changed → ${body.stateInstance}`);
    if (GREEN_REAL_DISCONNECT.has(body.stateInstance)) {
      state.status = "reconnecting";
      state.lastError = "החיבור לוואטסאפ נותק ב-Green API — מכין QR חדש";
      greenRestart(1000);
    }
    return;
  }
  if (type !== "incomingMessageReceived" && type !== "outgoingMessageReceived")
    return;
  // הודעה שכבר טופלה (תור ישן / הגשה חוזרת) — לא עונים פעמיים
  if (greenAlreadyHandled(body.idMessage)) {
    console.log(`[green/skip-dup] ${body.idMessage}`);
    return;
  }
  const wid = body.instanceData?.wid;
  if (!state.meJid && wid) {
    state.meJid = wid;
    ensureSelfWhitelisted();
    console.log(`[green] me = ${wid}`);
  }
  const md = body.messageData || {};
  const text =
    md.textMessageData?.textMessage ||
    md.extendedTextMessageData?.text ||
    md.fileMessageData?.caption ||
    "";
  const chatId = body.senderData?.chatId || "";
  if (!chatId) return;
  await handleMessage({
    key: {
      id: body.idMessage,
      fromMe: type === "outgoingMessageReceived",
      remoteJid: chatId,
    },
    message: { conversation: text },
  });
}

// ----- Boot dispatcher -----
async function startBot() {
  if (isGreen()) return startGreenApi();
  return startBaileys();
}

// ----- WhatsApp socket (כרום / Baileys) -----
async function startBaileys() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["העוזר האישי", "Chrome", "1.0"],
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      state.status = "qr";
      state.qr = await qrcode.toDataURL(qr, { margin: 2, width: 320 });
      console.log("[wa] QR ready");
    }
    if (connection === "open") {
      state.status = "connected";
      state.qr = null;
      state.meJid = sock.user?.id;
      state.meLid = sock.user?.lid || sock.authState?.creds?.me?.lid || null;
      state.meName = sock.user?.name || sock.user?.verifiedName || "";
      resetDriftCounter(); // חיבור הצליח — מאפסים את הספירה
      ensureSelfWhitelisted();
      console.log(
        `[wa] connected as ${state.meJid} (lid: ${state.meLid || "none"})`,
      );
      if (config.lockdownMode !== false) {
        console.log(
          `🔒 LOCKDOWN פעיל — רק ${jidUser(state.meJid)} יכול להשתמש בעוזר. מספרים אחרים נדחים אוטומטית.`,
        );
      }
      // הודעת ברכה אוטומטית בחיבור הראשון
      if (!config.welcomeSent && config.welcomeMessage) {
        setTimeout(async () => {
          const targetJid = state.meLid || state.meJid;
          const sent = await sendBotMessage(targetJid, config.welcomeMessage);
          if (sent) {
            config.welcomeSent = true;
            saveConfig(config);
            state.stats.messagesOut++;
            pushFeed({
              dir: "out",
              to: jidUser(targetJid),
              text: config.welcomeMessage,
            });
            console.log(`[welcome] sent to ${targetJid}`);
          }
        }, 3000);
      }
    } else if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[wa] closed code=${code} loggedOut=${loggedOut}`);
      state.status = loggedOut ? "logged-out" : "reconnecting";

      // Watchdog: עקוב אחרי ניתוקים לא-צפויים. אם זוהה דריפט (5 ניתוקים ב-30 דק')
      // → אילוץ סריקה מחדש (הוא הפתרון הוודאי לדריפט של Baileys).
      let forceRescan = loggedOut;
      if (!loggedOut && !driftRecoveryInProgress) {
        const isDrift = trackDisconnect();
        if (isDrift) {
          driftRecoveryInProgress = true;
          console.log(
            `🔄 [watchdog] דריפט זוהה — מנקה auth ומציג QR חדש לסריקה`,
          );
          forceRescan = true;
          resetDriftCounter();
          state.status = "needs-rescan";
          state.lastError =
            "החיבור ל-WhatsApp דרש רענון. ייפתח QR חדש לסריקה (10 שניות).";
        }
      }

      if (forceRescan) {
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch {}
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }
      setTimeout(
        () => {
          driftRecoveryInProgress = false;
          startBot();
        },
        forceRescan ? 1500 : 3000,
      );
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log(`[upsert] type=${type} count=${messages.length}`);
    for (const msg of messages) {
      const k = msg.key || {};
      const hasMsg = !!msg.message;
      const msgKeys = msg.message ? Object.keys(msg.message).slice(0, 3) : [];
      console.log(
        `[upsert/m] fromMe=${k.fromMe} jid=${k.remoteJid} hasMsg=${hasMsg} keys=${msgKeys.join(",")}`,
      );
      if (type !== "notify" && type !== "append") continue;
      try {
        await handleMessage(msg);
      } catch (e) {
        console.error("[handler]", e);
        state.stats.errors++;
        state.lastError = e.message;
      }
    }
  });
}

// ----- Message handling — קריטי: self-chat fix + echo loop fix -----
async function handleMessage(msg) {
  if (!msg.message) return;

  // קריטי 1: זיהוי echo — אם זו הודעה שאני עצמי שלחתי, להתעלם
  if (msg.key?.id && myMessageIds.has(msg.key.id)) {
    console.log(`[skip/echo] own message: ${msg.key.id}`);
    return;
  }

  // קריטי 2: זיהוי כפילות — Baileys שולח לפעמים אותה הודעה כ-notify וגם כ-append
  if (isAlreadyHandled(msg.key?.id)) {
    console.log(`[skip/dup] already handled: ${msg.key.id}`);
    return;
  }

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us")) return; // לא קבוצות בגרסה הזו
  if (remoteJid === "status@broadcast") return;

  const fromMe = !!msg.key.fromMe;
  const meUser = jidUser(state.meJid);
  const meLidUser = state.meLid ? jidUser(state.meLid) : null;
  const remoteUser = jidUser(remoteJid);

  // self-chat: רק כאשר המספר/LID של היעד תואם בדיוק לזה של המכשיר.
  //   1. <phone>@s.whatsapp.net  (פורמט ישן) — remoteUser === meUser
  //   2. <LID>@lid               (LID של המכשיר עצמו) — remoteUser === meLidUser
  // קריטי: לא להשתמש ב-endsWith("@lid") כ-fallback — זה תופס גם איש קשר @lid אחר
  // ויכול לגרום לבוט לענות ללקוחות כשהמשתמש עונה להם ידנית (fromMe=true).
  const isSelfChat =
    fromMe &&
    (remoteUser === meUser || (meLidUser !== null && remoteUser === meLidUser));

  // הודעת תשובה של הבוט עצמו (לא self-chat, לא לעבד)
  if (fromMe && !isSelfChat) return;

  // אבטחה: lockdown mode — רק self-chat עובר. שום whitelist, שום יוצא מן הכלל.
  if (config.lockdownMode !== false) {
    if (!isSelfChat) {
      console.log(
        `[skip/lockdown] חסום — רק המספר שסרק את ה-QR: ${remoteUser}`,
      );
      return;
    }
  } else if (!isSelfChat && !config.whitelist.includes(remoteUser)) {
    // מצב ישן (lockdown OFF) — whitelist רגיל
    console.log(`[skip] not in whitelist: ${remoteUser}`);
    return;
  }

  // הוצאת טקסט ההודעה
  const m = msg.message;
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    "";

  if (!text) return;

  state.stats.messagesIn++;
  pushFeed({ dir: "in", from: remoteUser, text, selfChat: isSelfChat });
  console.log(
    `[in${isSelfChat ? "/self" : ""}] ${remoteUser}: ${text.slice(0, 80)}`,
  );

  // החלפת מודל מהוואטסאפ ("תעבור לאופוס" / "תחזור לסונט")
  const modelReply = applyModelSwitch(text);
  if (modelReply) {
    await sendBotMessage(remoteJid, modelReply);
    state.stats.messagesOut++;
    pushFeed({ dir: "out", to: remoteUser, text: modelReply });
    return;
  }

  // זיהוי לשון פנייה — אם זו ההודעה הראשונה אחרי הברכה, ולא ניתן עדיין
  if (!config.gender) {
    const trimmed = text.trim();
    if (/^זכר\b/.test(trimmed) || trimmed === "זכר") {
      config.gender = "male";
      saveConfig(config);
      console.log("[gender] set to male");
      await sendBotMessage(
        remoteJid,
        "מעולה, אתפנה אליך בלשון זכר 👍 עכשיו תכתוב לי משהו אמיתי שאתה צריך עזרה איתו.",
      );
      state.stats.messagesOut++;
      pushFeed({
        dir: "out",
        to: remoteUser,
        text: "מעולה, אתפנה אליך בלשון זכר. עכשיו תכתוב לי משהו אמיתי...",
      });
      return;
    }
    if (/^נקבה\b/.test(trimmed) || trimmed === "נקבה") {
      config.gender = "female";
      saveConfig(config);
      console.log("[gender] set to female");
      await sendBotMessage(
        remoteJid,
        "מעולה, אתפנה אלייך בלשון נקבה 👍 עכשיו תכתבי לי משהו אמיתי שאת צריכה עזרה איתו.",
      );
      state.stats.messagesOut++;
      pushFeed({
        dir: "out",
        to: remoteUser,
        text: "מעולה, אתפנה אלייך בלשון נקבה. עכשיו תכתבי לי משהו אמיתי...",
      });
      return;
    }
  }

  // זיהוי "intro mode" — פתיחת שיחה ("היי" / "שלום" / "מה אתה יודע")
  // → אפס session id (שלא ימשיך מסשן ישן) + שלח prompt מורחב להצגה עצמית
  const trimmedText = text.trim();
  // "פתיחת שיחה" = ההודעה כולה היא ברכה. לא "כל הודעה קצרה" —
  // אחרת "כן"/"אשר"/"תודה" (התשובה לשאלת האישור של העוזר!) היו מוחקים את השיחה.
  // הערה: \b לא עובד עם עברית, לכן בודקים את כל המחרוזת ולא גבול-מילה.
  const isIntroQuery =
    /^(היי|הי|שלום|הלו|מה אתה יודע|מה אתה יכול|hi|hello|hey)[\s!.,?👋🙂]*$/i.test(
      trimmedText,
    );

  let textToSend = text;
  if (isIntroQuery) {
    console.log("[intro] reset session + expanded prompt");
    delete sessions[remoteJid];
    saveSessions();
    textToSend = `המשתמש אמר: "${text}"

זו תחילת השיחה איתו. הצג את עצמך בהודעת WhatsApp קצרה ומסודרת:

1. שורת פתיחה: "היי 👋 אני ${config.agentName || "העוזר שלך"}"
2. שורה אחת מה אתה — "אני Claude Code שלך, מחובר ל-WhatsApp"
3. רשימת bullet קצרה (3-5) של מה אתה יודע לעשות. כלול אינטגרציות אמיתיות שיש לך (בדוק את הכלים ש-MCPs שזמינים לך — כמו Google Drive, Calendar, Airtable, Composio, ועוד)
4. סגור עם הזמנה לבקש משהו ספציפי

חוקים:
- מקסימום 12 שורות
- אמוג'ים רלוונטיים (לא מוגזם)
- בעברית
- לא לפתוח ב"איך אפשר לעזור"
- לא לרשום כלים שאין לך באמת (תבדוק את ה-tools שלך לפני)`;
  }

  // typing indicator (בכרום בלבד)
  await presence(remoteJid, "composing");

  const reply = await askClaude(remoteJid, textToSend);

  await presence(remoteJid, "paused");

  if (reply.text) {
    await sendBotMessage(remoteJid, reply.text);
    state.stats.messagesOut++;
    pushFeed({ dir: "out", to: remoteUser, text: reply.text });
  }
}

// ----- HTTP server (UI + API) -----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 🛡️ שער אחד לכל בקשת שינוי: בלי המפתח של הדף שלנו — נדחה.
  // מכסה את כל ה-POST (config, reset, pick-folder, new-folder, brain, resend, green/*)
  // וגם כל endpoint שיתווסף בעתיד — בלי צורך לזכור לגדר כל אחד בנפרד.
  if (req.method !== "GET" && !hasValidNonce(req)) {
    console.log(
      `[BLOCKED] 🚨 ${req.method} ${url.pathname} בלי מפתח — נדחה (בקשה שלא מהמסך שלנו)`,
    );
    state.stats.errors++;
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "forbidden" }));
    return;
  }

  // GET / — index.html
  if (req.method === "GET" && url.pathname === "/") {
    let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    // המפתח מוזרק רק לדף הזה. אתר זר לא יכול לקרוא אותו → לא יכול לזייף בקשות.
    html = html.replace(
      "<head>",
      `<head>\n    <meta name="app-nonce" content="${APP_NONCE}" />`,
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
    return;
  }

  // GET /state
  if (req.method === "GET" && url.pathname === "/state") {
    const safe = {
      ...state,
      // מזהה הפעלה: מתחלף בכל עלייה. המסך משווה — אם השתנה, הוא מרענן את עצמו
      // (אחרת הוא ממשיך עם מפתח ישן וכל לחיצה נכשלת בשקט).
      bootId: APP_NONCE.slice(0, 12),
      config: {
        agentName: config.agentName,
        workdir: config.workdir,
        model: config.model,
        mode: config.mode,
        provider: config.provider || "baileys",
        greenApi: greenPublicInfo(),
        lockdownMode: config.lockdownMode !== false,
        whitelist: config.whitelist,
        systemPromptAppend: config.systemPromptAppend,
        botRole: config.botRole || "",
        botTone: config.botTone || "",
        botDos: config.botDos || "",
        botDonts: config.botDonts || "",
        welcomeMessage: config.welcomeMessage,
        welcomeSent: config.welcomeSent,
      },
      feed: feed.slice(0, 20),
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(safe));
    return;
  }

  // GET /check-claude — בדיקה אם CLI מותקן ומחובר
  if (req.method === "GET" && url.pathname === "/check-claude") {
    const claudeBin = process.env.CLAUDE_BIN || "claude";
    const child = spawn(claudeBin, ["--version"], { env: { ...process.env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      if (res.headersSent) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          installed: false,
          error: e.message || "claude not found in PATH",
        }),
      );
    });
    child.on("close", (code) => {
      if (res.headersSent) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: code === 0,
          installed: code === 0,
          version: out.trim() || null,
          error: code !== 0 ? err.trim() : null,
        }),
      );
    });
    return;
  }

  // POST /resend-welcome — שלח שוב את הודעת הברכה
  if (req.method === "POST" && url.pathname === "/resend-welcome") {
    if (state.status !== "connected" || !state.meJid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not connected" }));
      return;
    }
    const targetJid = state.meLid || state.meJid;
    providerSend(targetJid, config.welcomeMessage)
      .then(() => {
        config.welcomeSent = true;
        saveConfig(config);
        state.stats.messagesOut++;
        pushFeed({
          dir: "out",
          to: jidUser(targetJid),
          text: config.welcomeMessage,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }

  // POST /config — עדכון הגדרות
  if (req.method === "POST" && url.pathname === "/config") {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      try {
        const next = JSON.parse(body);
        // אבטחה: ב-lockdown mode, ה-API לא יכול להוסיף מספרים ל-whitelist
        // ולא יכול לכבות את ה-lockdown עצמו. רק עריכה ידנית של config.json.
        if (config.lockdownMode !== false) {
          if (next.whitelist) {
            console.log("[lockdown] ניסיון לשנות whitelist נחסם");
            delete next.whitelist;
          }
          if (next.lockdownMode === false) {
            console.log("[lockdown] ניסיון לכבות lockdown דרך API נחסם");
            delete next.lockdownMode;
          }
        }
        // Green API — פרטי חיבור. token ריק = לא לגעת בקיים (המסך לא מציג אותו)
        let needsRestart = false;
        if (next.greenApi && typeof next.greenApi === "object") {
          // אבטחה: הטוקן לעולם לא נכנס ל-config.json. נכתב ל-.env (הרשאות 600) בלבד.
          const cur = config.greenApi || { instanceId: "" };
          const instanceId = String(
            next.greenApi.instanceId ?? cur.instanceId ?? "",
          ).replace(/\D/g, "");
          const newToken = String(next.greenApi.token || "").trim();
          const curToken = String(process.env.GREEN_API_TOKEN || "").trim();
          if (!instanceId) {
            // בלי instance — מנקים גם את הטוקן מ-.env
            if (curToken) {
              setDotEnv("GREEN_API_TOKEN", "");
              needsRestart = true;
            }
          } else if (newToken && newToken !== curToken) {
            setDotEnv("GREEN_API_TOKEN", newToken);
            needsRestart = true;
          }
          if (instanceId !== (cur.instanceId || "")) needsRestart = true;
          next.greenApi = { instanceId }; // רק המזהה הלא-סודי נשמר ב-config
        }
        if (
          next.provider !== undefined &&
          !["baileys", "green-api"].includes(next.provider)
        )
          delete next.provider;
        if (next.provider && next.provider !== (config.provider || "baileys"))
          needsRestart = true;
        // תיקייה חדשה = שיחות של Claude מתיקייה אחרת לא תקפות. מאפסים כדי לא לקבל "❌".
        if (
          next.workdir !== undefined &&
          String(next.workdir || "") !== String(config.workdir || "")
        ) {
          sessions = {};
          saveSessions();
          console.log("[sessions] workdir השתנה — שיחות אופסו");
        }
        config = { ...config, ...next };
        // safeguard: לוודא שהמספר של עצמו נשאר ב-whitelist (גם ב-lockdown — לתאימות)
        if (state.meJid) {
          const me = jidUser(state.meJid);
          if (!config.whitelist.includes(me)) config.whitelist.push(me);
        }
        saveConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, restart: needsRestart }));
        if (needsRestart) restartProcess("provider/credentials changed");
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /green/check — בדיקת פרטי Green API בלי לשמור (מהמסך)
  if (req.method === "POST" && url.pathname === "/green/check") {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      try {
        const p = JSON.parse(body || "{}");
        const cur = greenCreds();
        const creds = {
          instanceId: String(p.instanceId || cur.instanceId || "").replace(
            /\D/g,
            "",
          ),
          token: String(p.token || "").trim() || cur.token || "",
        };
        if (!creds.instanceId || !creds.token) {
          res.end(
            JSON.stringify({ ok: false, error: "חסרים Instance ID או Token" }),
          );
          return;
        }
        const st = await greenCall("getStateInstance", { creds });
        const s = st?.stateInstance || "unknown";
        res.end(
          JSON.stringify({
            ok: true,
            stateInstance: s,
            stateHe: GREEN_STATE_HE[s] || s,
          }),
        );
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: greenErrorHe(e.message) }));
      }
    });
    return;
  }

  // POST /green/use-polling — מנקה webhookUrl ב-instance כדי שההודעות יגיעו לעוזר (פעולה מפורשת מהמסך)
  if (req.method === "POST" && url.pathname === "/green/use-polling") {
    greenCall("setSettings", {
      verb: "POST",
      body: { webhookUrl: "", webhookUrlToken: "" },
    })
      .then(() => {
        state.greenWebhookConflict = false;
        console.log(
          "[green] webhookUrl cleared by user — switching to polling",
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        greenRestart(1000);
      })
      .catch((e) => {
        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, error: greenErrorHe(e.message) }));
      });
    return;
  }

  // POST /reset — להתחיל מחדש (כרום: מחיקת auth · Green API: logout) ואז הפעלה מחדש של התהליך
  if (req.method === "POST" && url.pathname === "/reset") {
    const finish = () => {
      res.writeHead(200);
      res.end('{"ok":true}');
      restartProcess("reset from UI");
    };
    if (isGreen()) {
      greenCall("logout")
        .catch((e) => console.log("[green] logout failed:", e.message))
        .finally(finish);
      return;
    }
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch {}
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    finish();
    return;
  }

  // POST /pick-folder — פותח את חלון בחירת התיקייה של המחשב (Mac/Windows)
  // התלמיד לא מקליד נתיבים. בוחר, וזהו.
  if (req.method === "POST" && url.pathname === "/pick-folder") {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "powershell" : "osascript";
    const args = isWin
      ? [
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'בחר תיקייה לעוזר'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
        ]
      : [
          "-e",
          'POSIX path of (choose folder with prompt "בחר תיקייה שהעוזר יעבוד בה")',
        ];
    const child = spawn(cmd, args);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => {
      if (res.headersSent) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "dialog-failed" }));
    });
    child.on("close", () => {
      if (res.headersSent) return;
      const picked = out.trim().replace(/[\\/]+$/, "");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!picked) {
        // המשתמש ביטל — לא שגיאה
        res.end(JSON.stringify({ ok: false, cancelled: true }));
        return;
      }
      // הגנה: שומרים רק תיקייה אמיתית שקיימת. חלון שנכשל/רץ בלי מסך
      // עלול להחזיר נתיב שגוי — ואסור שזה ידרוס תיקייה טובה שכבר נבחרה.
      let isDir = false;
      try {
        isDir = fs.statSync(picked).isDirectory();
      } catch {}
      // חלון שרץ בלי מסך (רקע/headless) מחזיר את תיקיית הבית במקום לבטל.
      // תיקיית הבית הגולמית היא לא בחירה אמיתית לבוט — מתייחסים אליה כביטול.
      const home = (process.env.HOME || "").replace(/[\\/]+$/, "");
      if (!isDir || picked === home) {
        console.log(
          `[workdir] rejected (${isDir ? "home-fallback" : "not a directory"}): ${picked}`,
        );
        res.end(
          JSON.stringify({
            ok: false,
            cancelled: picked === home,
            error: isDir ? "home-fallback" : "not-a-directory",
          }),
        );
        return;
      }
      config.workdir = picked;
      saveConfig(config);
      sessions = {};
      saveSessions(); // תיקייה חדשה → שיחות Claude מתיקייה אחרת לא תקפות
      console.log(`[workdir] set to: ${picked}`);
      res.end(JSON.stringify({ ok: true, workdir: picked }));
    });
    return;
  }

  // POST /new-folder — יוצר תיקייה חדשה על שולחן העבודה ובוחר אותה (להדגמה ולמי שלא מוצא בחלון)
  if (req.method === "POST" && url.pathname === "/new-folder") {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      try {
        const raw = (JSON.parse(body || "{}").name || "").trim();
        // שם בטוח: בלי תווי נתיב, עד 60 תווים
        const name = raw.replace(/[\\/:*?"<>|]/g, "").slice(0, 60);
        if (!name) {
          res.end(JSON.stringify({ ok: false, error: "empty-name" }));
          return;
        }
        const desktop = path.join(process.env.HOME || "", "Desktop");
        const base = fs.existsSync(desktop) ? desktop : process.env.HOME;
        const dir = path.join(base, name);
        fs.mkdirSync(dir, { recursive: true });
        config.workdir = dir;
        saveConfig(config);
        sessions = {};
        saveSessions(); // תיקייה חדשה → שיחות Claude מתיקייה אחרת לא תקפות
        console.log(`[workdir] created + set: ${dir}`);
        res.end(JSON.stringify({ ok: true, workdir: dir }));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET/POST /brain — קובץ ההנחיות של העוזר (העוזר-שלי.md בתיקיית העבודה)
  if (url.pathname === "/brain") {
    const brainPath = path.join(
      config.workdir || process.env.HOME,
      "העוזר-שלי.md",
    );
    if (req.method === "GET") {
      let text = "";
      try {
        text = fs.readFileSync(brainPath, "utf8");
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({ ok: true, text, path: brainPath, exists: !!text }),
      );
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c.toString()));
      req.on("end", () => {
        try {
          const { text } = JSON.parse(body);
          fs.writeFileSync(brainPath, text || "", "utf8");
          console.log(
            `[brain] saved (${(text || "").length} chars) → ${brainPath}`,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, path: brainPath }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[ui] http://127.0.0.1:${PORT}`);
  // פתח דפדפן — רק בהפעלה הראשונה. כל ריסטארט (החלפת ספק, קריסה) לא פותח עוד טאב.
  const url = `http://127.0.0.1:${PORT}`;
  const OPENED_MARK = path.join(__dirname, ".opened");
  if (process.env.BROWSER === "false" || fs.existsSync(OPENED_MARK)) return;
  try {
    fs.writeFileSync(OPENED_MARK, String(Date.now()));
  } catch {}
  try {
    const tryChrome = spawn("open", ["-a", "Google Chrome", url], {
      detached: true,
      stdio: "ignore",
    });
    tryChrome.on("exit", (code) => {
      if (code !== 0) {
        // אין Chrome - fallback לברירת מחדל
        spawn("open", [url], { detached: true, stdio: "ignore" });
      }
    });
  } catch {
    try {
      spawn("open", [url], { detached: true, stdio: "ignore" });
    } catch {}
  }
});

// ----- Boot -----
startBot().catch((e) => {
  console.error("[boot]", e);
  state.status = "error";
  state.lastError = e.message;
});
