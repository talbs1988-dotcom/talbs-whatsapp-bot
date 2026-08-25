#!/bin/bash
# install.sh — התקנה מלאה של העוזר האישי · טל בשור
# מתבצע פעם אחת. אחרי זה העוזר פועל לבדו ויעלה גם אחרי כיבוי המחשב.
set -e

BOT_DIR="$HOME/talbs-whatsapp-bot"
PORT=7655
LABEL="com.talbs.workshop-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="/tmp/talbs-bot.log"
UID_="$(id -u)"

# ---------- 1) קודם כל: לעצור כל גרסה ישנה שרצה ----------
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
  echo "⚠️ הפורט $PORT עדיין תפוס על ידי תהליך אחר. סגרו אותו ונסו שוב."
  exit 1
fi

# ---------- 2) עכשיו מחליפים את הקוד ----------
echo "📦 מוריד את הקוד..."
rm -rf /tmp/talbs-whatsapp-bot-main
curl -sL https://github.com/talbs1988-dotcom/talbs-whatsapp-bot/archive/main.tar.gz | tar -xz -C /tmp
# שומרים הגדרות וחיבור קיימים (מי שמתקין מחדש לא מאבד את ה-QR ואת ההנחיות)
KEEP="$(mktemp -d)"
[ -f "$BOT_DIR/config.json" ] && cp "$BOT_DIR/config.json" "$KEEP/" || true
[ -d "$BOT_DIR/auth" ] && cp -R "$BOT_DIR/auth" "$KEEP/" || true
rm -rf "$BOT_DIR"
mv /tmp/talbs-whatsapp-bot-main/template "$BOT_DIR"
[ -f "$KEEP/config.json" ] && cp "$KEEP/config.json" "$BOT_DIR/config.json" || true
[ -d "$KEEP/auth" ] && cp -R "$KEEP/auth" "$BOT_DIR/auth" || true
rm -rf "$KEEP"
cd "$BOT_DIR"

echo "📚 מתקין תלויות..."
npm install --ignore-scripts --no-fund --no-audit --silent

# ---------- 3) רושמים כשירות ומפעילים ----------
echo "🤖 רושם את העוזר כשירות אוטומטי..."
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

launchctl bootstrap "gui/$UID_" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"

# ---------- 4) אימות אמיתי: המסך שמוגש הוא הגרסה החדשה ----------
# לא "הפורט תפוס" (זה יכול להיות תהליך ישן). בודקים שהדף עצמו הוא הבנייה החדשה.
OK=""
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q 'data-tab="home"'; then OK=1; break; fi
  sleep 0.5
done

if [ -n "$OK" ]; then
  echo ""
  echo "✅ העוזר האישי מותקן ופועל — הגרסה העדכנית."
  echo "✅ הוא יעלה אוטומטית גם אחרי הפעלה מחדש של המחשב."
  echo "✅ אם יקרוס — יחזור לבד תוך 10 שניות."
  echo ""
  echo "🌐 דפדפן ייפתח כדי לסרוק QR..."
  open "http://127.0.0.1:$PORT"
else
  echo "⚠️ העוזר עלה אבל המסך שמוגש אינו הגרסה החדשה, או שלא עלה בכלל."
  echo "   בדקו לוג: cat $LOG"
  exit 1
fi
