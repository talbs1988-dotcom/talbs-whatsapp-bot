#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "מתקין תלויות לפעם ראשונה..."
  npm install --ignore-scripts --no-fund --no-audit
fi
node bot.js
