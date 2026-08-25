#!/bin/bash
# upgrade.sh — עדכון העוזר האישי לגרסה העדכנית, בלי לאבד את החיבור וההגדרות
# למי שכבר התקין. שומר config.json + auth (אין צורך לסרוק QR מחדש).
set -e

BOT_DIR="$HOME/talbs-whatsapp-bot"
PORT=7655
LABEL="com.talbs.workshop-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="/tmp/talbs-bot.log"
UID_="$(id -u)"
RAW="https://raw.githubusercontent.com/talbs1988-dotcom/talbs-whatsapp-bot/main/template"

if [ ! -d "$BOT_DIR" ]; then
  echo "⚠️ העוזר לא מותקן עדיין. הריצו את פקודת ההתקנה מהפורטל."
  exit 1
fi

# ---------- 1) קודם כל: לעצור את הגרסה הישנה ----------
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

# ---------- 2) מעדכנים את *כל* קבצי התוכנה (לא רק את המנוע) ----------
# עדכון של bot.js בלבד משאיר מסך ישן עם מנוע חדש — בדיוק הברדק שרוצים למנוע.
echo "📦 מוריד את הגרסה העדכנית..."
cd "$BOT_DIR"
for f in bot.js index.html package.json start.command; do
  curl -sfL "$RAW/$f?n=$(date +%s)" -o "$f.new" && mv "$f.new" "$f"
done
# config.json + auth נשארים כמו שהם (ההגדרות והחיבור של המשתמש)

echo "📚 מעדכן תלויות..."
npm install --ignore-scripts --no-fund --no-audit --silent

# ---------- 3) רושמים מחדש ומפעילים ----------
echo "🤖 מפעיל מחדש..."
NODE_BIN="$(which node)"
NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_BIN="$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")"
CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"
BOT_PATH="$HOME/.local/bin:$CLAUDE_DIR:$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
mkdir -p "$HOME/Library/LaunchAgents"

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
        <string>$NODE_BIN</string>
        <string>bot.js</string>
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
        <key>CLAUDE_BIN</key>
        <string>$CLAUDE_BIN</string>
    </dict>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$UID_" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"

# ---------- 4) אימות אמיתי: המסך המוגש הוא הגרסה החדשה ----------
OK=""
for i in $(seq 1 30); do
  curl -s "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q 'data-tab="home"' && { OK=1; break; }
  sleep 0.5
done

if [ -n "$OK" ]; then
  echo ""
  echo "✅ העוזר האישי עודכן ופועל — הגרסה העדכנית."
  echo "✅ לא נדרשה סריקה מחדש — החיבור וההגדרות נשמרו."
  echo "✅ אם המחשב יכובה — העוזר יקום אוטומטית כשתפעילו מחדש."
  echo ""
  open "http://127.0.0.1:$PORT"
else
  echo "⚠️ העדכון הסתיים אבל המסך המוגש אינו הגרסה החדשה."
  echo "   בדקו לוג: cat $LOG"
  exit 1
fi
