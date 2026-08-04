#!/bin/bash
# install.sh — התקנה מלאה של בוט הסדנה של טל בשור
# מתבצע פעם אחת. אחרי זה הבוט פועל לבדו ויעמוד גם אחרי כיבוי המק.
set -e

BOT_DIR="$HOME/talbs-whatsapp-bot"
PORT=7655
LABEL="com.talbs.workshop-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="/tmp/talbs-bot.log"

echo "📦 מוריד את הקוד..."
curl -sL https://github.com/talbs1988-dotcom/talbs-whatsapp-bot/archive/main.tar.gz | tar -xz -C /tmp
rm -rf "$BOT_DIR"
mv /tmp/talbs-whatsapp-bot-main/template "$BOT_DIR"
cd "$BOT_DIR"

echo "📚 מתקין תלויות..."
npm install --ignore-scripts --no-fund --no-audit --silent

echo "🛑 עוצר תהליך ישן אם קיים..."
launchctl unload "$PLIST" 2>/dev/null || true
lsof -ti:$PORT 2>/dev/null | xargs kill 2>/dev/null || true
sleep 2

echo "🤖 רושם את הבוט כשירות אוטומטי..."
NODE_BIN="$(which node)"
NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_BIN="$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")"
CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"
# ה-PATH של השירות חייב לכלול את המיקום של claude (בד"כ ~/.local/bin) ושל node
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

launchctl load -w "$PLIST"
sleep 4

if lsof -ti:$PORT >/dev/null 2>&1; then
  echo ""
  echo "✅ הבוט מותקן ופועל!"
  echo "✅ הוא יעלה אוטומטית גם אחרי הפעלה מחדש של המק."
  echo "✅ אם יקרוס — יחזור לבד תוך 10 שניות."
  echo ""
  echo "🌐 דפדפן ייפתח כדי לסרוק QR..."
  open "http://127.0.0.1:$PORT"
else
  echo "⚠️ הבוט לא הצליח לעלות. בדוק לוג: cat $LOG"
  exit 1
fi
