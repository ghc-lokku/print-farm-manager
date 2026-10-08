// Unit tests for server/drivers/bambu.js
// mqtt and basic-ftp are mocked — no real network connections needed.
//
// Each test uses a unique printer ID to avoid sharing the module-level
// connection cache (Map of id → conn) between test cases.

jest.mock('mqtt');
jest.mock('basic-ftp');
jest.mock('child_process', () => ({ execFile: jest.fn() }));

const mqtt = require('mqtt');
const ftp  = require('basic-ftp');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bambu = require('../drivers/bambu');

// ─── Mock setup ───────────────────────────────────────────────────────────────

let mockPublish;
let mockSubscribe;
let mockMqttClient;
let messageHandler; // captured from client.on('message', handler)

let mockFtpClient;

beforeEach(() => {
  messageHandler = null;

  mockPublish   = jest.fn();
  mockSubscribe = jest.fn();

  mockMqttClient = {
    // Fire 'connect' synchronously so conn.connected = true immediately.
    // Capture 'message' handler for AMS state injection in tests.
    on: jest.fn((event, handler) => {
      if (event === 'connect') handler();
      if (event === 'message') messageHandler = handler;
    }),
    publish:   mockPublish,
    subscribe: mockSubscribe,
    end:       jest.fn(),
  };
  mqtt.connect.mockReturnValue(mockMqttClient);

  mockFtpClient = {
    ftp:        { verbose: false },
    access:     jest.fn().mockResolvedValue(undefined),
    uploadFrom: jest.fn().mockResolvedValue(undefined),
    close:      jest.fn(),
  };
  ftp.Client.mockImplementation(() => mockFtpClient);

  execFile.mockImplementation((_bin, _args, _opts, cb) => cb(null, '', ''));
});

afterEach(() => jest.clearAllMocks());

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idSeq = 300;
function nextPrinter() {
  const id = idSeq++;
  return { id, name: `Bambu_${id}`, ip: '192.168.1.50', api_key: 'TESTCODE',
           serial_number: `SN${id}`, model: 'x1c', type: 'bambu' };
}

// Establish a connection for the printer (populates the internal Map)
// then inject a status push to set conn.latestPrint.
function pushStatus(printer, printData) {
  bambu.getStatus(printer); // creates connection, registers message handler
  expect(messageHandler).not.toBeNull();
  messageHandler(null, Buffer.from(JSON.stringify({ print: printData })));
}

// Parse the MQTT payload from the first publish call that matches a command.
function findPayload(command) {
  const call = mockPublish.mock.calls.find(c => {
    try { return JSON.parse(c[1]).print?.command === command; } catch { return false; }
  });
  return call ? JSON.parse(call[1]).print : null;
}

function buildZipWithEntries(entryNames, entryContentByName = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const name of entryNames) {
    const nameBuf = Buffer.from(name, 'utf8');
    const content = Buffer.from(entryContentByName[name] || '', 'utf8');
    const size = content.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(1 << 11, 6);    // UTF-8 filename flag
    local.writeUInt16LE(0, 8);          // store (no compression)
    local.writeUInt16LE(0, 10);         // mod time
    local.writeUInt16LE(0, 12);         // mod date
    local.writeUInt32LE(0, 14);         // crc32
    local.writeUInt32LE(size, 18);      // compressed size
    local.writeUInt32LE(size, 22);      // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(1 << 11, 8);    // UTF-8 filename flag
    central.writeUInt16LE(0, 10);         // store (no compression)
    central.writeUInt16LE(0, 12);         // mod time
    central.writeUInt16LE(0, 14);         // mod date
    central.writeUInt32LE(0, 16);         // crc32
    central.writeUInt32LE(size, 20);      // compressed size
    central.writeUInt32LE(size, 24);      // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra length
    central.writeUInt16LE(0, 32);         // comment length
    central.writeUInt16LE(0, 34);         // disk start
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(localOffset, 42);

    localParts.push(local, nameBuf, content);
    centralParts.push(central, nameBuf);
    localOffset += local.length + nameBuf.length + size;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                      // disk number
  eocd.writeUInt16LE(0, 6);                      // central dir start disk
  eocd.writeUInt16LE(entryNames.length, 8);      // entries on this disk
  eocd.writeUInt16LE(entryNames.length, 10);     // total entries
  eocd.writeUInt32LE(centralDir.length, 12);     // central dir size
  eocd.writeUInt32LE(localOffset, 16);           // central dir offset
  eocd.writeUInt16LE(0, 20);                     // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ─── getAmsSlots ──────────────────────────────────────────────────────────────

describe('getAmsSlots', () => {
  test('returns null when printer has no connection yet', () => {
    expect(bambu.getAmsSlots(nextPrinter())).toBeNull();
  });

  test('returns null when connected but no status received yet', () => {
    const printer = nextPrinter();
    bambu.getStatus(printer); // creates connection; latestPrint is still null
    expect(bambu.getAmsSlots(printer)).toBeNull();
  });

  test('returns loaded AMS trays, skipping empty slots', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        ams: [{
          id: '0',
          tray: [
            { id: '0' },                                             // empty — no tray_type
            { id: '1', tray_type: 'PLA', tray_color: 'FFFFFFFF' }, // loaded
          ],
        }],
      },
      vt_tray: { tray_type: 'PETG', tray_color: 'FF0000FF' },
    });

    const slots = bambu.getAmsSlots(printer);
    // AMS unit 0, tray 1 → compound slot (0*4)+1 = 1
    expect(slots).toContainEqual({ slot: 1, type: 'PLA', color: 'FFFFFFFF', brand: '' });
    // Empty tray (id 0) must be excluded
    expect(slots.find(s => s.slot === 0 && s.type)).toBeUndefined();
  });

  test('always includes external spool as slot -1', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams:     { ams: [] },
      vt_tray: { tray_type: 'ABS', tray_color: '000000FF' },
    });
    expect(bambu.getAmsSlots(printer)).toContainEqual(
      { slot: -1, type: 'ABS', color: '000000FF', brand: '' }
    );
  });

  test('includes external spool even when no filament is loaded', () => {
    const printer = nextPrinter();
    pushStatus(printer, { ams: { ams: [] }, vt_tray: {} });
    const ext = bambu.getAmsSlots(printer).find(s => s.slot === -1);
    expect(ext).toBeDefined();
    expect(ext.type).toBe('');
  });

  test('clears stale external spool color when no external filament type is loaded', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: { ams: [] },
      vt_tray: { tray_type: '', tray_color: '161616FF' },
    });

    const ext = bambu.getAmsSlots(printer).find(s => s.slot === -1);
    expect(ext).toBeDefined();
    expect(ext.type).toBe('');
    expect(ext.color).toBeNull();
  });

  test('computes compound slot IDs for multi-unit AMS', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        ams: [
          { id: '0', tray: [{ id: '0', tray_type: 'PLA',  tray_color: 'FFFF00FF' }] },
          { id: '1', tray: [{ id: '2', tray_type: 'ABS',  tray_color: '000000FF' }] },
        ],
      },
      vt_tray: {},
    });
    const slots = bambu.getAmsSlots(printer);
    expect(slots).toContainEqual({ slot: 0, type: 'PLA', color: 'FFFF00FF', brand: '' }); // (0*4)+0
    expect(slots).toContainEqual({ slot: 6, type: 'ABS', color: '000000FF', brand: '' }); // (1*4)+2
  });

  test('normalizes one-based AMS and tray IDs to zero-based compound slots', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        ams: [
          { id: '1', tray: [{ id: '1', tray_type: 'PLA', tray_color: 'FFFFFFFF' }] },
        ],
      },
      vt_tray: {},
    });

    const slots = bambu.getAmsSlots(printer);
    expect(slots).toContainEqual({ slot: 0, type: 'PLA', color: 'FFFFFFFF', brand: '' });
  });

  test('parses AMS Lite tray list from ams.tray payload shape', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        tray: [
          { id: '0', tray_type: 'PLA', tray_color: 'FFFFFFFF' },
          { id: '1', tray_type: 'PLA', tray_color: '000000FF' },
          { id: '2', tray_type: 'PETG', tray_color: 'FF0000FF' },
          { id: '3', tray_type: 'TPU', tray_color: '00FF00FF' },
        ],
      },
      vt_tray: {},
    });

    const slots = bambu.getAmsSlots(printer);
    expect(slots).toContainEqual({ slot: 0, type: 'PLA', color: 'FFFFFFFF', brand: '' });
    expect(slots).toContainEqual({ slot: 1, type: 'PLA', color: '000000FF', brand: '' });
    expect(slots).toContainEqual({ slot: 2, type: 'PETG', color: 'FF0000FF', brand: '' });
    expect(slots).toContainEqual({ slot: 3, type: 'TPU', color: '00FF00FF', brand: '' });
  });

  test('parses AMS Lite direct ams array tray payload shape', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: [
        { tray_type: 'PLA', tray_color: 'FFFFFFFF' },
        { tray_type: 'ABS', tray_color: '000000FF' },
      ],
      vt_tray: {},
    });

    const slots = bambu.getAmsSlots(printer);
    expect(slots).toContainEqual({ slot: 0, type: 'PLA', color: 'FFFFFFFF', brand: '' });
    expect(slots).toContainEqual({ slot: 1, type: 'ABS', color: '000000FF', brand: '' });
  });
});

// ─── getStatus — FAILED disambiguation ───────────────────────────────────────
// Bambu reports user-cancelled prints as gcode_state FAILED, same as genuine
// failures. print_error tells them apart: 50348044 = cancelled by user (resets
// to 0 a few seconds later while gcode_state stays FAILED); any other nonzero
// value = real firmware-detected failure.

describe('getStatus — FAILED: user cancel vs real failure', () => {
  test('FAILED with cancel code 50348044 maps to STOPPED', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED', print_error: 50348044 });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with print_error 0 (settled cancel) maps to STOPPED', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED', print_error: 0 });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with no print_error field maps to STOPPED', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED' });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with a different nonzero print_error maps to ERROR', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED', print_error: 117473285 });
    expect((await bambu.getStatus(printer)).status).toBe('ERROR');
  });

  test('RUNNING with a nonzero print_error stays PRINTING', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'RUNNING', print_error: 50348044, mc_percent: 40 });
    expect((await bambu.getStatus(printer)).status).toBe('PRINTING');
  });
});

// ─── uploadAndPrint — .3mf ────────────────────────────────────────────────────

describe('uploadAndPrint — .3mf (project_file)', () => {
  test('uses project_file MQTT command', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file')).not.toBeNull();
  });

  test('URL is ftp:///filename (per OpenBambuAPI spec)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file').url).toBe('ftp:///1234_part.3mf');
  });

  test('AMS slot 0: use_ams true, ams_mapping padded to [-1,-1,-1,-1,0]', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([-1, -1, -1, -1, 0]);
  });

  test('AMS slot 3: ams_mapping padded to [-1,-1,-1,-1,3]', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 3 });

    expect(findPayload('project_file').ams_mapping).toEqual([-1, -1, -1, -1, 3]);
  });

  test('multi-color amsSlots [2,3]: ams_mapping padded to [-1,-1,-1,2,3]', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 2, amsSlots: [2, 3] });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([-1, -1, -1, 2, 3]);
  });

  test('external spool (amsSlot: -1): use_ams false, ams_mapping empty array', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: -1 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toEqual([]);
  });

  test('null amsSlot defaults to use_ams false (external spool)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: null });

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('omitting options entirely defaults to use_ams false', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf');

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('uploads to FTP root (no ensureDir for .3mf)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith('/tmp/1234_part.3mf', '1234_part.3mf');
  });

  test('throws when MQTT is not connected', async () => {
    const printer = nextPrinter();
    // Override: suppress 'connect' so conn.connected stays false
    mockMqttClient.on = jest.fn((event, handler) => {
      if (event === 'message') messageHandler = handler;
    });
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/MQTT not connected/);
  });

  test('throws when serial_number is missing', async () => {
    const printer = { ...nextPrinter(), serial_number: '' };
    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/no serial number/);
  });

  test('falls back to curl FTPS when basic-ftp hits session reuse error', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    mockFtpClient.uploadFrom.mockRejectedValueOnce(new Error('522 SSL connection failed: session reuse required'));
    execFile.mockImplementationOnce((_bin, _args, _opts, cb) => cb(null, '', ''));

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(execFile).toHaveBeenCalled();
    expect(findPayload('project_file')).not.toBeNull();
  });

  test('throws BAMBU_FTPS_SESSION_REUSE when fallback fails', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    mockFtpClient.uploadFrom.mockRejectedValueOnce(new Error('Server sent FIN packet unexpectedly, closing connection.'));
    execFile.mockImplementationOnce((_bin, _args, _opts, cb) => cb(new Error('curl exited 1'), '', 'curl: (56) TLS alert'));

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 })
    ).rejects.toMatchObject({ code: 'BAMBU_FTPS_SESSION_REUSE' });
  });

  test('encodes fallback FTPS URL when filename has spaces', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    mockFtpClient.uploadFrom.mockRejectedValueOnce(new Error('Premature close'));
    execFile.mockImplementationOnce((_bin, _args, _opts, cb) => cb(null, '', ''));

    await bambu.uploadAndPrint(
      printer,
      '/tmp/with spaces/1234 part.3mf',
      '1234 part.3mf',
      { amsSlot: 0 }
    );

    const args = execFile.mock.calls[0][1];
    expect(args).toContain(`ftps://${printer.ip}:990/1234%20part.3mf`);
  });

  test('uses detected Metadata plate gcode entry from 3mf', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-bambu-'));
    const threeMfPath = path.join(tmpDir, 'detected-plate.3mf');
    fs.writeFileSync(threeMfPath, buildZipWithEntries(
      [
        'Metadata/plate_2.gcode',
        'Metadata/plate_2.gcode.md5',
        'Metadata/plate_2.json',
      ],
      {
        'Metadata/plate_2.json': JSON.stringify({ bed_type: 'textured_plate' }),
      }
    ));

    try {
      await bambu.uploadAndPrint(printer, threeMfPath, 'detected-plate.3mf', { amsSlot: 0 });
      expect(findPayload('project_file').param).toBe('Metadata/plate_2.gcode');
      expect(findPayload('project_file').bed_type).toBe('textured_plate');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('multi-filament 3mf: ams_mapping aligns trays to real filament indices', async () => {
    const printer = nextPrinter();
    // Live AMS: tray 0 pink, tray 2 Black, tray 3 White. Tray ids include 0 so the
    // zero-based normalization in getAmsSlots keeps slots 2 and 3 (mirrors the X2D).
    pushStatus(printer, {
      ams: { ams: [{ id: '0', tray: [
        { id: '0', tray_type: 'PLA', tray_color: 'F5547CFF' },
        { id: '1' },
        { id: '2', tray_type: 'PLA', tray_color: '000000FF' },
        { id: '3', tray_type: 'PLA', tray_color: 'FFFFFFFF' },
      ] }] },
      vt_tray: {},
    });
    mockPublish.mockClear();

    // This plate uses filaments 5 (Black) and 6 (White) of a 6-filament project.
    const sliceInfo = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config><plate>',
      '<metadata key="index" value="1"/>',
      '<metadata key="filament_maps" value="1 1 1 1 1 1"/>',
      '<filament id="5" tray_info_idx="GFA00" type="PLA" color="#000000" used_g="1.67"/>',
      '<filament id="6" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_g="2.44"/>',
      '</plate></config>',
    ].join('\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-bambu-ams-'));
    const threeMfPath = path.join(tmpDir, 'penguin.3mf');
    fs.writeFileSync(threeMfPath, buildZipWithEntries(
      ['Metadata/plate_1.gcode', 'Metadata/slice_info.config'],
      { 'Metadata/slice_info.config': sliceInfo }
    ));

    try {
      await bambu.uploadAndPrint(printer, threeMfPath, 'penguin.3mf', { amsSlot: 2, amsSlots: [2, 3] });
      const p = findPayload('project_file');
      expect(p.use_ams).toBe(true);
      // Black is filament 5 -> index 4 -> tray 2; White is filament 6 -> index 5 -> tray 3.
      expect(p.ams_mapping).toEqual([-1, -1, -1, -1, 2, 3]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── uploadAndPrint — non-.3mf rejection ─────────────────────────────────────
// Bambu printers only accept .3mf files (project_file command). Plain .gcode
// and .bgcode uploads are rejected before any FTP/MQTT activity.

describe('uploadAndPrint — non-.3mf rejection', () => {
  test('throws for .gcode with descriptive message', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow(/requires a \.3mf file/);
  });

  test('throws for .bgcode with descriptive message', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.bgcode', 'part.bgcode')
    ).rejects.toThrow(/requires a \.3mf file/);
  });

  test('does not attempt FTP upload when file is rejected', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow();

    expect(mockFtpClient.uploadFrom).not.toHaveBeenCalled();
  });

  test('does not publish MQTT when file is rejected', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow();

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
