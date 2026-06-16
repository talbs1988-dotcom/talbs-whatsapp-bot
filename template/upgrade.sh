#!/bin/bash
# upgrade.sh — שדרוג בוט קיים בלי לאבד את החיבור (auth/) ובלי לסרוק QR מחדש
# מתבצע פעם אחת על-ידי תלמיד שכבר התקין בעבר.
set -e

BOT_DIR="$HOME/talbs-whatsapp-bot"
PORT=7655
LABEL="com.talbs.workshop-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="/tmp/talbs-bot.log"

if [ ! -d "$BOT_DIR" ]; then
  echo "❌ לא נמצאה תיקיית הבוט. הריצו קודם את ההתקנה המלאה."
  exit 1
fi

echo "📦 מוריד גרסה חדשה של bot.js (auth נשמר)..."
curl -sL https://raw.githubusercontent.com/talbs1988-dotcom/talbs-whatsapp-bot/main/template/bot.js -o "$BOT_DIR/bot.js"

echo "🤖 וודא שהבוט רשום כשירות אוטומטי..."
NODE_BIN="$(which node)"
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
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

echo "🔄 מפעיל מחדש את הבוט..."
launchctl unload "$PLIST" 2>/dev/null || true
lsof -ti:$PORT 2>/dev/null | xargs kill 2>/dev/null || true
sleep 2
launchctl load -w "$PLIST"
sleep 4

if lsof -ti:$PORT >/dev/null 2>&1; then
  echo ""
  echo "✅ הבוט עודכן ופועל."
  echo "✅ לא נדרשה סריקה מחדש — החיבור הקיים נשמר."
  echo "✅ אם המק יכובה — הבוט יקום אוטומטית כשתפעיל מחדש."
else
  echo "⚠️ הבוט לא עלה. בדוק לוג: cat $LOG"
  exit 1
fi
