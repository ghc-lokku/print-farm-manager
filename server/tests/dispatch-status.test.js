// Tests for GET /api/parts/:id/dispatch-status: the operator-facing diagnostic
// that mirrors the scheduler's own eligibility rules (see the CLAUDE.md sync-pairs
// table: scheduler.js candidate SQL must stay in sync with this route). Covers the
// project-level allowed_groups cascade added alongside required_material/color.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
let mockGetAmsSlots;

beforeEach(() => {
  mockGetAmsSlots = jest.fn(() => null);
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT DEFAULT 'prusa',
      model TEXT NOT NULL, group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      required_material TEXT, required_color TEXT, allowed_groups TEXT
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL,
      allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, status TEXT DEFAULT 'queued', parts_per_plate INTEGER NOT NULL
    );
    CREATE TABLE filament_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE filament_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      hex_color TEXT,
      UNIQUE(type_id, name)
    );
  `);

  // routes/parts.js declares its Express router at module scope, like every route
  // file in this codebase. Node's require() cache means a second require() in the
  // same process would reuse that router with a stale db closure from a previous
  // test's beforeEach. jest.resetModules() forces a fresh module (and router)
  // each time. See the identical note in backup-restore.test.js.
  jest.resetModules();
  jest.doMock('../drivers/bambu', () => ({ getAmsSlots: mockGetAmsSlots }));
  app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db));
});

const now = Date.now();

function seedProject(overrides = {}) {
  const stmt = db.prepare(`
    INSERT INTO projects (name, status, required_material, required_color, allowed_groups)
    VALUES ('Proj', ?, ?, ?, ?)
  `);
  const r = stmt.run(
    overrides.status ?? 'active',
    overrides.required_material ?? null,
    overrides.required_color ?? null,
    overrides.allowed_groups ?? null,
  );
  return r.lastInsertRowid;
}

function seedPart(projectId, overrides = {}) {
  const r = db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
    VALUES (?, 'Part', ?, ?, ?, ?, ?)
  `).run(projectId, overrides.target_qty ?? 10, overrides.completed_qty ?? 0, overrides.status ?? 'open', now, now);
  return r.lastInsertRowid;
}

function seedGcode(partId, overrides = {}) {
  db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, allowed_groups, required_material, required_color, created_at)
    VALUES (?, ?, 'f.gcode', 'f.gcode', 1, ?, ?, ?, ?)
  `).run(partId, overrides.printer_model ?? 'mk4s', overrides.allowed_groups ?? null,
         overrides.required_material ?? null, overrides.required_color ?? null, now);
}

function seedPrinter(overrides = {}) {
  db.prepare(`
    INSERT INTO printers (type, model, group_name, loaded_material, loaded_color, status, is_held, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.type ?? 'prusa',
    overrides.model ?? 'mk4s', overrides.group_name ?? null,
    overrides.loaded_material ?? null, overrides.loaded_color ?? null,
    overrides.status ?? 'IDLE', overrides.is_held ?? 0, overrides.is_active ?? 1,
  );
}

function seedFilamentColor(typeName, colorName, hexColor) {
  db.prepare('INSERT OR IGNORE INTO filament_types (name) VALUES (?)').run(typeName);
  const typeId = db.prepare('SELECT id FROM filament_types WHERE name = ?').get(typeName).id;
  db.prepare('INSERT INTO filament_colors (type_id, name, hex_color) VALUES (?, ?, ?)')
    .run(typeId, colorName, hexColor);
}

describe('GET /api/parts/:id/dispatch-status', () => {
  test('404 for an unknown part', async () => {
    const res = await request(app).get('/api/parts/999/dispatch-status');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('blocks when the project is not active', async () => {
    const projectId = seedProject({ status: 'paused' });
    const partId = seedPart(projectId);
    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/not Active/i);
  });

  test('blocks when no gcode is uploaded', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/No G-code uploaded/i);
  });

  test('dispatchable when a matching idle printer exists and nothing restricts it', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId);
    seedPrinter();
    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
    expect(res.body.reasons).toEqual([]);
  });

  test('a gcode with no allowed_groups inherits the project-level restriction and reports no match', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId); // no per-gcode allowed_groups, must inherit the project's
    seedPrinter({ group_name: 'Rack B' }); // wrong group

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/no printers in allowed group\(s\) Rack A/i);
  });

  test('a gcode inheriting the project group restriction dispatches once a matching printer exists', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId);
    seedPrinter({ group_name: 'Rack A' });

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
  });

  test('a gcode-level allowed_groups overrides the project default entirely', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId, { allowed_groups: JSON.stringify(['Rack B']) });
    // Printer matches the gcode's own restriction, not the project's.
    seedPrinter({ group_name: 'Rack B' });

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
  });

  test('this is the original bug scenario: a project-referenced group with zero matching printers is reported by name, not silently treated as unrestricted', async () => {
    const projectId = seedProject({ allowed_groups: JSON.stringify(['Rack A']) });
    const partId = seedPart(projectId);
    seedGcode(partId);
    // No printer anywhere carries "Rack A": this used to be indistinguishable
    // from "no restriction" in the UI before the group registry existed.
    seedPrinter({ group_name: 'Rack Z' });

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toContain('Rack A');
  });

  test('dispatchable when Bambu AMS tray color matches required_color via filament library hex', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId, { printer_model: 'x1c', required_color: 'Black' });
    seedPrinter({ type: 'bambu', model: 'x1c', loaded_color: null });
    seedFilamentColor('PLA', 'Black', '#000000');
    mockGetAmsSlots.mockReturnValue([{ slot: 1, type: 'PLA', color: '000000FF' }]);

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
    expect(res.body.reasons).toEqual([]);
  });

  test('does not report blocked alternate model rows when another model row is dispatchable', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId, { printer_model: 'p2s', required_color: 'Yellow', required_material: 'PLA' });
    seedGcode(partId, { printer_model: 'x1c', required_color: 'Yellow', required_material: 'PLA' });

    seedFilamentColor('PLA', 'Yellow', '#FFFF00');
    seedPrinter({ type: 'bambu', model: 'x1c', loaded_material: 'PLA', loaded_color: null });
    mockGetAmsSlots.mockReturnValue([{ slot: 2, type: 'PLA', color: 'FFFF00FF' }]);

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(true);
    expect(res.body.reasons).toEqual([]);
    expect(res.body.notes).toEqual([]);
  });

  test('ignores absent alternate model blockers when a reachable model exists but is currently busy', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId, { printer_model: 'p2s', required_color: 'Yellow', required_material: 'PLA' });
    seedGcode(partId, { printer_model: 'x1c', required_color: 'Yellow', required_material: 'PLA' });

    seedFilamentColor('PLA', 'Yellow', '#FFFF00');
    seedPrinter({ type: 'bambu', model: 'x1c', loaded_material: 'PLA', loaded_color: null, status: 'PRINTING', is_held: 0 });
    mockGetAmsSlots.mockReturnValue([{ slot: 2, type: 'PLA', color: 'FFFF00FF' }]);

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/matching printer\(s\) are busy/i);
    expect(res.body.reasons.join(' ')).not.toMatch(/p2s/i);
  });

  test('reports color mismatch when Bambu has no matching AMS tray color', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);
    seedGcode(partId, { printer_model: 'x1c', required_color: 'Black' });
    seedPrinter({ type: 'bambu', model: 'x1c', loaded_color: null });
    seedFilamentColor('PLA', 'Green', '#00FF00');
    mockGetAmsSlots.mockReturnValue([{ slot: 1, type: 'PLA', color: '00FF00FF' }]);

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/Black available/i);
    expect(res.body.reasons.join(' ')).toMatch(/AMS slot/i);
  });

  test('uses the newest gcode row when duplicate model rows exist', async () => {
    const projectId = seedProject();
    const partId = seedPart(projectId);

    // Legacy duplicate row (older): no color restriction.
    seedGcode(partId, { printer_model: 'mk4s', required_color: null });
    // Current row (newer): requires Black.
    seedGcode(partId, { printer_model: 'mk4s', required_color: 'Black' });

    seedPrinter({ model: 'mk4s', loaded_color: 'White' });

    const res = await request(app).get(`/api/parts/${partId}/dispatch-status`);
    expect(res.status).toBe(200);
    expect(res.body.dispatchable).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/Black/i);
  });
});
