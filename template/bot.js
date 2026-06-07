// talbs-whatsapp-bot — בוט WhatsApp + Claude עם תיקון self-chat
// בנוי לסדנה של טל בשור.
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

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {
      agentName: "הבוט שלי",
      workdir: process.env.HOME,
      model: "sonnet",
      whitelist: [],
      systemPromptAppend: "",
      permissionMode: "bypassPermissions",
    };
  }
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
    const args = [
      "-p",
      text,
      "--model",
      config.model || "sonnet",
      "--permission-mode",
      config.permissionMode || "bypassPermissions",
      "--output-format",
      "json",
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    if (config.systemPromptAppend) {
      args.push("--append-system-prompt", config.systemPromptAppend);
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
    browser: ["הבוט של טל", "Chrome", "1.0"],
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
      state.meLid = sock.user?.lid || null;
      state.meName = sock.user?.name || sock.user?.verifiedName || "";
      ensureSelfWhitelisted();
      console.log(
        `[wa] connected as ${state.meJid} (lid: ${state.meLid || "none"})`,
      );
    } else if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[wa] closed code=${code} loggedOut=${loggedOut}`);
      state.status = loggedOut ? "logged-out" : "reconnecting";
      if (loggedOut) {
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch {}
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }
      setTimeout(startBot, loggedOut ? 1500 : 3000);
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

// ----- Message handling — קריטי: self-chat fix -----
async function handleMessage(msg) {
  if (!msg.message) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us")) return; // לא קבוצות בגרסה הזו
  if (remoteJid === "status@broadcast") return;

  const fromMe = !!msg.key.fromMe;
  const meUser = jidUser(state.meJid);
  const meLidUser = state.meLid ? jidUser(state.meLid) : null;
  const remoteUser = jidUser(remoteJid);

  // self-chat: ב-WhatsApp החדש זה יכול להגיע ב-2 פורמטים:
  //   1. <phone>@s.whatsapp.net  (פורמט ישן)
  //   2. <LID>@lid               (פורמט חדש)
  // אנחנו תופסים את שניהם
  const isSelfChat =
    fromMe &&
    (remoteUser === meUser || (meLidUser && remoteUser === meLidUser));

  // הודעת תשובה של הבוט עצמו (לא self-chat, לא לעבד)
  if (fromMe && !isSelfChat) return;

  // whitelist check (הודעה רגילה ממישהו אחר)
  if (!isSelfChat && !config.whitelist.includes(remoteUser)) {
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

  // typing indicator
  try {
    await sock.sendPresenceUpdate("composing", remoteJid);
  } catch {}

  const reply = await askClaude(remoteJid, text);

  try {
    await sock.sendPresenceUpdate("paused", remoteJid);
  } catch {}

  if (reply.text) {
    await sock.sendMessage(remoteJid, { text: reply.text });
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
        whitelist: config.whitelist,
        systemPromptAppend: config.systemPromptAppend,
      },
      feed: feed.slice(0, 20),
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(safe));
    return;
  }

  // POST /config — עדכון הגדרות
  if (req.method === "POST" && url.pathname === "/config") {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      try {
        const next = JSON.parse(body);
        config = { ...config, ...next };
        // safeguard: לוודא שהמספר של עצמו נשאר ב-whitelist
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

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[ui] http://127.0.0.1:${PORT}`);
  // פתח דפדפן ברקע (Mac)
  try {
    spawn("open", [`http://127.0.0.1:${PORT}`], {
      detached: true,
      stdio: "ignore",
    });
  } catch {}
});

// ----- Boot -----
startBot().catch((e) => {
  console.error("[boot]", e);
  state.status = "error";
  state.lastError = e.message;
});
