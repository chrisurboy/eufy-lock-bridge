# Eufy Lock Bridge — Setup (Garage + Side Door)

A small Home Assistant add-on exposing HTTP endpoints to control Eufy
locks that aren't fully working through `eufy-security-ws` due to the
account-wide DSK/`20028` cloud handshake failure. Configured here for
your two locks:

- **garage** → `T85D073325220419` (static IP `192.168.1.138`)
- **side_door** → `T85D0733252706B7` (static IP `192.168.1.160`)

It tries real P2P lock/unlock first, and falls back to a reverse-engineered
cloud API call if P2P isn't available. See the caveats comment at the top
of `server.js` before relying on this for security — in particular, the
cloud fallback's `param_type 6000` codes aren't officially documented or
confirmed on every T85D0 unit.

## This is a workaround, not the root-cause fix

The 20028 error usually means a Bluetooth-only accessory somewhere on your
Eufy account is corrupting the account-wide key lookup for **every**
device, including these two fully P2P-capable locks. This bridge routes
around that for lock/unlock specifically, but doesn't fix push-based state
updates or the underlying P2P session. When you get a chance, check the
Eufy app for any lock/keypad/sensor that's Bluetooth-only (no WiFi pairing
option) and consider moving it to a separate Eufy account — that's the fix
that restores everything properly for both locks.

## 1. Install as a local add-on

1. On your HA machine, open the add-ons share folder (Samba `\\homeassistant.local\addons`,
   or `/addons` via the SSH/Terminal or Studio Code Server add-on).
2. Create a folder named `eufy_lock_bridge`.
3. Copy these files into it (NOT `node_modules` — Docker builds that):
   - `Dockerfile`, `config.yaml`, `server.js`, `package.json`, `package-lock.json`
4. In HA: **Settings → Add-ons → Add-on Store** → three-dot menu →
   **Check for updates**. A **Local add-ons** section appears with
   **Eufy Lock Bridge**.
5. Click it → **Install**. First build takes a few minutes.

## 2. Configure it

In the add-on's **Configuration** tab:

- `eufy_username` — your Eufy account email
- `eufy_password` — your Eufy account password
- `eufy_country` — two-letter country code, e.g. `US`
- `locks` — pre-filled with:
  `garage:T85D073325220419,side_door:T85D0733252706B7`
  Edit the keys (`garage`/`side_door`) if you'd prefer different names —
  whatever you use here is what you'll reference in the URLs below and in
  the Home Assistant YAML.

Start the add-on, check the **Log** tab for:
```
Configured locks: { garage: 'T85D073325220419', side_door: 'T85D0733252706B7' }
Connecting to Eufy cloud...
Connected to Eufy cloud.
eufy-lock-bridge listening on port 8124
Configured lock keys: garage, side_door
```

**If you see `s6-overlay-suexec: fatal: can only run as pid 1` or `sh: jq: not found`** in the log, Supervisor is running a stale/cached build rather than the current source. Don't just click Start again — go to the add-on page, click **Uninstall**, bump the `version` field in `config.yaml` in your repo (e.g. `0.2.0` → `0.2.1`), push that change, then re-add/reinstall fresh. Supervisor uses the version string to decide whether to rebuild; without bumping it, it can silently reuse old image layers even after you've changed the Dockerfile.

## 3. Test both locks directly before wiring up Home Assistant

Replace `<HA_IP>` with your Home Assistant's IP:

```bash
curl http://<HA_IP>:8124/locks

curl http://<HA_IP>:8124/status/garage
curl -X POST http://<HA_IP>:8124/unlock/garage
curl -X POST http://<HA_IP>:8124/lock/garage

curl http://<HA_IP>:8124/status/side_door
curl -X POST http://<HA_IP>:8124/unlock/side_door
curl -X POST http://<HA_IP>:8124/lock/side_door
```

Watch the add-on log while testing — it tells you whether each command
went through P2P or the cloud fallback, and whether the state confirmed.

**Test with someone physically able to check each lock**, especially on
the first several tries, before trusting either one unattended.

## 4. Wire both locks into Home Assistant

Add to `configuration.yaml`:

```yaml
rest_command:
  eufy_garage_lock:
    url: "http://localhost:8124/lock/garage"
    method: POST
  eufy_garage_unlock:
    url: "http://localhost:8124/unlock/garage"
    method: POST
  eufy_side_door_lock:
    url: "http://localhost:8124/lock/side_door"
    method: POST
  eufy_side_door_unlock:
    url: "http://localhost:8124/unlock/side_door"
    method: POST

rest:
  - resource: "http://localhost:8124/status/garage"
    scan_interval: 30
    sensor:
      - name: "Eufy Garage Lock State"
        value_template: "{{ 'locked' if value_json.locked else 'unlocked' }}"
  - resource: "http://localhost:8124/status/side_door"
    scan_interval: 30
    sensor:
      - name: "Eufy Side Door Lock State"
        value_template: "{{ 'locked' if value_json.locked else 'unlocked' }}"

template:
  - lock:
      - name: "Garage Lock (Bridge)"
        state: "{{ states('sensor.eufy_garage_lock_state') | default('unknown') }}"
        lock:
          - action: rest_command.eufy_garage_lock
        unlock:
          - action: rest_command.eufy_garage_unlock
      - name: "Side Door Lock (Bridge)"
        state: "{{ states('sensor.eufy_side_door_lock_state') | default('unknown') }}"
        lock:
          - action: rest_command.eufy_side_door_lock
        unlock:
          - action: rest_command.eufy_side_door_unlock
```

Restart Home Assistant (or reload YAML) afterward, then look for two new
lock entities. `localhost` works here since the add-on and HA Core share
the HAOS host network — use the host's LAN IP instead if that's not the
case in your setup.

This is a working starting point, not a fully polished entity — once both
locks are confirmed reliable, it's worth refining state tracking (pending
locking/unlocking states, retries) further if you want.
