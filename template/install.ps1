#Requires -Version 5.1
# מתקין העוזר האישי — Windows
# מקביל ל-install.sh של המק. אותם שלבים, אותה התנהגות.
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$BotDir   = if ($env:ASSISTANT_DIR)   { $env:ASSISTANT_DIR }   else { Join-Path $HOME "talbs-whatsapp-bot" }
$Port     = if ($env:ASSISTANT_PORT)  { $env:ASSISTANT_PORT }  else { "7655" }
$TaskName = if ($env:ASSISTANT_LABEL) { $env:ASSISTANT_LABEL } else { "TalbsWorkshopBot" }
$LogDir   = Join-Path $BotDir "logs"
$Log      = Join-Path $LogDir "assistant.log"
# מאיזה ענף/גרסה להוריד את קוד הבוט. ברירת המחדל main.
$Ref      = if ($env:ASSISTANT_REF) { $env:ASSISTANT_REF } else { "main" }
$Zip      = "https://github.com/talbs1988-dotcom/talbs-whatsapp-bot/archive/$Ref.zip"

Write-Host ""
Write-Host "==============================================="
Write-Host "   התקנת העוזר האישי — Windows"
Write-Host "==============================================="
Write-Host ""

# ---------- 0) בדיקות מקדימות — לפני שנוגעים בכלום ----------
# Node.js — אם חסר, מתקינים לבד. אין סיבה לשלוח מישהו לאתר חיצוני
# ולבקש ממנו להריץ את הפקודה שוב; זה המקום שבו אנשים נושרים.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "📦 Node.js לא מותקן — מתקין אותו עכשיו (כמה דקות)..."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null
    # winget לא מעדכן את ה-PATH של החלון הפתוח — טוענים אותו מחדש מהמערכת
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $node) {
    Write-Host "❌ לא הצלחתי להתקין Node.js לבד." -ForegroundColor Red
    Write-Host "   להתקין מ- https://nodejs.org (גרסת LTS), לפתוח PowerShell חדש,"
    Write-Host "   ולהדביק את אותה פקודה שוב."
    exit 1
  }
  Write-Host "✅ Node.js הותקן"
}
$major = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($major -lt 18) {
  Write-Host "❌ נדרשת Node.js 18 ומעלה. מותקן אצלך: $major" -ForegroundColor Red
  Write-Host "   לעדכן מ- https://nodejs.org ואז להריץ שוב."
  exit 1
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Write-Host "📦 Claude Code לא מותקן — מתקין אותו עכשיו..."
  & npm install -g @anthropic-ai/claude-code 2>&1 | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    Write-Host "⚠️ Claude Code לא נמצא לאחר ההתקנה." -ForegroundColor Yellow
    Write-Host "   העוזר יותקן, אבל כדי שיענה צריך Claude Code מחובר."
    Write-Host "   לפתוח PowerShell חדש, להריץ:  claude  ולהתחבר."
  } else {
    Write-Host "✅ Claude Code הותקן"
  }
}
Write-Host "✅ Node.js $major ו-Claude Code נמצאו"

# ---------- 1) מורידים ומכינים בצד ----------
Write-Host "📦 מוריד את הקוד..."
$StageRoot = Join-Path ([IO.Path]::GetTempPath()) ("talbs-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
$ZipPath = Join-Path $StageRoot "main.zip"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Zip -OutFile $ZipPath -UseBasicParsing
  Expand-Archive -Path $ZipPath -DestinationPath $StageRoot -Force
} catch {
  Write-Host "❌ ההורדה נכשלה: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "   לבדוק חיבור לאינטרנט ולנסות שוב."
  Remove-Item -Recurse -Force $StageRoot -ErrorAction SilentlyContinue
  exit 1
}
$Stage = Join-Path $StageRoot "talbs-whatsapp-bot-$($Ref -replace "/","-")\template"
if (-not (Test-Path (Join-Path $Stage "bot.js"))) {
  Write-Host "❌ הקוד שירד לא תקין." -ForegroundColor Red
  Remove-Item -Recurse -Force $StageRoot -ErrorAction SilentlyContinue
  exit 1
}
$BuildTag = ""
$idx = Join-Path $Stage "index.html"
if (Test-Path $idx) {
  $m = Select-String -Path $idx -Pattern 'name="app-build" content="([^"]*)"' | Select-Object -First 1
  if ($m) { $BuildTag = $m.Matches[0].Groups[1].Value }
}

# ---------- 2) עוצרים כל גרסה ישנה שרצה ----------
Write-Host "🔧 עוצר גרסה קודמת אם רצה..."
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*talbs-whatsapp-bot*bot.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# ---------- 3) מחליפים קוד, שומרים את מה ששייך למשתמש ----------
# הגדרות, חיבור (auth), סודות, זיכרון שיחות והיסטוריה — לא נמחקים בהתקנה חוזרת.
$Keep = Join-Path ([IO.Path]::GetTempPath()) ("keep-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Keep | Out-Null
$UserFiles = @("config.json",".env",".ui-key","sessions.json","green-seen.json","groups-seen.json","feed.json",".opened")
foreach ($f in $UserFiles) {
  $src = Join-Path $BotDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $Keep $f) -Force }
}
foreach ($d in @("auth","logs")) {
  $src = Join-Path $BotDir $d
  if (Test-Path $src) { Copy-Item $src (Join-Path $Keep $d) -Recurse -Force }
}

if (Test-Path $BotDir) { Remove-Item -Recurse -Force $BotDir }
Move-Item $Stage $BotDir

foreach ($f in $UserFiles) {
  $src = Join-Path $Keep $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $BotDir $f) -Force }
}
foreach ($d in @("auth","logs")) {
  $src = Join-Path $Keep $d
  if (Test-Path $src) { Copy-Item $src (Join-Path $BotDir $d) -Recurse -Force }
}
Remove-Item -Recurse -Force $Keep, $StageRoot -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not (Test-Path $Log)) { New-Item -ItemType File -Force -Path $Log | Out-Null }
New-Item -ItemType File -Force -Path (Join-Path $BotDir ".opened") | Out-Null

# הערה: לא משנים הרשאות NTFS. תיקייה תחת פרופיל המשתמש היא ממילא פרטית לו,
# ו-icacls /inheritance:r עלול לנעול את המשתמש מחוץ לתיקייה של עצמו אם משהו משתבש.

Push-Location $BotDir
if (Test-Path (Join-Path $BotDir "package.json")) {
  Write-Host "📦 מתקין תלויות..."
  & npm install --silent 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ התקנת התלויות נכשלה — בודקים חיבור לאינטרנט ומריצים שוב." -ForegroundColor Yellow
    Pop-Location
    exit 1
  }

  # 🎤 ffmpeg (להמרת הקלטות קוליות). אמור לבוא עם ההתקנה; אם לא — מורידים במפורש.
  $ff = Join-Path $BotDir "node_modules\ffmpeg-static\ffmpeg.exe"
  if (-not (Test-Path $ff)) {
    Write-Host "🎤 מוריד את ממיר ההקלטות..."
    & node (Join-Path $BotDir "node_modules\ffmpeg-static\install.js")
  }
  if (-not (Test-Path $ff)) {
    Write-Host "⚠️ ממיר ההקלטות לא נמצא — תמלול קולי לא יהיה זמין. שאר העוזר כן." -ForegroundColor Yellow
  } else {
    Write-Host "✅ תמלול הקלטות קוליות מוכן"
  }
}
Pop-Location

# ---------- 4) רושמים כמשימה מתוזמנת ומפעילים ----------
Write-Host "🔧 רושם את העוזר שיעלה אוטומטית..."
$nodeExe = $node.Source
$action  = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$(Join-Path $BotDir 'bot.js')`"" -WorkingDirectory $BotDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
              -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

# ---------- 4b) מפתח המסך ----------
# העוזר יוצר .ui-key בעלייה. בלי המפתח בכתובת השרת מגיש מסך נעול ולא את
# הברקוד — ולכן גם הדפדפן וגם הקיצור דרך חייבים לכלול אותו.
$UiKey = ""
for ($i = 0; $i -lt 30; $i++) {
  $kp = Join-Path $BotDir ".ui-key"
  if (Test-Path $kp) {
    $UiKey = (Get-Content $kp -Raw).Trim()
    if ($UiKey) { break }
  }
  Start-Sleep -Seconds 1
}
if (-not $UiKey) {
  Write-Host "⚠️ מפתח המסך לא נוצר — המסך לא ייפתח לבד. נסו להריץ את ההתקנה שוב." -ForegroundColor Yellow
}

$UiUrl = if ($UiKey) { "http://127.0.0.1:$Port/?key=$UiKey" } else { "http://127.0.0.1:$Port" }

# ---------- 4c) קיצור דרך על שולחן העבודה ----------
try {
  $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "העוזר האישי.url"
  "[InternetShortcut]`r`nURL=$UiUrl`r`n" | Set-Content -Path $lnk -Encoding ASCII
} catch { }

# ---------- 5) אימות אמיתי: המסך שמוגש הוא הגרסה שירדה ----------
Write-Host "⏳ מחכה שהעוזר יעלה..."
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $hdr = @{}
    if ($UiKey) { $hdr["Cookie"] = "ui=$UiKey" }
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port" -Headers $hdr -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      if (-not $BuildTag -or $r.Content -match [Regex]::Escape($BuildTag)) { $ok = $true; break }
    }
  } catch { }
}

Write-Host ""
if ($ok) {
  Write-Host "✅ העוזר האישי מותקן ופועל." -ForegroundColor Green
  Write-Host "✅ הוא יעלה אוטומטית גם אחרי הפעלה מחדש של המחשב."
  Write-Host "✅ אם יקרוס — יחזור לבד."
  Write-Host ""
  Write-Host "   נפתח כעת המסך לחיבור וואטסאפ — שם סורקים את הברקוד."
  Start-Process $UiUrl
} else {
  Write-Host "⚠️ ההתקנה הסתיימה, אבל העוזר לא ענה בזמן." -ForegroundColor Yellow
  Write-Host "   מה לעשות:"
  Write-Host "   1) ללחוץ על האייקון 'העוזר האישי' על שולחן העבודה"
  Write-Host "   2) אם לא נפתח — להריץ ידנית ולראות את השגיאה:"
  Write-Host "      cd `"$BotDir`" ; node bot.js"
  Write-Host "   3) לוג:  $Log"
}
Write-Host ""
