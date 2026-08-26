#!/bin/bash
# start.command — הפעלה ידנית של העוזר האישי (כשהשירות לא רץ). לחיצה כפולה.
# לולאה: המנוע יוצא בכוונה (קוד 1) אחרי שינוי הגדרות/ספק כדי לעלות מחדש —
# בלי הלולאה הזו החלון היה נסגר והעוזר נשאר כבוי.
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "מתקין תלויות לפעם ראשונה..."
  npm install --ignore-scripts --no-fund --no-audit
fi
while true; do
  /bin/bash run.sh
  code=$?
  [ "$code" -eq 0 ] && break
  echo "העוזר מופעל מחדש... (קוד $code)"
  sleep 2
done
