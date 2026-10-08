// Bambu Lab printer driver — MQTT over TLS + FTPS
// Connector family: Bambu MQTT
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Prerequisites on the printer (both required):
//   Settings → Network → LAN Only Mode: ON
//   Settings → Network → Developer Mode: ON  ← appears after LAN Mode is on
//   Developer Mode eliminates the X.509 certificate signing requirement for commands.
//
// Credentials stored in DB:
//   printer.ip            — local IP address
//   printer.api_key       — access code (shown on printer screen under WiFi settings)
//   printer.serial_number — device serial number (used as MQTT topic path)
//
// Connection model (differs from Prusa/Elegoo):
//   Bambu pushes status to device/{serial}/report continuously — there is no
//   request/response polling. We subscribe once and cache the latest payload.
//   getStatus() returns from cache instantly. OFFLINE is returned until the
//   first status message arrives after connect.
//
// Bambu sends partial status updates, not full state each time.
// We merge each incoming update into conn.latestPrint so no fields are lost.
//
// Protocol reference: https://github.com/Doridian/OpenBambuAPI

const mqtt     = require('mqtt');
const ftp      = require('basic-ftp');
const path     = require('path');
const { execFile } = require('child_process');
const { openThreeMf, detectProjectMetadata, parsePlateFilaments } = require('../parse-3mf');

// Map of printer.id → { client, latestPrint, connected }
const connections = new Map();

// ─── Connection management ────────────────────────────────────────────────────

// Returns (or creates) the connection object for a printer.
// The MQTT connection is established in the background — callers should
// check conn.connected before sending commands.
function getOrCreateConnection(printer) {
  if (connections.has(printer.id)) {
    return connections.get(printer.id);
  }

  const serial = printer.serial_number;
  const conn   = { client: null, latestPrint: null, connected: false };
  connections.set(printer.id, conn);

  const client = mqtt.connect(`mqtts://${printer.ip}:8883`, {
    username:          'bblp',
    password:          printer.api_key, // access code from printer WiFi settings
    rejectUnauthorized: false,          // Bambu uses a self-signed TLS certificate — intentional
    reconnectPeriod:   5000,
    connectTimeout:    10000,
  });

  conn.client = client;

  client.on('connect', () => {
    conn.connected = true;

    // Subscribe to the printer's status push topic
    client.subscribe(`device/${serial}/report`, (err) => {
      if (err) console.warn(`[bambu] ${printer.name} subscribe error:`, err.message);
    });

    // Request an immediate full status dump so the cache is populated right away
    // rather than waiting for the next natural push interval.
    client.publish(`device/${serial}/request`, JSON.stringify({
      pushing: { sequence_id: '0', command: 'pushall', push_target: 1 },
    }));

    console.log(`[bambu] Connected to ${printer.name} (${printer.ip})`);
  });

  client.on('message', (_topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      // All status fields arrive under data.print.
      // Merge — Bambu sends partial updates, not a full snapshot each time.
      if (data.print) {
        conn.latestPrint = { ...conn.latestPrint, ...data.print };
      }
    } catch (_) {}
  });

  client.on('reconnect', () => {
    conn.connected = false;
    console.log(`[bambu] ${printer.name} reconnecting…`);
  });

  client.on('offline', () => {
    conn.connected = false;
  });

  client.on('error', (err) => {
    conn.connected = false;
    if (process.env.DEBUG_BAMBU) {
      console.warn(`[bambu] ${printer.name} error:`, err?.message || err);
    }
  });

  return conn;
}

function dropConnection(printerId) {
  const conn = connections.get(printerId);
  if (conn) {
    try { conn.client?.end(true); } catch (_) {}
    connections.delete(printerId);
  }
}

function isFtpsSessionReuseError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('session reuse required') ||
         msg.includes('ssl connection failed: session reuse required') ||
         msg.includes('server sent fin packet unexpectedly') ||
         msg.includes('premature close');
}

function uploadViaCurlFtps(printer, localPath, remoteFilename) {
  return new Promise((resolve, reject) => {
    const encodedFilename = encodeURIComponent(remoteFilename);
    const url = `ftps://${printer.ip}:990/${encodedFilename}`;
    const args = [
      '--silent', '--show-error', '--fail',
      '--insecure',
      '--ftp-ssl-reqd',
      '--tlsv1.2',
      '--disable-epsv',
      '--user', `bblp:${printer.api_key}`,
      '--upload-file', localPath,
      url,
    ];

    execFile('curl', args, { timeout: 300000, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve();

      if (err.code === 'ENOENT') {
        return reject(Object.assign(
          new Error('FTPS fallback requires curl, but curl is not installed in this runtime.'),
          { code: 'BAMBU_FTPS_SESSION_REUSE' }
        ));
      }

      const details = (stderr || '').trim();
      return reject(Object.assign(
        new Error(details ? `curl FTPS upload failed: ${details}` : `curl FTPS upload failed (${err.message})`),
        { code: 'BAMBU_FTPS_SESSION_REUSE' }
      ));
    });
  });
}

// ─── 3MF parsing ────────────────────────────────────────────────────────────
// openThreeMf / detectProjectMetadata / parsePlateFilaments are in ../parse-3mf.

// Builds ams_mapping aligned to the .3mf's real filament indices. Bambu indexes the
// mapping by each filament's position in the project (0-based id - 1) and sizes it to the
// project's filament count, so a file that uses only filaments 5 and 6 of a 6-filament
// project needs [-1, -1, -1, -1, slotA, slotB], not [slotA, slotB]. Each used filament's
// color is matched to a loaded AMS tray by hex; if any color cannot be matched, the
// scheduler's already color-matched trays (requestedAmsSlots, in required-color order)
// are aligned to the used filament ids in ascending order. Returns null when the plate
// cannot be parsed so the caller can fall back to the padded single-list format.
function buildAmsMappingFromThreeMf(threeMfPath, plateIndex, printer, requestedAmsSlots) {
  const plate = parsePlateFilaments(threeMfPath, plateIndex);
  if (!plate || plate.filaments.length === 0) return null;

  const maxId = Math.max(...plate.filaments.map((f) => f.id));
  const length = Math.max(plate.filamentCount || 0, maxId);
  if (!Number.isFinite(length) || length < 1 || length > 64) return null;

  const slots = getAmsSlots(printer) || [];

  // Primary: match each used filament's color to a currently loaded AMS tray by hex.
  const mapping = new Array(length).fill(-1);
  const usedTraySlots = new Set();
  let allMatched = true;
  for (const fil of plate.filaments) {
    if (!Number.isFinite(fil.id) || fil.id < 1 || fil.id > length) { allMatched = false; break; }
    const tray = fil.hex ? slots.find((s) => {
      if (usedTraySlots.has(s.slot)) return false;
      const sHex = typeof s.color === 'string' ? s.color.slice(0, 6).toUpperCase() : null;
      return sHex === fil.hex;
    }) : null;
    if (!tray) { allMatched = false; break; }
    mapping[fil.id - 1] = tray.slot;
    usedTraySlots.add(tray.slot);
  }
  if (allMatched) return mapping;

  // Fallback: align the scheduler's color-matched trays to the used filament ids.
  if (Array.isArray(requestedAmsSlots) && requestedAmsSlots.length === plate.filaments.length) {
    const sorted = [...plate.filaments].sort((a, b) => a.id - b.id);
    const aligned = new Array(length).fill(-1);
    for (let i = 0; i < sorted.length; i++) {
      const id = sorted[i].id;
      if (!Number.isFinite(id) || id < 1 || id > length) return null;
      aligned[id - 1] = requestedAmsSlots[i];
    }
    return aligned;
  }

  return null;
}

// ─── Canonical state mapping ──────────────────────────────────────────────────

// Maps Bambu gcode_state strings to canonical status strings.
// Source: OpenBambuAPI — https://github.com/Doridian/OpenBambuAPI
//
// RUNNING  = Active print in progress
// PREPARE  = Bed leveling, heating, homing before first layer — treat as PRINTING
// IDLE     = Standby, no print loaded
// PAUSE    = Print paused by operator or firmware event
// FINISH   = Print complete — triggers operator confirmation in farm UI
// FAILED   = Print did not complete — covers BOTH firmware-detected failures and
//            user-cancelled prints. See the print_error disambiguation in getStatus.
function mapStatus(gcodeState) {
  switch (gcodeState) {
    case 'RUNNING':  return 'PRINTING';
    case 'PREPARE':  return 'PRINTING'; // calibration/homing before layers begin
    case 'IDLE':     return 'IDLE';
    case 'PAUSE':    return 'PAUSED';
    case 'FINISH':   return 'FINISHED';
    case 'FAILED':   return 'ERROR';
    default:         return 'UNKNOWN';
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Bambu reports a user-cancelled print (Stop pressed on the printer screen) as
// gcode_state FAILED — the same state as a genuine print failure — and keeps
// reporting FAILED until the next print starts or the printer power-cycles.
// The two cases are distinguished by print_error:
//   50348044 (0x0300400C) — print cancelled by the user; sent for a few seconds
//                           after the stop, then print_error resets to 0 while
//                           gcode_state stays FAILED
//   any other nonzero     — genuine firmware-detected failure
//   0                     — no active error; FAILED with no error code is a
//                           settled user cancel
// Ref: ha-bambulab pybambu/models.py (isCanceledPrint handling)
const BAMBU_USER_CANCELLED = 50348044;

// Returns { status, progress, timeRemaining, currentFile }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | STOPPED | ERROR | OFFLINE | UNKNOWN
// progress (0–100), timeRemaining (seconds), and currentFile are null when not printing.
async function getStatus(printer) {
  if (!printer.serial_number) {
    // Misconfigured — serial number required for MQTT topics
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const conn = getOrCreateConnection(printer);

  if (!conn.connected || !conn.latestPrint) {
    // Not yet connected or no status received — report OFFLINE, connection is
    // retrying in the background via reconnectPeriod.
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const print = conn.latestPrint;
  let status  = mapStatus(print.gcode_state);

  // User-cancelled prints report FAILED — remap to STOPPED so the scheduler
  // cancels the job (rather than failing it) and the UI doesn't show a false
  // error. Real failures carry a persistent nonzero print_error.
  if (status === 'ERROR') {
    const printError = print.print_error ?? 0;
    if (printError === 0 || printError === BAMBU_USER_CANCELLED) {
      status = 'STOPPED';
    }
  }

  const progress = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_percent ?? null)
    : null;

  // Bambu reports mc_remaining_time in minutes — convert to seconds for UI consistency.
  const timeRemaining = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_remaining_time != null ? print.mc_remaining_time * 60 : null)
    : null;

  // subtask_name is the file or project currently printing.
  // Strip the multer-prepended timestamp prefix (e.g. "1712345678901_benchy.gcode").
  const rawFilename = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.subtask_name ?? null)
    : null;
  const currentFile = rawFilename ? rawFilename.replace(/^\d+_/, '') : null;

  return { status, progress, timeRemaining, currentFile };
}

// ─── Upload & Print ───────────────────────────────────────────────────────────

// Returns the current AMS slot list from the cached MQTT state, or null if not connected.
// Each slot: { slot, type, color, brand }
//   slot  — compound id: (ams_unit * 4) + tray_id, or -1 for external spool
//   type  — filament type string e.g. 'PLA', or '' if unknown
//   color — RRGGBBAA hex string, or null
//   brand — vendor/brand string when reported by firmware, or ''
// Empty trays (no tray_type field) are omitted. External spool is always included.
function getAmsSlots(printer) {
  const conn = connections.get(printer.id);
  if (!conn?.latestPrint) return null;

  const slots = [];

  const rawAms = conn.latestPrint.ams;
  let amsUnits = [];

  // Classic AMS payload shape: { ams: { ams: [{ id, tray: [...] }, ...] } }
  if (Array.isArray(rawAms?.ams)) {
    amsUnits = rawAms.ams.map((unit, idx) => ({
      id: unit?.id,
      trays: Array.isArray(unit?.tray) ? unit.tray : [],
      idx,
    }));
  }

  // AMS Lite payload shape: { ams: { tray: [...] } }
  if (amsUnits.length === 0 && Array.isArray(rawAms?.tray)) {
    amsUnits = [{ id: 0, trays: rawAms.tray, idx: 0 }];
  }

  // Some firmwares expose ams as a direct array. It can be either a unit list
  // or a direct tray list.
  if (amsUnits.length === 0 && Array.isArray(rawAms)) {
    const directTrayList = rawAms.every((item) => item && !Array.isArray(item?.tray) && ('tray_type' in item || 'tray_color' in item));
    if (directTrayList) {
      amsUnits = [{ id: 0, trays: rawAms, idx: 0 }];
    } else {
      amsUnits = rawAms.map((unit, idx) => ({
        id: unit?.id,
        trays: Array.isArray(unit?.tray) ? unit.tray : [],
        idx,
      }));
    }
  }

  // Last-resort AMS Lite shape: top-level tray list.
  if (amsUnits.length === 0 && Array.isArray(conn.latestPrint.tray)) {
    amsUnits = [{ id: 0, trays: conn.latestPrint.tray, idx: 0 }];
  }

  const rawAmsIds = amsUnits
    .map((u) => parseInt(u?.id, 10))
    .filter(Number.isFinite);
  const amsIdsAreOneBased = rawAmsIds.length > 0 && !rawAmsIds.includes(0);
  const rawTrayIds = amsUnits
    .flatMap((unit) => (unit.trays || []).map((t) => parseInt(t?.id, 10)))
    .filter(Number.isFinite);
  const trayIdsAreOneBased = rawTrayIds.length > 0 && !rawTrayIds.includes(0);

  for (const unit of amsUnits) {
    const rawAmsId = parseInt(unit.id, 10);
    const amsIndex = Number.isFinite(rawAmsId)
      ? (amsIdsAreOneBased ? rawAmsId - 1 : rawAmsId)
      : unit.idx;

    const trays = unit.trays || [];
    for (let trayPos = 0; trayPos < trays.length; trayPos += 1) {
      const tray = trays[trayPos];
      if (!tray.tray_type) continue; // empty slot — no filament loaded

      const rawTrayId = parseInt(tray.id, 10);
      const trayIndex = Number.isFinite(rawTrayId)
        ? (trayIdsAreOneBased ? rawTrayId - 1 : rawTrayId)
        : trayPos;

      slots.push({
        slot:  amsIndex * 4 + trayIndex,
        type:  tray.tray_type,
        color: tray.tray_color || null,
        brand: tray.tray_brand || tray.tray_sub_brands || '',
      });
    }
  }

  // External spool is always an option regardless of whether filament is loaded
  const vt = conn.latestPrint.vt_tray;
  const externalType = typeof vt?.tray_type === 'string' ? vt.tray_type.trim() : '';
  const externalColor = externalType ? (vt?.tray_color || null) : null;
  const externalBrand = externalType ? (vt?.tray_brand || vt?.tray_sub_brands || '') : '';
  slots.push({
    slot:  -1,
    type:  externalType,
    color: externalColor,
    brand: externalBrand,
  });

  return slots;
}

// Formats AMS slot selections into Bambu's required ams_mapping shape: a fixed
// 5-element array, right-aligned and left-padded with -1. The provided slots fill the
// last N positions in order (filament 0 first), so [2, 3] becomes [-1, -1, -1, 2, 3].
// Ref: https://github.com/Doridian/OpenBambuAPI mqtt.md → AMS Mapping Configuration.
function buildAmsMapping(slots) {
  const mapping = [-1, -1, -1, -1, -1];
  const count = Math.min(slots.length, mapping.length);
  for (let i = 0; i < count; i++) {
    mapping[mapping.length - count + i] = slots[i];
  }
  return mapping;
}

// Uploads the G-code file to the printer via FTPS, then triggers printing via MQTT.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// options.amsSlot: -1 = external spool, 0–N = AMS slot, null = default (external)
async function uploadAndPrint(printer, gcodeFullPath, _filename, options = {}) {
  const { amsSlot = null } = options;
  if (!printer.serial_number) {
    throw new Error(`Bambu printer ${printer.name} has no serial number configured`);
  }

  const onPrinterFilename = path.basename(gcodeFullPath);
  const ext = path.extname(onPrinterFilename).toLowerCase();

  // Bambu printers only support .3mf files via the project_file MQTT command.
  // The gcode_file command is non-functional on A-series (A1, A2, A2L) and
  // wrapping a plain gcode in a minimal .3mf does not satisfy firmware validation.
  // Operators must export .3mf from Bambu Studio or Orca Slicer.
  if (ext !== '.3mf') {
    throw new Error(
      `Bambu printer ${printer.name} requires a .3mf file. ` +
      `Export from Bambu Studio or Orca Slicer instead of uploading a plain .gcode.`
    );
  }

  // ── FTPS upload ──────────────────────────────────────────────────────────
  // .3mf files go to the SD card root.
  console.log(`[bambu] Uploading ${onPrinterFilename} to ${printer.name} via FTPS…`);

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    await ftpClient.uploadFrom(gcodeFullPath, onPrinterFilename);
    console.log(`[bambu] Upload complete on ${printer.name}`);
  } catch (err) {
    if (!isFtpsSessionReuseError(err)) throw err;

    console.warn(
      `[bambu] ${printer.name} FTPS data-channel rejected TLS session reuse ` +
      `(${err.message}). Retrying upload via curl fallback…`
    );

    try {
      await uploadViaCurlFtps(printer, gcodeFullPath, onPrinterFilename);
      console.log(`[bambu] Upload complete on ${printer.name} (curl fallback)`);
    } catch (fallbackErr) {
      const wrapped = Object.assign(
        new Error(
          `Bambu FTPS upload failed: printer requires TLS session reuse on data connections. ` +
          `${fallbackErr.message}`
        ),
        { code: 'BAMBU_FTPS_SESSION_REUSE' }
      );
      throw wrapped;
    }
  } finally {
    ftpClient.close();
  }

  // ── MQTT print trigger ───────────────────────────────────────────────────
  const conn = getOrCreateConnection(printer);

  if (!conn.connected) {
    throw new Error(`Bambu printer ${printer.name} MQTT not connected — cannot trigger print`);
  }

  // ams_mapping must be indexed by each filament's position in the .3mf project and
  // sized to the project's filament count. buildAmsMappingFromThreeMf reads those real
  // indices from the plate's slice_info.config; the padded single-list buildAmsMapping
  // is only a fallback when the filament table cannot be read. A misindexed or
  // variable-length array is rejected by stricter firmware such as the dual-nozzle X2D
  // with "failed to get AMS mapping table". External spool / no AMS sends use_ams:false.
  // Ref: https://github.com/Doridian/OpenBambuAPI (issue #38 + mqtt.md)
  const subtaskName = path.basename(onPrinterFilename, '.3mf');
  const requestedAmsSlots = Array.isArray(options?.amsSlots) && options.amsSlots.length > 0
    ? options.amsSlots
    : (amsSlot != null && amsSlot >= 0 ? [amsSlot] : []);
  const useAms = requestedAmsSlots.length > 0;
  const { projectFileParam, bedType, plateIndex } = detectProjectMetadata(gcodeFullPath, options.plateNo ?? null);
  const amsMapping = useAms
    ? (buildAmsMappingFromThreeMf(gcodeFullPath, plateIndex, printer, requestedAmsSlots) || buildAmsMapping(requestedAmsSlots))
    : [];
  const printPayload = {
    sequence_id:     '0',
    command:         'project_file',
    param:           projectFileParam,
    subtask_name:    subtaskName,
    url:             `ftp:///${onPrinterFilename}`,
    bed_type:        bedType,
    timelapse:       false,
    bed_leveling:    true,
    flow_cali:       false,
    // Some printers intermittently stall in preflight (for example waiting on
    // heatbed temp while already at target) when vibration calibration is forced
    // via MQTT. Keep this off and let the sliced project/printer defaults govern.
    vibration_cali:  false,
    layer_inspect:   false,
    use_ams:         useAms,
    ams_mapping:     amsMapping,
    profile_id:      '0',
    project_id:      '0',
    subtask_id:      '0',
    task_id:         '0',
  };

  const mqttPayload = JSON.stringify({ print: printPayload });
  console.log(`[bambu] MQTT payload → ${printer.name}: ${mqttPayload}`);
  conn.client.publish(`device/${printer.serial_number}/request`, mqttPayload, (err) => {
    if (err) console.error(`[bambu] MQTT publish failed for ${printer.name}:`, err.message);
    else console.log(`[bambu] MQTT publish confirmed for ${printer.name}`);
  });
}

// ─── File cleanup ─────────────────────────────────────────────────────────────

// Deletes a file from the printer's SD card via FTPS.
// Called by the scheduler after a job finishes to prevent accumulation of files.
async function deleteFile(printer, filename) {
  if (!filename) return;

  // All Bambu uploads are .3mf files at the SD card root.
  const remotePath = filename;

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    await ftpClient.remove(remotePath);
    console.log(`[bambu] Deleted ${remotePath} from ${printer.name}`);
  } catch (err) {
    // Non-fatal — file may have already been deleted or never uploaded
    console.warn(`[bambu] Could not delete ${filename} from ${printer.name}: ${err.message}`);
  } finally {
    ftpClient.close();
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  if (!printer.serial_number) return;

  const conn = connections.get(printer.id);
  if (!conn?.connected) {
    console.warn(`[bambu] ${printer.name} not connected — cannot cancel`);
    return;
  }

  conn.client.publish(`device/${printer.serial_number}/request`, JSON.stringify({
    print: { sequence_id: '0', command: 'stop' },
  }));

  console.log(`[bambu] Job cancelled on ${printer.name}`);
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
async function checkIfPrinting(printer) {
  const { status } = await getStatus(printer);
  return status === 'PRINTING' || status === 'PAUSED';
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, getAmsSlots, deleteFile };
