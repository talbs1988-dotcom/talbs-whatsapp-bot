#!/bin/bash
# install.sh — התקנה מלאה של העוזר האישי · טל בשור
# מתבצע פעם אחת. אחרי זה העוזר פועל לבדו ויעלה גם אחרי כיבוי המחשב.
set -e

BOT_DIR="$HOME/talbs-whatsapp-bot"
PORT=7655
LABEL="com.talbs.workshop-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$BOT_DIR/logs"
LOG="$LOG_DIR/assistant.log"
UID_="$(id -u)"

# ---------- 0) בדיקות מקדימות — לפני שנוגעים בכלום ----------
if [ "$(uname -s)" != "Darwin" ]; then
  echo "⚠️ פקודת ההתקנה הזו היא למק. ב-Windows מתקינים לפי ההוראות בקורס (בקרוב מתקין ייעודי)."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "⚠️ Node.js לא מותקן במחשב. מתקינים מ-https://nodejs.org (הגרסה המסומנת LTS), סוגרים ופותחים מחדש את הטרמינל, ומריצים את פקודת ההתקנה שוב."
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "⚠️ גרסת Node.js ישנה מדי ($(node -v)). צריך 18 ומעלה — מעדכנים מ-https://nodejs.org ומריצים שוב."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "⚠️ npm לא נמצא (בדרך כלל מגיע עם Node.js). מתקינים Node.js מחדש מ-https://nodejs.org."
  exit 1
fi
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE_BIN="$HOME/.local/bin/claude"
if [ -z "$CLAUDE_BIN" ]; then
  echo "⚠️ Claude Code לא נמצא במחשב. העוזר יותקן, אבל לא יוכל לענות עד ש-Claude Code מותקן ומחובר."
fi

# ---------- 1) לעצור כל גרסה ישנה שרצה ----------
# חייב לקרות לפני החלפת הקבצים. אחרת התהליך הישן ממשיך להגיש את המסך הישן
# מהזיכרון, ו-launchd מפעיל אותו מחדש — והתלמיד רואה גרסה ישנה למרות שהחדשה על הדיסק.
echo "🛑 עוצר גרסה ישנה אם קיימת..."
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
# להרוג רק את מי שבאמת מאזין על הפורט (לא חיבורים של הדפדפן)
OLD_PID="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
  kill $OLD_PID 2>/dev/null || true
fi
# לחכות שהפורט באמת יתפנה (עד 10 שניות)
for i in $(seq 1 20); do
  if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️ הפורט $PORT עדיין תפוס על ידי תוכנה אחרת. סוגרים אותה ומריצים שוב."
  exit 1
fi

# ---------- 2) מורידים ומחליפים את הקוד ----------
echo "📦 מוריד את הקוד..."
rm -rf /tmp/talbs-whatsapp-bot-main
if ! curl -sfL https://github.com/talbs1988-dotcom/talbs-whatsapp-bot/archive/main.tar.gz | tar -xz -C /tmp; then
  echo "⚠️ ההורדה נכשלה — בודקים חיבור לאינטרנט ומריצים שוב. שום דבר לא שונה."
  exit 1
fi
[ -f /tmp/talbs-whatsapp-bot-main/template/bot.js ] || { echo "⚠️ הקוד שירד חסר. מריצים שוב."; exit 1; }
# שומרים הגדרות וחיבור קיימים (מי שמתקין מחדש לא מאבד את ה-QR ואת ההנחיות)
KEEP="$(mktemp -d)"
# כל מה ששייך למשתמש ולא לקוד: הגדרות, החיבור (auth), הסודות (.env),
# זיכרון השיחות (sessions), הודעות שכבר נענו (green-seen), היסטוריה (feed), הלוגים.
# התקנה חוזרת מעדכנת קוד — לא מוחקת את מה שהתלמיד בנה.
for f in config.json .env sessions.json green-seen.json feed.json .opened; do
  [ -f "$BOT_DIR/$f" ] && cp "$BOT_DIR/$f" "$KEEP/" || true
done
[ -d "$BOT_DIR/auth" ] && cp -R "$BOT_DIR/auth" "$KEEP/" || true
[ -d "$BOT_DIR/logs" ] && cp -R "$BOT_DIR/logs" "$KEEP/" || true
rm -rf "$BOT_DIR"
mv /tmp/talbs-whatsapp-bot-main/template "$BOT_DIR"
for f in config.json .env sessions.json green-seen.json feed.json .opened; do
  [ -f "$KEEP/$f" ] && cp "$KEEP/$f" "$BOT_DIR/$f" || true
done
[ -f "$BOT_DIR/.env" ] && chmod 600 "$BOT_DIR/.env" || true
[ -d "$KEEP/auth" ] && cp -R "$KEEP/auth" "$BOT_DIR/auth" || true
[ -d "$KEEP/logs" ] && cp -R "$KEEP/logs" "$BOT_DIR/logs" || true
rm -rf "$KEEP"
cd "$BOT_DIR"
chmod +x run.sh start.command 2>/dev/null || true
mkdir -p "$LOG_DIR"
touch "$LOG"
chmod 600 "$LOG"
# המתקין פותח את הדפדפן בעצמו בסוף — שהעוזר לא יפתח טאב שני
touch "$BOT_DIR/.opened"

echo "📚 מתקין תלויות (כדקה בפעם הראשונה)..."
if ! npm install --ignore-scripts --no-fund --no-audit --silent; then
  echo "⚠️ התקנת התלויות נכשלה — בודקים חיבור לאינטרנט ומריצים שוב."
  exit 1
fi

# ---------- 3) רושמים כשירות ומפעילים ----------
echo "🤖 רושם את העוזר כשירות אוטומטי..."
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_DIR="$([ -n "$CLAUDE_BIN" ] && dirname "$CLAUDE_BIN" || echo "$HOME/.local/bin")"
# ה-PATH של השירות חייב לכלול את המיקום של claude (בד"כ ~/.local/bin) ושל node
BOT_PATH="$HOME/.local/bin:$CLAUDE_DIR:$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
mkdir -p "$HOME/Library/LaunchAgents"

# CLAUDE_BIN נכנס רק אם באמת נמצא (נתיב שגוי היה גורם ל"Claude לא נמצא" גם אחרי התקנה)
CLAUDE_ENV=""
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_ENV="        <key>CLAUDE_BIN</key>
        <string>$CLAUDE_BIN</string>"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>WorkingDirectory</key>
    <string>$BOT_DIR</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$BOT_DIR/run.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$BOT_PATH</string>
$CLAUDE_ENV
    </dict>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$UID_" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"

# ---------- 4) אימות אמיתי: המסך שמוגש הוא בדיוק הגרסה שירדה עכשיו ----------
# לא "הפורט תפוס" (זה יכול להיות תהליך ישן). משווים את מזהה הגרסה שבקובץ שירד
# למזהה שבדף שהשרת מגיש בפועל. שונה = גרסה ישנה עדיין רצה = לא מצליח.
BUILD="$(grep -o 'name="app-build" content="[^"]*"' "$BOT_DIR/index.html" | head -1)"
if [ -z "$BUILD" ]; then
  echo "⚠️ הקוד שירד לא מכיל מזהה גרסה — ההתקנה נעצרה כדי לא להתקין משהו שבור."
  exit 1
fi
OK=""
for i in $(seq 1 40); do
  if curl -s "http://127.0.0.1:$PORT/" 2>/dev/null | grep -qF "$BUILD"; then OK=1; break; fi
  sleep 0.5
done

if [ -n "$OK" ]; then
  echo ""
  echo "✅ העוזר האישי מותקן ופועל — הגרסה העדכנית ($(echo "$BUILD" | sed 's/.*content="//; s/"$//'))."
  echo "✅ הוא יעלה אוטומטית גם אחרי הפעלה מחדש של המחשב."
  echo "✅ אם יקרוס — יחזור לבד תוך 10 שניות."
  [ -z "$CLAUDE_BIN" ] && echo "⚠️ תזכורת: Claude Code לא נמצא — מתקינים ומתחברים, ואז לוחצים 'בדוק ש-Claude עונה' בהגדרות."
  echo ""
  echo "🌐 הדפדפן נפתח — שם מחברים את הוואטסאפ."
  open "http://127.0.0.1:$PORT"
else
  echo "⚠️ העוזר עלה אבל המסך שמוגש אינו הגרסה החדשה, או שלא עלה בכלל."
  echo "   השורות האחרונות מהלוג:"
  tail -n 15 "$LOG" 2>/dev/null || true
  exit 1
fi
