// hash.doomods.com - where the hash terminal's shared request log lands.
//
// What this is for: hash ships a 45M-parameter model that turns "give me five OG Kush" into `give ogkush 5`.
// It was trained on requests a language model was asked to invent, and it is judged against 79 hand-written
// cases - too few to tell apart three training runs that scored 14, 16 and 18 of them. Real requests fix both
// problems at once, and they are the one thing a teacher model cannot make up.
//
// What it is NOT: an analytics service. There is no account, no session, no id, no IP kept, and no timestamp
// finer than the day a record is filed under. The mod writes the log locally for every player and uploads it
// only for the ones who switched sharing on, so everything arriving here was sent deliberately.
//
// Storage is a JSONL file per mod version per day on a volume, plus a counters file the public page reads.
// A database would buy queries nobody has asked for yet; when the analysis side needs one, the JSONL is the
// import.

import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_RECORDS = parseInt(process.env.MAX_RECORDS || "5000", 10);
const MAX_BODY = parseInt(process.env.MAX_BODY || "4194304", 10); // 4 MB, ~20k ordinary records

// Reading the records back out is the half of the loop that makes the other half worth anything: a request
// log nobody can fetch improves nothing. It is a bearer token rather than an open route because the records
// are what players typed, and they agreed to share them with whoever trains the model, not with the internet.
const EXPORT_TOKEN = process.env.EXPORT_TOKEN || "";

const RECORDS_DIR = path.join(DATA_DIR, "records");
const COUNTERS_FILE = path.join(DATA_DIR, "counters.json");

const OUTCOMES = ["accepted", "rejected", "corrected", "retried"];

// ---- counters ---------------------------------------------------------------

/**
 * What the public page shows. Kept beside the records rather than derived on request: the page is read far
 * more often than it is written, and a scan of every record to answer "how many" gets slower every day.
 */
function emptyCounters() {
  return {
    records: 0,
    uploads: 0,
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
    commands: {},
    corrections: {},
    versions: {},
    firstDay: null,
    lastDay: null,
  };
}

function loadCounters() {
  try {
    const parsed = JSON.parse(fs.readFileSync(COUNTERS_FILE, "utf8"));
    return { ...emptyCounters(), ...parsed };
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`[hash-telemetry] counters unreadable, starting from zero: ${e.message}`);
    }
    return emptyCounters();
  }
}

let counters = loadCounters();
let countersDirty = false;

function saveCounters() {
  if (!countersDirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = COUNTERS_FILE + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(counters), "utf8");
    fs.renameSync(temp, COUNTERS_FILE);
    countersDirty = false;
  } catch (e) {
    console.error(`[hash-telemetry] could not save counters: ${e.message}`);
  }
}

// Batched rather than written per upload: losing a few counts to a restart costs a number on a page, while
// the records themselves are already on disk and can rebuild it.
setInterval(saveCounters, 10_000).unref();
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { saveCounters(); process.exit(0); });

const bump = (bag, key, by = 1) => {
  if (!key) return;
  bag[key] = (bag[key] || 0) + by;
};

/** The command word only. Arguments can carry a player's own words; the verb cannot. */
const commandWord = (line) => String(line || "").trim().split(/\s+/)[0] || "";

function count(record, version, day) {
  counters.records += 1;
  bump(counters.versions, version);

  const outcome = OUTCOMES.includes(record.outcome) ? record.outcome : "rejected";
  counters.outcomes[outcome] += 1;

  for (const command of Array.isArray(record.commands) ? record.commands : []) {
    bump(counters.commands, commandWord(command));
  }

  // The pair that teaches something: what hash answered, and what the player ran instead. Command words only.
  //
  // Same word on both sides is not a non-event - it is the argument phase failing, which is the known weak
  // half of the model (routing 78.5 %, arguments barely ahead of the untuned base). Counting only the
  // different-word pairs would hide exactly the failure the log was collected to measure.
  if (record.actual) {
    const proposed = commandWord((record.commands || [])[0]);
    const actual = commandWord(record.actual);
    if (actual) {
      bump(counters.corrections, !proposed ? `(nothing) -> ${actual}`
        : proposed === actual ? `${actual} (arguments)`
        : `${proposed} -> ${actual}`);
    }
  }

  if (!counters.firstDay || day < counters.firstDay) counters.firstDay = day;
  if (!counters.lastDay || day > counters.lastDay) counters.lastDay = day;

  countersDirty = true;
}

// ---- helpers ----------------------------------------------------------------

const str = (v, max = 64) => (typeof v === "string" ? v.slice(0, max) : "");

/** A file name that can only ever be <mod>-<version>-<day>.jsonl inside RECORDS_DIR. */
function recordsFile(mod, version, day) {
  const safe = (v, fallback) => {
    const cleaned = String(v || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
    return cleaned || fallback;
  };
  return path.join(RECORDS_DIR, `${safe(mod, "unknown")}-${safe(version, "unknown")}-${day}.jsonl`);
}

/** Bearer check in constant time, so a wrong token cannot be found one character at a time. */
function authorised(req) {
  const header = String(req.get("authorization") || "");
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(offered);
  const b = Buffer.from(EXPORT_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const topOf = (bag, limit) =>
  Object.entries(bag).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, n]) => ({ name, count: n }));

// ---- app --------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_BODY }));

app.get("/health", (_req, res) => res.json({ ok: true, records: counters.records }));

/**
 * One upload from one player who switched sharing on.
 *
 * It refuses loudly rather than quietly. The mod clears the player's local file the moment this answers 200,
 * and the player has only the one copy - so a write that did not happen must not look like one that did.
 */
app.post("/api/telemetry", (req, res) => {
  const body = req.body || {};
  const records = Array.isArray(body.records) ? body.records : null;

  if (!records) return res.status(400).json({ ok: false, error: "records must be an array" });
  if (records.length === 0) return res.json({ ok: true, stored: 0 });
  if (records.length > MAX_RECORDS) {
    return res.status(413).json({ ok: false, error: `at most ${MAX_RECORDS} records per upload` });
  }

  const mod = str(body.mod, 40);
  const version = str(body.version, 40);
  const game = str(body.game, 40);
  const day = new Date().toISOString().slice(0, 10);

  let payload = "";
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return res.status(400).json({ ok: false, error: "every record must be an object" });
    }
    payload += JSON.stringify({ ...record, mod, version, game, day }) + "\n";
  }

  try {
    fs.mkdirSync(RECORDS_DIR, { recursive: true });
    fs.appendFileSync(recordsFile(mod, version, day), payload, "utf8");
  } catch (e) {
    console.error(`[hash-telemetry] write failed: ${e.message}`);
    return res.status(500).json({ ok: false, error: "could not store the upload" });
  }

  counters.uploads += 1;
  for (const record of records) count(record, version, day);

  console.log(`[hash-telemetry] ${mod} ${version}: ${records.length} records`);
  res.json({ ok: true, stored: records.length });
});

app.get("/api/stats", (_req, res) => {
  res.set("Cache-Control", "public, max-age=30");
  res.json({
    ok: true,
    records: counters.records,
    uploads: counters.uploads,
    outcomes: counters.outcomes,
    firstDay: counters.firstDay,
    lastDay: counters.lastDay,
    versions: topOf(counters.versions, 10),
    commands: topOf(counters.commands, 15),
    corrections: topOf(counters.corrections, 15),
  });
});

/**
 * Every record, oldest first, as the JSONL the training pipeline reads.
 *
 * `since` takes a day (YYYY-MM-DD) and returns that day and later, so a puller can ask for what it has not
 * seen instead of the whole history. The day is in the file name, so this never opens a file it does not need.
 */
app.get("/api/records", (req, res) => {
  if (!EXPORT_TOKEN) {
    return res.status(503).json({ ok: false, error: "export is not configured on this server" });
  }
  if (!authorised(req)) return res.status(401).json({ ok: false, error: "unauthorised" });

  const since = typeof req.query.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.since)
    ? req.query.since
    : "";

  let files;
  try {
    files = fs.readdirSync(RECORDS_DIR).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (e) {
    if (e.code === "ENOENT") return res.type("application/x-ndjson").send("");
    console.error(`[hash-telemetry] export failed: ${e.message}`);
    return res.status(500).json({ ok: false, error: "could not read the records" });
  }

  // <mod>-<version>-<day>.jsonl, and the day is the last three dash-separated pieces of the stem.
  const dayOf = (name) => name.replace(/\.jsonl$/, "").split("-").slice(-3).join("-");
  const wanted = since ? files.filter((name) => dayOf(name) >= since) : files;

  res.type("application/x-ndjson");
  res.set("Cache-Control", "no-store");
  for (const name of wanted) {
    try {
      res.write(fs.readFileSync(path.join(RECORDS_DIR, name), "utf8"));
    } catch (e) {
      // One unreadable file must not silently shorten an export the caller will treat as complete.
      console.error(`[hash-telemetry] export skipped ${name}: ${e.message}`);
      return res.status(500).end();
    }
  }
  res.end();
});

app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1h", extensions: ["html"] }));
app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));

app.listen(PORT, () => console.log(`[hash-telemetry] listening on :${PORT}, data in ${DATA_DIR}`));
