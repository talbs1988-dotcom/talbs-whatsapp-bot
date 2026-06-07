---
name: talbs-whatsapp-bot
description: התקנת בוט WhatsApp אישי שמתחבר ל-Claude. רץ מקומית, אפס עלויות API נוספות, self-chat עובד מהקופסה (אין צורך במספר טלפון שני). הפעלת הסקיל כאשר המשתמש אומר "להתקין בוט", "להתחבר לוואטסאפ", "סוכן WhatsApp", "/talbs-whatsapp-bot", או באופן כללי שואל איך להתחיל בסדנה של טל בשור.
user-invocable: true
---

# התקנת הבוט של טל

מטרה: להעביר את המשתתף מאפס לבוט WhatsApp פעיל תוך 5 דקות.

הבוט הזה שונה מבוטים אחרים בשני דברים:

1. **Self-chat עובד.** המשתתף יכול לשלוח לעצמו בוואטסאפ והבוט יענה. אין צורך במספר טלפון שני (זה הבאג שדניאל לא פתר).
2. **משתמש ב-Claude Code שכבר מותקן.** לא צריך API key נפרד של Anthropic. אם יש למשתתף Claude Pro או Claude Code, זה עובד.

---

## שלב 1 — בדיקת תנאי הקדמה

```bash
echo "Platform: $(uname -sm)"
node --version 2>/dev/null || echo "MISSING:node"
command -v claude >/dev/null && echo "claude:OK" || echo "MISSING:claude"
```

חובה:

- **Node.js 18+** — אם חסר, לכוון לhttps://nodejs.org (LTS). מק עם Homebrew: להציע `brew install node`. **לא להמשיך עד שמותקן.**
- **Claude Code CLI** — אם חסר, להציע התקנה: `npm install --ignore-scripts -g @anthropic-ai/claude-code`. דורש חיבור Claude קודם — להפנות ל-`claude login`.

---

## שלב 2 — שאלה אחת בלבד

לשאול אך ורק את זה (בעברית):

> **"איזו תיקייה הסוכן יעבוד בה? (איפה הוא יראה קבצים)**
>
> ברירת מחדל: תיקיית הבית שלך. אפשר גם תיקיית פרויקט ספציפית."

לשמור כ-`$WORKDIR`. אם המשתמש אומר "ברירת מחדל" או ריק → להשתמש ב-`~`.

**אל תשאלי על מספר טלפון.** המספר נכנס אוטומטית מהסריקה.

---

## שלב 3 — התקנה

מיקום: `~/claude-whatsapp-bot/`

```bash
INSTALL=~/claude-whatsapp-bot
mkdir -p "$INSTALL/auth"
SKILL_DIR=~/.claude/skills/talbs-whatsapp-bot
cp -R "$SKILL_DIR/template/." "$INSTALL/"
chmod +x "$INSTALL/start.command"
```

אם `$INSTALL/config.json` כבר קיים — לא לדרוס. רק להוסיף `workdir` אם חסר.

---

## שלב 4 — קביעת תיקיית עבודה

```bash
node -e "
const fs = require('fs');
const p = process.env.HOME + '/claude-whatsapp-bot/config.json';
const c = JSON.parse(fs.readFileSync(p));
c.workdir = process.env.WORKDIR || process.env.HOME;
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('workdir set to:', c.workdir);
"
```

(החליפי `WORKDIR` לערך מהשלב 2)

---

## שלב 5 — התקנת תלויות

```bash
cd ~/claude-whatsapp-bot && npm install --ignore-scripts --no-fund --no-audit
```

~30 שניות בפעם הראשונה.

---

## שלב 6 — הפעלה

```bash
cd ~/claude-whatsapp-bot && nohup node bot.js > /tmp/talbs-bot.log 2>&1 &
disown
sleep 3
curl -s http://127.0.0.1:7655/state | head -c 200
```

הדפדפן ייפתח אוטומטית ל-http://127.0.0.1:7655.

---

## שלב 7 — קיצור דרך לשולחן (Mac)

```bash
ln -sf ~/claude-whatsapp-bot/start.command ~/Desktop/"💛 הבוט שלי.command"
```

---

## שלב 8 — הסבר למשתמש בעברית

לאחר שהבוט עלה, להגיד למשתמש את הזה בדיוק:

> **"מוכן! הדפדפן נפתח ב-http://127.0.0.1:7655 עם 3 שלבים פשוטים:**
>
> **1. סרוק QR** — בטלפון: WhatsApp → ⚙️ הגדרות → מכשירים מקושרים → קישור מכשיר → סורק את הקוד.
>
> **2. שלח לעצמך הודעה** — פתח את הצ'אט שלך עם עצמך בוואטסאפ (גלילה למעלה — הצ'אט הראשון), שלח 'היי'. הבוט יענה תוך ~3 שניות.
>
> **3. התאמות אישיות** — בדפדפן יש ⚙️ הגדרות לשנות את שם הבוט, system prompt, ועוד.\*\*

---

## שלב 9 — אימות

לאחר שהמשתמש סרק וניסה לשלוח, להריץ:

```bash
curl -s http://127.0.0.1:7655/state | python3 -c "
import json, sys
s = json.load(sys.stdin)
print('status:', s['status'])
print('me:', s.get('meJid', 'none'))
print('messagesIn:', s['stats']['messagesIn'])
print('whitelist:', s['config']['whitelist'])
"
```

צפוי: `status=connected`, `meJid` מלא, `messagesIn >= 1` אחרי שהמשתמש שלח.

---

## פתרון בעיות

| תסמין                           | פתרון                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Port 7654 תפוס                  | `lsof -ti:7654 \| xargs kill`                                                |
| `claude: command not found`     | `npm install -g @anthropic-ai/claude-code` + `claude login`                  |
| ה-QR לא מופיע                   | בדוק `/tmp/talbs-bot.log`                                                    |
| הבוט מקבל הודעה אבל לא עונה     | בדוק שה-`claude` עובד ידנית: `claude -p "היי"`                               |
| המשתמש שלח לעצמו ולא קיבל תשובה | זה צריך לעבוד! אם לא, להריץ `curl http://127.0.0.1:7654/state` ולראות שגיאות |
| Self-chat לא עובד גם אחרי הכל   | מהדפדפן: לחץ "🔄 התחבר מחדש", סרוק QR שוב                                    |

---

## מבנה ההתקנה

```
~/claude-whatsapp-bot/
├── bot.js              # מנוע (Baileys + Claude CLI)
├── index.html          # UI מקומי
├── config.json         # הגדרות
├── package.json
├── start.command       # לחיצה כפולה להפעלה
├── README.md
├── .gitignore
├── auth/               # WhatsApp session (אסור לשתף!)
├── sessions.json       # session id לכל משתמש
└── feed.json           # 60 הודעות אחרונות
```

---

## הקסם של self-chat

ב-WhatsApp Multi-Device (מה ש-Baileys משתמש), כשהמשתמש שולח הודעה מהטלפון הראשי לעצמו, ההודעה מסומנת `fromMe: true`. רוב הבוטים מסננים את אלה החוצה (כדי לא ליפול ללולאה אינסופית עם ההודעות שהם שולחים).

בקוד שלנו (`bot.js` בקובץ `handleMessage`): אנחנו בודקים אם `fromMe === true` AND `remoteJid === meJid`. במקרה הזה — מעבירים לעיבוד. בכל מקרה אחר של `fromMe === true` (תשובות הבוט עצמן) — מדלגים.

---

## מה לא נכנס לגרסה 1

- ❌ Groups (`@-mention` mode) — לא רלוונטי לסדנה הראשונה
- ❌ Voice / TTS — אופציה לעתיד
- ❌ ניהול תמונות / מדיה — האזנה לטקסט בלבד

לאחר התקנה מוצלחת, להציע למשתמש לשמור את ה-URL של הדפדפן ולסמן כ-bookmark.

---

## סגירה

מאחל למשתמש בהצלחה ומציין שהבוט נשאר חי ברקע גם אחרי שהוא סוגר את ה-Terminal — עד שהמחשב נרדם. אם רוצים לעצור: `pkill -f "node bot.js"`.
