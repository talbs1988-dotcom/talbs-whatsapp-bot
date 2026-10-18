// ─────────────────────────────────────────────────────────────
// voice.js · תמלול הקלטות קוליות — רץ על המחשב הזה
//
// אין מפתח API, אין עלות, וההקלטות לא יוצאות לאינטרנט.
// המודל יורד פעם אחת בהתקנה ואז נשמר בתיקייה .voice-model.
// ─────────────────────────────────────────────────────────────

import { pipeline, env as hfEnv } from "@huggingface/transformers";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegBin from "ffmpeg-static";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// whisper-large-v3-turbo מכווץ: הדיוק של המודל הגדול במהירות של הקטן.
// נמדד על עברית — כ-4 שניות להקלטה של 3 שניות.
export const VOICE_MODEL =
  process.env.VOICE_MODEL || "onnx-community/whisper-large-v3-turbo";
const DTYPE = process.env.VOICE_DTYPE || "q8";

hfEnv.allowLocalModels = false;
// המודל נשמר ליד הבוט ולא בתוך node_modules, כדי שהתקנת חבילות
// מחדש לא תמחק אותו ותגרום להורדה מיותרת של כ-1 ג'יגה.
hfEnv.cacheDir = path.join(HERE, ".voice-model");

let enginePromise = null;

// נטען פעם אחת ונשאר בזיכרון: ההקלטה הראשונה אטית, הבאות מהירות
export function loadEngine() {
  if (!enginePromise) {
    enginePromise = pipeline("automatic-speech-recognition", VOICE_MODEL, {
      dtype: DTYPE,
    }).catch((e) => {
      enginePromise = null; // שלא ניתקע על שגיאה שנשמרה
      throw e;
    });
  }
  return enginePromise;
}

function extFor(mime) {
  const mt = String(mime || "").toLowerCase();
  if (/mp4|m4a/.test(mt)) return "m4a";
  if (/mpeg|mp3/.test(mt)) return "mp3";
  if (/wav/.test(mt)) return "wav";
  if (/webm/.test(mt)) return "webm";
  return "ogg";
}

// כל פורמט שוואטסאפ שולח → Float32 של 16 קילוהרץ, מה שהמנוע צריך
async function decode(inputPath) {
  const wav = path.join(
    os.tmpdir(),
    `voice-${crypto.randomBytes(6).toString("hex")}.wav`,
  );
  try {
    await execFileAsync(
      ffmpegBin,
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", wav],
      { maxBuffer: 1 << 24 },
    );
    const buf = await fs.readFile(wav);
    // 44 הבתים הראשונים הם כותרת ה-wav, אחריהם הקול
    const pcm = new Int16Array(
      buf.buffer,
      buf.byteOffset + 44,
      Math.floor((buf.length - 44) / 2),
    );
    return Float32Array.from(pcm, (v) => v / 32768);
  } finally {
    await fs.rm(wav, { force: true });
  }
}

async function run(audio) {
  const seconds = audio.length / 16000;
  if (seconds < 0.3) throw new Error("too-short");

  const asr = await loadEngine();
  const out = await asr(audio, {
    language: "hebrew",
    task: "transcribe",
    // הקלטה ארוכה מ-30 שניות מתומללת במקטעים עם חפיפה
    ...(seconds > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
  });
  return String(out?.text || "").trim();
}

/** מתמלל הקלטה שהגיעה כ-Buffer. מחזיר את הטקסט, או מחרוזת ריקה. */
export async function transcribeBuffer(buf, mime) {
  const file = path.join(
    os.tmpdir(),
    `voice-${crypto.randomBytes(6).toString("hex")}.${extFor(mime)}`,
  );
  await fs.writeFile(file, buf);
  try {
    return await run(await decode(file));
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** מתמלל קובץ מהדיסק. */
export async function transcribeFile(filePath) {
  return run(await decode(filePath));
}

/** בדיקה עצמית: מתמלל הקלטה מצורפת ומוודא שיצא טקסט. */
export async function selfTest() {
  const sample = path.join(HERE, "assets", "sample-he.ogg");
  const text = await transcribeFile(sample);
  if (!text || text.length < 4) throw new Error("empty-result");
  return text;
}
