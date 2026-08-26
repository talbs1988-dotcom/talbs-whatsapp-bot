#!/bin/bash
# run.sh — מפעיל את העוזר האישי מתוך השירות (launchd).
# למה קובץ נפרד ולא node ישירות: הנתיב של node משתנה (עדכון, Homebrew, nvm) —
# ואז שירות עם נתיב קבוע מת בשקט. כאן מוצאים את node מחדש בכל הפעלה.
cd "$(dirname "$0")" || exit 1

find_node() {
  command -v node 2>/dev/null && return 0
  for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  local nv
  nv="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$nv" ] && [ -x "$nv" ] && { echo "$nv"; return 0; }
  return 1
}

NODE="$(find_node)" || {
  echo "❌ Node.js לא נמצא במחשב. מתקינים מ-https://nodejs.org (LTS) ומפעילים מחדש."
  sleep 30 # שלא ייכנס ללולאת הפעלה צפופה
  exit 1
}
export PATH="$HOME/.local/bin:$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:$PATH"

# הלוג נשמר בתיקיית העוזר (לא ב-/tmp הציבורי), רק למשתמש (600), ולא תופח בלי סוף.
mkdir -p logs
LOG="logs/assistant.log"
touch "$LOG"
chmod 600 "$LOG" 2>/dev/null || true
SIZE="$(stat -f%z "$LOG" 2>/dev/null || echo 0)"
if [ "$SIZE" -gt 5000000 ]; then
  # קיצוץ במקום (אותו קובץ) — launchd ממשיך לכתוב לאותו קובץ אחרי הקיצוץ
  tail -n 2000 "$LOG" >"$LOG.tmp" && cat "$LOG.tmp" >"$LOG" && rm -f "$LOG.tmp"
fi

exec "$NODE" bot.js
