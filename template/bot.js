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
import qrcode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Config -----
const CONFIG_PATH = path.join(__dirname, "config.json");
const SESSIONS_PATH = path.join(__dirname, "sessions.json");
const FEED_PATH = path.join(__dirname, "feed.json");
const AUTH_DIR = path.join(__dirname, "auth");
const PORT = 7655;

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
    provider: "baileys", // TODO: support "green-api" in future
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
    const sent = await sock.sendMessage(jid, { text: message });
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
function askClaude(userJid, text) {
  return new Promise((resolve) => {
    const sessionId = sessions[userJid];
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
        resolve({
          ok: false,
          text: "❌ שגיאה בשיחה עם Claude. בדוק שה-CLI מחובר.",
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

async function startBot() {
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
  const isIntroQuery =
    /^(היי|הי|שלום|מה אתה יודע|מה אתה יכול|hi|hello|hey)\b/i.test(
      trimmedText,
    ) || trimmedText.length < 6;

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

  // typing indicator
  try {
    await sock.sendPresenceUpdate("composing", remoteJid);
  } catch {}

  const reply = await askClaude(remoteJid, textToSend);

  try {
    await sock.sendPresenceUpdate("paused", remoteJid);
  } catch {}

  if (reply.text) {
    await sendBotMessage(remoteJid, reply.text);
    state.stats.messagesOut++;
    pushFeed({ dir: "out", to: remoteUser, text: reply.text });
  }
}

// ----- HTTP server (UI + API) -----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET / — index.html
  if (req.method === "GET" && url.pathname === "/") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // GET /state
  if (req.method === "GET" && url.pathname === "/state") {
    const safe = {
      ...state,
      config: {
        agentName: config.agentName,
        workdir: config.workdir,
        model: config.model,
        mode: config.mode,
        provider: config.provider || "baileys",
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
    sock
      .sendMessage(targetJid, { text: config.welcomeMessage })
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
        config = { ...config, ...next };
        // safeguard: לוודא שהמספר של עצמו נשאר ב-whitelist (גם ב-lockdown — לתאימות)
        if (state.meJid) {
          const me = jidUser(state.meJid);
          if (!config.whitelist.includes(me)) config.whitelist.push(me);
        }
        saveConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, config }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /reset — להתחיל מחדש (מחיקת auth)
  if (req.method === "POST" && url.pathname === "/reset") {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch {}
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    res.writeHead(200);
    res.end('{"ok":true}');
    setTimeout(() => process.exit(0), 500);
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
  // פתח דפדפן ברקע — Chrome אם קיים, אחרת ברירת מחדל
  const url = `http://127.0.0.1:${PORT}`;
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
