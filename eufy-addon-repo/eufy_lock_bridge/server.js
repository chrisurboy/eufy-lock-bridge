// eufy-lock-bridge (multi-lock)
//
// HTTP bridge for controlling multiple Eufy locks (e.g. T85D0 garage + side
// door) that aren't fully supported yet by eufy-security-ws. Tries normal
// P2P lock/unlock first, and falls back to a reverse-engineered cloud REST
// call for models/situations where P2P isn't available.
//
// Endpoints (per configured lock, addressed by a short key like "garage"):
//   POST /lock/:key
//   POST /unlock/:key
//   GET  /status/:key
//   GET  /locks          -> lists configured keys
//   GET  /health
//
// IMPORTANT CAVEATS (read before relying on this):
// - The cloud fallback (param_type 6000) is reverse-engineered by the
//   community, not documented by Anker/Eufy. Reported working for closely
//   related lock models (C210/C30 family), NOT confirmed for every T85D0
//   unit/firmware. Test carefully before trusting it on a door you need
//   to get through.
// - Known root cause for the underlying P2P/DSK failure (error 20028) on
//   multi-device Eufy accounts: a Bluetooth-only accessory on the same
//   account can corrupt the account-wide key lookup for ALL devices,
//   including fully P2P-capable locks like these. This bridge is a
//   workaround, not a fix — find and isolate that device when you get a
//   chance, since fixing it restores real P2P (push state updates,
//   no polling, no reverse-engineered codes) for both locks below.
// - This script holds your Eufy account credentials. Keep this add-on's
//   config private; don't expose its HTTP port outside your home network.
// - There is no push event for lock state on the cloud-fallback path, so
//   we poll device properties for a few seconds after sending a command
//   to confirm it actually moved.

const express = require("express");
const fs = require("fs");
const { EufySecurity, LogLevel } = require("eufy-security-client");

// Read add-on configuration directly from the file Supervisor mounts for
// every add-on, regardless of base image. This avoids depending on bashio
// (which requires jq and the HA base image's s6-overlay setup) — we just
// need plain JSON parsing, which Node does natively.
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

// Locks are configured as KEY:SERIAL pairs, comma-separated, e.g.:
//   garage:T85D073325220419,side_door:T85D0733252706B7
const LOCKS_RAW = (options && options.locks) || process.env.LOCKS || "";

// Eufy "param_type 6000" lock state values (reverse-engineered).
const PARAM_TYPE_LOCK_STATE = 6000;
const PARAM_VALUE_LOCK = "4";
const PARAM_VALUE_UNLOCK = "3";

if (!EUFY_USERNAME || !EUFY_PASSWORD) {
  console.error(
    "Missing eufy_username / eufy_password. Set these in the add-on Configuration tab, " +
      "then make sure you click Save AND restart the add-on (Configuration changes don't " +
      "apply to an already-running add-on)."
  );
  process.exit(1);
}

const LOCKS = {}; // key -> serial
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
  console.error(
    'No locks configured. Set LOCKS to a comma-separated key:serial list, ' +
      'e.g. "garage:T85D073325220419,side_door:T85D0733252706B7".'
  );
  process.exit(1);
}

console.log("Configured locks:", LOCKS);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let client; // EufySecurity instance, connected once at startup, shared by all locks
let connecting; // promise guard so concurrent requests don't double-connect

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
    const available = devices.map((d) => `${d.getName()} (${d.getSerial()})`).join(", ");
    throw new Error(
      `Lock with serial "${serial}" not found. Devices on account: ${available || "(none returned)"}`
    );
  }
  return lock;
}

async function findStation(c, lock) {
  const stations = await c.getStations();
  return stations.find((s) => s.getSerial() === lock.getStationSerial());
}

async function getLockedState(lock) {
  const props = await lock.getProperties();
  return { locked: !!props.locked, raw: props };
}

// Attempt P2P control first (works for fully-supported models / once the
// account's DSK lookup succeeds; harmlessly fails through to cloud
// fallback otherwise).
async function tryP2P(lock, station, shouldLock) {
  if (!station) return false;

  if (!station.isConnected()) {
    try {
      await station.connect();
      await delay(1500);
    } catch (err) {
      console.warn("Station P2P connect failed:", err.message);
      return false;
    }
  }

  if (!station.isConnected()) return false;

  try {
    if (shouldLock && typeof lock.lock === "function") {
      await lock.lock();
      return true;
    }
    if (!shouldLock && typeof lock.unlock === "function") {
      await lock.unlock();
      return true;
    }
    if (typeof station.unlock === "function" && !shouldLock) {
      await station.unlock(lock);
      return true;
    }
  } catch (err) {
    console.warn("P2P lock/unlock attempt failed, will try cloud fallback:", err.message);
  }
  return false;
}

// Reverse-engineered cloud fallback via the library's own public
// device.setParameters() method (handles auth/signing/response checks the
// same way the library does for every other supported device).
async function cloudFallback(lock, shouldLock) {
  const ok = await lock.setParameters([
    {
      paramType: PARAM_TYPE_LOCK_STATE,
      paramValue: shouldLock ? PARAM_VALUE_LOCK : PARAM_VALUE_UNLOCK,
    },
  ]);

  if (!ok) {
    throw new Error(
      "Cloud fallback (setParameters) returned failure. Check add-on logs " +
        "for the underlying 'Set parameter - Response code not ok' error detail."
    );
  }
  return ok;
}

async function confirmState(lock, shouldLock, { attempts = 8, intervalMs = 1500 } = {}) {
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
  const station = await findStation(c, lock);

  const before = await getLockedState(lock);
  if (before.locked === shouldLock) {
    return { method: "none", message: "Already in desired state", locked: before.locked };
  }

  const p2pAttempted = await tryP2P(lock, station, shouldLock);
  if (p2pAttempted) {
    const confirmed = await confirmState(lock, shouldLock, { attempts: 6, intervalMs: 1000 });
    if (confirmed) {
      return { method: "p2p", message: "Confirmed via P2P", locked: shouldLock };
    }
    console.warn("P2P command sent but state did not confirm; trying cloud fallback.");
  }

  await cloudFallback(lock, shouldLock);
  const confirmed = await confirmState(lock, shouldLock, { attempts: 10, intervalMs: 1500 });
  if (!confirmed) {
    throw new Error(
      "Cloud fallback command was accepted by Eufy's API but the lock state never confirmed the change. " +
        "Check the lock physically and check add-on logs."
    );
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
    res.json({ ok: true, key: req.params.key, ...result });
  } catch (err) {
    console.error(`Lock failed for "${req.params.key}":`, err);
    res.status(500).json({ ok: false, key: req.params.key, error: err.message });
  }
});

app.post("/unlock/:key", async (req, res) => {
  const serial = resolveSerialOrFail(req, res);
  if (!serial) return;
  try {
    const result = await setLockState(serial, false);
    res.json({ ok: true, key: req.params.key, ...result });
  } catch (err) {
    console.error(`Unlock failed for "${req.params.key}":`, err);
    res.status(500).json({ ok: false, key: req.params.key, error: err.message });
  }
});

app.get("/status/:key", async (req, res) => {
  const serial = resolveSerialOrFail(req, res);
  if (!serial) return;
  try {
    const c = await getClient();
    const lock = await findLockBySerial(c, serial);
    const { locked, raw } = await getLockedState(lock);
    res.json({ ok: true, key: req.params.key, locked, properties: raw });
  } catch (err) {
    console.error(`Status check failed for "${req.params.key}":`, err);
    res.status(500).json({ ok: false, key: req.params.key, error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`eufy-lock-bridge listening on port ${PORT}`);
  console.log(`Configured lock keys: ${Object.keys(LOCKS).join(", ")}`);
});
