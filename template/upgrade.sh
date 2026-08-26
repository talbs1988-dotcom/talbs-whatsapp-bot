#!/bin/bash
# upgrade.sh — עדכון העוזר האישי לגרסה העדכנית, בלי לאבד את החיבור וההגדרות
# למי שכבר התקין. שומר config.json + .env + auth (אין צורך לסרוק QR מחדש).
set -e

BOT_DIR="$HOME/talbs-whatsapp-bot"
PORT=7655
LABEL="com.talbs.workshop-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$BOT_DIR/logs"
LOG="$LOG_DIR/assistant.log"
UID_="$(id -u)"
RAW="https://raw.githubusercontent.com/talbs1988-dotcom/talbs-whatsapp-bot/main/template"
FILES="bot.js index.html package.json start.command run.sh"

if [ ! -d "$BOT_DIR" ]; then
  echo "⚠️ העוזר לא מותקן עדיין. מריצים את פקודת ההתקנה מהפורטל."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "⚠️ Node.js לא נמצא. מתקינים מ-https://nodejs.org ומריצים שוב."
  exit 1
fi

# ---------- 1) מורידים הכל לתיקייה זמנית — לפני שעוצרים משהו ----------
# אם ההורדה נכשלת (אינטרנט, 404) — העוזר הישן ממשיך לרוץ כאילו כלום.
echo "📦 מוריד את הגרסה העדכנית..."
TMPD="$(mktemp -d)"
for f in $FILES; do
  if ! curl -sfL "$RAW/$f?n=$(date +%s)" -o "$TMPD/$f"; then
    echo "⚠️ ההורדה של $f נכשלה — בודקים חיבור לאינטרנט ומריצים שוב. שום דבר לא שונה."
    rm -rf "$TMPD"
    exit 1
  fi
done
NEW_BUILD="$(grep -o 'name="app-build" content="[^"]*"' "$TMPD/index.html" | head -1)"
if [ -z "$NEW_BUILD" ]; then
  echo "⚠️ הגרסה שירדה לא מכילה מזהה גרסה — העדכון נעצר. שום דבר לא שונה."
  rm -rf "$TMPD"
  exit 1
fi

# ---------- 2) עוצרים את הגרסה הנוכחית ----------
# לפני החלפת הקבצים — אחרת הישנה ממשיכה להגיש את המסך הישן מהזיכרון.
echo "🛑 עוצר את הגרסה הנוכחית..."
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
OLD_PID="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true)"
[ -n "$OLD_PID" ] && kill $OLD_PID 2>/dev/null || true
for i in $(seq 1 20); do
  lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.5
done

# ---------- 3) מחליפים את *כל* קבצי התוכנה (לא רק את המנוע) ----------
cd "$BOT_DIR"
for f in $FILES; do
  mv "$TMPD/$f" "$f"
done
rm -rf "$TMPD"
chmod +x run.sh start.command 2>/dev/null || true
# config.json + .env + auth נשארים כמו שהם (ההגדרות והחיבור של המשתמש)
mkdir -p "$LOG_DIR"
touch "$LOG"
chmod 600 "$LOG"
touch "$BOT_DIR/.opened" # המעדכן פותח את הדפדפן בעצמו — לא טאב כפול

echo "📚 מעדכן תלויות..."
npm install --ignore-scripts --no-fund --no-audit --silent || true

# ---------- 4) רושמים מחדש (גם התקנות ישנות עוברות ל-run.sh וללוג החדש) ומפעילים ----------
echo "🤖 מפעיל מחדש..."
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE_BIN="$HOME/.local/bin/claude"
CLAUDE_DIR="$([ -n "$CLAUDE_BIN" ] && dirname "$CLAUDE_BIN" || echo "$HOME/.local/bin")"
BOT_PATH="$HOME/.local/bin:$CLAUDE_DIR:$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
mkdir -p "$HOME/Library/LaunchAgents"
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

# ---------- 5) אימות אמיתי: הדף המוגש נושא בדיוק את מזהה הגרסה שירדה ----------
OK=""
for i in $(seq 1 40); do
  curl -s "http://127.0.0.1:$PORT/" 2>/dev/null | grep -qF "$NEW_BUILD" && { OK=1; break; }
  sleep 0.5
done

if [ -n "$OK" ]; then
  echo ""
  echo "✅ העוזר האישי עודכן ופועל — גרסה $(echo "$NEW_BUILD" | sed 's/.*content="//; s/"$//')."
  echo "✅ לא נדרשה סריקה מחדש — החיבור וההגדרות נשמרו."
  echo "✅ אם המחשב יכובה — העוזר יקום אוטומטית כשתפעילו מחדש."
  echo ""
  open "http://127.0.0.1:$PORT"
else
  echo "⚠️ העדכון הסתיים אבל המסך המוגש אינו הגרסה החדשה."
  echo "   השורות האחרונות מהלוג:"
  tail -n 15 "$LOG" 2>/dev/null || true
  exit 1
fi
