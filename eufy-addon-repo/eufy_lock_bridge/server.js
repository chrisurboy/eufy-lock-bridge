// eufy-lock-bridge (multi-lock)
//
// HTTP bridge for controlling multiple Eufy locks (e.g. T85D0 garage + side
// door) that aren't fully supported yet by eufy-security-ws. Routes directly 
// to a reverse-engineered cloud REST call for models/situations where P2P 
// local connectivity is unavailable or freezes up the container execution thread.
//
// Endpoints (per configured lock, addressed by a short key like "garage"):
//   POST /lock/:key
//   POST /unlock/:key
//   GET  /status/:key
//   GET  /locks          -> lists configured keys
//   GET  /health

const express = require("express");
const fs = require("fs");
const { EufySecurity, LogLevel } = require("eufy-security-client");

const OPTIONS_PATH = "/data/options.json";

function loadOptions() {
  try {
    const raw = fs.readFileSync(OPTIONS_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      `Could not read/parse ${OPTIONS_PATH}: ${err.message}. ` +
        "Falling back to environment variables (useful for local testing outside HA)."
    );
    return null;
  }
}

const options = loadOptions();

const PORT = process.env.PORT || 8124;
const EUFY_USERNAME = (options && options.eufy_username) || process.env.EUFY_USERNAME;
const EUFY_PASSWORD = (options && options.eufy_password) || process.env.EUFY_PASSWORD;
const EUFY_COUNTRY = (options && options.eufy_country) || process.env.EUFY_COUNTRY || "US";

const LOCKS_RAW = (options && options.locks) || process.env.LOCKS || "";

const PARAM_TYPE_LOCK_STATE = 6000;
const PARAM_VALUE_LOCK = "4";
const PARAM_VALUE_UNLOCK = "3";

if (!EUFY_USERNAME || !EUFY_PASSWORD) {
  console.error(
    "Missing eufy_username / eufy_password. Set these in the add-on Configuration tab."
  );
  process.exit(1);
}

const LOCKS = {}; 
for (const pair of LOCKS_RAW.split(",").map((s) => s.trim()).filter(Boolean)) {
  const idx = pair.indexOf(":");
  if (idx === -1) {
    console.error(`Malformed lock entry "${pair}" — expected format key:serial. Skipping.`);
    continue;
  }
  const key = pair.slice(0, idx).trim();
  const serial = pair.slice(idx + 1).trim();
  if (key && serial) LOCKS[key] = serial;
}

if (Object.keys(LOCKS).length === 0) {
  console.error('No locks configured. Set LOCKS to a comma-separated key:serial list.');
  process.exit(1);
}

console.log("Configured locks:", LOCKS);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let client; 
let connecting; 

async function getClient() {
  if (client && client.isConnected && client.isConnected()) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    console.log("Connecting to Eufy cloud...");
    const c = await EufySecurity.initialize({
      username: EUFY_USERNAME,
      password: EUFY_PASSWORD,
      country: EUFY_COUNTRY,
      language: "en",
      p2pConnectionSetup: "QUICKEST",
      persistentStorage: true,
      logging: { level: LogLevel.Warn },
    });

    c.on("p2p session error", (err) => {
      console.warn("[p2p session error]", err && err.message ? err.message : err);
    });

    await c.connect();
    console.log("Connected to Eufy cloud.");
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function findLockBySerial(c, serial) {
  const devices = await c.getDevices();
  const lock = devices.find((d) => d.getSerial() === serial);
  if (!lock) {
    throw new Error(`Lock with serial "${serial}" not found.`);
  }
  return lock;
}

async function getLockedState(lock) {
  const props = await lock.getProperties();
  return { locked: !!props.locked, raw: props };
}

async function cloudFallback(lock, shouldLock) {
  const ok = await lock.setParameters([
    {
      paramType: PARAM_TYPE_LOCK_STATE,
      paramValue: shouldLock ? PARAM_VALUE_LOCK : PARAM_VALUE_UNLOCK,
    },
  ]);

  if (!ok) {
    throw new Error("Cloud fallback (setParameters) returned failure.");
  }
  return ok;
}

async function confirmState(lock, shouldLock, { attempts = 10, intervalMs = 1500 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    await delay(intervalMs);
    const { locked } = await getLockedState(lock);
    if (locked === shouldLock) return true;
  }
  return false;
}

async function setLockState(serial, shouldLock) {
  const c = await getClient();
  const lock = await findLockBySerial(c, serial);

  const before = await getLockedState(lock);
  if (before.locked === shouldLock) {
    return { method: "none", message: "Already in desired state", locked: before.locked };
  }

  // Bypassing local P2P logic to prevent asynchronous socket hangs inside Hyper-V container environments
  console.log(`[Bridge] Firing direct cloud fallback command for device: ${serial}`);
  await cloudFallback(lock, shouldLock);
  
  const confirmed = await confirmState(lock, shouldLock, { attempts: 10, intervalMs: 1500 });
  if (!confirmed) {
    throw new Error("Cloud fallback command accepted but state never confirmed.");
  }
  return { method: "cloud", message: "Confirmed via cloud fallback", locked: shouldLock };
}

function resolveSerialOrFail(req, res) {
  const key = req.params.key;
  const serial = LOCKS[key];
  if (!serial) {
    res.status(404).json({
      ok: false,
      error: `Unknown lock key "${key}". Configured keys: ${Object.keys(LOCKS).join(", ")}`,
    });
    return null;
  }
  return serial;
}

const app = express();
app.use(express.json());

app.get("/locks", (_req, res) => {
  res.json({ ok: true, locks: LOCKS });
});

app.post("/lock/:key", async (req, res) => {
  const serial = resolveSerialOrFail(req, res);
  if (!serial) return; 
  try {
    const result = await setLockState(serial, true);
    return res.json({ ok: true, key: req.params.key, ...result });
  } catch (err) {
    console.error(`Lock failed for "${req.params.key}":`, err);
    return res.status(500).json({ ok: false, key: req.params.key, error: err.message });
  }
});

app.post("/unlock/:key", async (req, res) => {
  const serial = resolveSerialOrFail(req, res);
  if (!serial) return; 
  try {
    const result = await setLockState(serial, false);
    return res.json({ ok: true, key: req.params.key, ...result });
  } catch (err) {
    console.error(`Unlock failed for "${req.params.key}":`, err);
    return res.status(500).json({ ok: false, key: req.params.key, error: err.message });
  }
});

app.get("/status/:key", async (req, res) => {
  const serial = resolveSerialOrFail(req, res);
  if (!serial) return;
  try {
    const c = await getClient();
    const lock = await findLockBySerial(c, serial);
    const { locked, raw } = await getLockedState(lock);
    return res.json({ ok: true, key: req.params.key, locked, properties: raw });
  } catch (err) {
    console.error(`Status check failed for "${req.params.key}":`, err);
    return res.status(500).json({ ok: false, key: req.params.key, error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`eufy-lock-bridge listening on port ${PORT}`);
});
