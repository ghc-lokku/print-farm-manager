// Tests for POST /api/projects/import-3mf — sliced 3MF project import.
// Verifies project/part/gcode creation, plate metadata extraction, validation,
// and the plate_no column that drives multi-plate Bambu dispatch.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

jest.resetModules();

let db;
let app;
let tmpDir;

// Builds a minimal valid ZIP buffer containing the given entries.
// Reuses the same helper pattern as bambu-driver.test.js.
function buildZip(entryNames, contentByName = {}) {
  const localParts   = [];
  const centralParts = [];
  let localOffset    = 0;

  for (const name of entryNames) {
    const nameBuf = Buffer.from(name, 'utf8');
    const content = Buffer.from(contentByName[name] || '', 'utf8');
    const size    = content.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(1 << 11, 6); // UTF-8
    local.writeUInt16LE(0, 8);       // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(1 << 11, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);

    localParts.push(local, nameBuf, content);
    centralParts.push(central, nameBuf);
    localOffset += local.length + nameBuf.length + size;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryNames.length, 8);
  eocd.writeUInt16LE(entryNames.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="1800"/>
    <metadata key="weight" value="12.5"/>
    <filament id="1" type="PLA" color="#FF0000" used_g="12.5" used_for_object="true"/>
    <metadata key="filament_maps" value="1"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="25.0"/>
    <filament id="1" type="PETG" color="#00FF00" used_g="25.0" used_for_object="true"/>
    <metadata key="filament_maps" value="1"/>
  </plate>
</config>`;

const PLATE1_JSON = JSON.stringify({
  bed_type: 'cool_plate',
  bbox_objects: [{ id: 1 }, { id: 2 }, { id: 3 }],
  filament_colors: ['#FF0000'],
});

const PLATE2_JSON = JSON.stringify({
  bed_type: 'textured_plate',
  bbox_objects: [{ id: 4 }, { id: 5 }],
  filament_colors: ['#00FF00'],
});

function make3mf(includeGcode = [1, 2]) {
  const entries = ['Metadata/slice_info.config', 'Metadata/plate_1.json', 'Metadata/plate_2.json'];
  const content = {
    'Metadata/slice_info.config': SLICE_INFO,
    'Metadata/plate_1.json':      PLATE1_JSON,
    'Metadata/plate_2.json':      PLATE2_JSON,
  };
  for (const n of includeGcode) {
    const key = `Metadata/plate_${n}.gcode`;
    entries.push(key);
    content[key] = `G28 ; plate ${n}`;
  }
  return buildZip(entries, content);
}

// The gcode dir the route writes to — keep test files there, clean up after.
const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const writtenFiles = [];

beforeEach(() => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-import-3mf-'));

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, description TEXT,
      family_name TEXT, size_label TEXT, size_rank INTEGER,
      status TEXT DEFAULT 'draft',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      required_material TEXT, required_color TEXT, allowed_groups TEXT
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      print_time_seconds INTEGER, material_grams REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER,
      material_grams REAL, required_material TEXT, required_color TEXT,
      ams_slot INTEGER, allowed_groups TEXT, plate_no INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO printer_models VALUES ('x1c', 'Bambu X1C', 'bambu')").run();
  db.prepare("INSERT INTO printer_models VALUES ('p1s', 'Bambu P1S', 'bambu')").run();
  db.prepare("INSERT INTO printer_models VALUES ('mk4s', 'Prusa MK4S', 'prusa')").run();

  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });

  app = express();
  app.use(express.json());
  // Mount with a null scheduler — import route does not need sweep
  app.use('/api/projects', require('../routes/projects')(db, null));
});

afterEach(() => {
  for (const f of writtenFiles) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  writtenFiles.length = 0;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// Track files written to GCODE_DIR for cleanup
function trackGcodeDir(beforeFiles) {
  const after = fs.readdirSync(GCODE_DIR);
  for (const f of after) {
    if (!beforeFiles.includes(f)) writtenFiles.push(path.join(GCODE_DIR, f));
  }
}

function seedProject(name = 'Existing Project') {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO projects (name, status, priority, created_at, updated_at)
    VALUES (?, 'active', 0, ?, ?)
  `).run(name, now, now);
  return r.lastInsertRowid;
}

function seedPart(projectId, name, sortOrder = 0, targetQty = 1, completedQty = 0, status = 'open') {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, name, targetQty, completedQty, status, sortOrder, now, now);
  return r.lastInsertRowid;
}

function seedPartGcode(partId, printerModel, filename, filepath, plateNo = null) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                        est_print_secs, material_grams, required_material, required_color,
                        ams_slot, allowed_groups, plate_no, created_at)
    VALUES (?, ?, ?, ?, 1, NULL, NULL, 'PLA', 'FF0000', NULL, NULL, ?, ?)
  `).run(partId, printerModel, filename, filepath, plateNo, now).lastInsertRowid;
}

describe('POST /api/projects/import-3mf', () => {
  test('creates project, two parts, two gcodes with correct plate_no and metadata', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const buf = make3mf([1, 2]);
    const filePath = path.join(tmpDir, 'test.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Owl Parts')
      .field('printer_model', 'x1c');

    trackGcodeDir(before);

    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe('Owl Parts');
    expect(res.body.project.status).toBe('draft');
    expect(res.body.plates).toHaveLength(2);

    const [p1, p2] = res.body.plates;
    expect(p1.plate_index).toBe(1);
    expect(p1.parts_per_plate).toBe(1);     // one imported plate = one print job until the operator scales the target
    expect(p1.est_print_secs).toBe(1800);
    expect(p1.material_grams).toBe(12.5);
    expect(p1.required_material).toBe('PLA');
    expect(p1.required_color).toBe('FF0000');

    expect(p2.plate_index).toBe(2);
    expect(p2.parts_per_plate).toBe(1);     // one imported plate = one print job until the operator scales the target
    expect(p2.est_print_secs).toBe(3600);
    expect(p2.material_grams).toBe(25.0);
    expect(p2.required_material).toBe('PETG');
    expect(p2.required_color).toBe('00FF00');

    // DB state
    const parts = db.prepare('SELECT * FROM parts WHERE project_id = 1 ORDER BY sort_order').all();
    expect(parts).toHaveLength(2);
    expect(parts[0].name).toBe('Plate 1');
    expect(parts[1].name).toBe('Plate 2');

    const gcodes = db.prepare('SELECT * FROM gcodes ORDER BY plate_no').all();
    expect(gcodes).toHaveLength(2);
    expect(gcodes[0].plate_no).toBe(1);
    expect(gcodes[0].printer_model).toBe('x1c');
    expect(gcodes[0].filename).toBe('test.3mf');
    expect(gcodes[1].plate_no).toBe(2);
    // Both gcodes point to the same physical file (the shared 3MF)
    expect(gcodes[0].filepath).toBe(gcodes[1].filepath);
  });

  test('returns 400 when 3MF has no sliced plates (unsliced project file)', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    // No gcode entries — only JSON metadata
    const buf = make3mf([]);
    const filePath = path.join(tmpDir, 'unsliced.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Unsliced')
      .field('printer_model', 'x1c');

    trackGcodeDir(before);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no sliced plates/i);
    // File should have been cleaned up
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n).toBe(0);
  });

  test('returns 400 when project_name is missing', async () => {
    const buf = make3mf([1]);
    const filePath = path.join(tmpDir, 'test_x1c.gcode.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('printer_model', 'x1c');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project_name/i);
  });

  test('allows one explicit size and one filename without a size suffix in the same batch', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const fileWithSize = path.join(tmpDir, 'chunky_jessie_100_x1c.gcode.3mf');
    const fileWithoutSize = path.join(tmpDir, 'chunky_jessie_x1c.gcode.3mf');
    fs.writeFileSync(fileWithSize, make3mf([1]));
    fs.writeFileSync(fileWithoutSize, make3mf([1]));

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('files', fileWithSize)
      .attach('files', fileWithoutSize)
      .field('project_name', 'Chunky Jessie');

    trackGcodeDir(before);

    expect(res.status).toBe(201);
    expect(res.body.project.size_rank).toBe(100);
    expect(res.body.project.family_name).toBe('Chunky Jessie');
  });

  test('returns 400 when printer_model is unknown', async () => {
    const buf = make3mf([1]);
    const filePath = path.join(tmpDir, 'test_x1c.gcode.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Test')
      .field('printer_model', 'doesnotexist');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown model/i);
  });

  test('returns 400 when printer_model is not a Bambu connector', async () => {
    const buf = make3mf([1]);
    const filePath = path.join(tmpDir, 'test_x1c.gcode.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Test')
      .field('printer_model', 'mk4s'); // prusa connector

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bambu/i);
  });

  test('single-plate 3MF creates exactly one part and one gcode', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const buf = make3mf([1]);
    const filePath = path.join(tmpDir, 'single_x1c.gcode.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Single Plate')
      .field('printer_model', 'x1c');

    trackGcodeDir(before);
    expect(res.status).toBe(201);
    expect(res.body.plates).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM gcodes').get().n).toBe(1);
    expect(db.prepare('SELECT plate_no FROM gcodes').get().plate_no).toBe(1);
  });

  test('auto-detects printer_model from filename suffix when field is omitted', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const buf = make3mf([1]);
    const filePath = path.join(tmpDir, 'widget_x1c.gcode.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Auto Detect');

    trackGcodeDir(before);
    expect(res.status).toBe(201);
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = 1').get();
    expect(gcode.printer_model).toBe('x1c');
  });

  test('infers project size from filename suffix pattern _<size>_<model>.gcode.3mf', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const buf = make3mf([1]);
    const filePath = path.join(tmpDir, 'chunky_jessie_80_x1c.gcode.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Chunky Jessie');

    trackGcodeDir(before);
    expect(res.status).toBe(201);
    expect(res.body.project.family_name).toBe('Chunky Jessie');
    expect(res.body.project.size_label).toBe('80%');
    expect(res.body.project.size_rank).toBe(80);
  });

  test('creates one project with multi-model gcodes per plate when printer_models is provided', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const buf = make3mf([1, 2]);
    const filePath = path.join(tmpDir, 'widget.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Multi Model')
      .field('printer_models', JSON.stringify(['x1c', 'p1s']));

    trackGcodeDir(before);

    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe('Multi Model');
    expect(res.body.plates).toHaveLength(2);

    const parts = db.prepare('SELECT * FROM parts WHERE project_id = ?').all(res.body.project.id);
    expect(parts).toHaveLength(2);

    const gcodes = db.prepare('SELECT * FROM gcodes WHERE part_id IN (?, ?) ORDER BY part_id, printer_model')
      .all(parts[0].id, parts[1].id);
    expect(gcodes).toHaveLength(4);
    const modelSet = new Set(gcodes.map(g => g.printer_model));
    expect(modelSet).toEqual(new Set(['x1c', 'p1s']));
  });

  test('imports multiple 3MF files into one project grouped by plate index', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const file1 = path.join(tmpDir, 'widget_x1c.gcode.3mf');
    const file2 = path.join(tmpDir, 'widget_p1s.gcode.3mf');
    fs.writeFileSync(file1, make3mf([1, 2]));
    fs.writeFileSync(file2, make3mf([1, 2]));

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('files', file1)
      .attach('files', file2)
      .field('project_name', 'Two Files One Project')
      .field('file_printer_models', JSON.stringify(['x1c', 'p1s']));

    trackGcodeDir(before);

    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe('Two Files One Project');
    expect(res.body.plates).toHaveLength(2);
    expect(res.body.plates[0].source_files).toEqual(['widget_x1c.gcode.3mf', 'widget_p1s.gcode.3mf']);
    expect(res.body.plates[1].source_files).toEqual(['widget_x1c.gcode.3mf', 'widget_p1s.gcode.3mf']);
    expect(res.body.plates[0].gcodes).toHaveLength(2);
    expect(res.body.plates[1].gcodes).toHaveLength(2);

    const projects = db.prepare('SELECT * FROM projects').all();
    expect(projects).toHaveLength(1);

    const parts = db.prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY id').all(projects[0].id);
    expect(parts).toHaveLength(2);
    expect(parts[0].name).toBe('Plate 1');
    expect(parts[1].name).toBe('Plate 2');

    const gcodes = db.prepare('SELECT * FROM gcodes ORDER BY part_id, printer_model').all();
    expect(gcodes).toHaveLength(4);
    expect(gcodes.filter(g => g.part_id === parts[0].id)).toHaveLength(2);
    expect(gcodes.filter(g => g.part_id === parts[1].id)).toHaveLength(2);
    const models = new Set(gcodes.map(g => g.printer_model));
    expect(models).toEqual(new Set(['x1c', 'p1s']));
    expect(new Set(gcodes.map(g => g.filename))).toEqual(new Set(['widget_x1c.gcode.3mf', 'widget_p1s.gcode.3mf']));
  });

  test('returns 400 when file_printer_models length does not match uploaded files length', async () => {
    const file1 = path.join(tmpDir, 'a_x1c.gcode.3mf');
    const file2 = path.join(tmpDir, 'b_p1s.gcode.3mf');
    fs.writeFileSync(file1, make3mf([1]));
    fs.writeFileSync(file2, make3mf([2]));

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('files', file1)
      .attach('files', file2)
      .field('project_name', 'Bad Mapping')
      .field('file_printer_models', JSON.stringify(['x1c']));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file_printer_models/i);
  });

  test('returns 400 for ambiguous multi-file assignment when global printer_models has multiple models', async () => {
    const file1 = path.join(tmpDir, 'a_x1c.gcode.3mf');
    const file2 = path.join(tmpDir, 'b_p1s.gcode.3mf');
    fs.writeFileSync(file1, make3mf([1]));
    fs.writeFileSync(file2, make3mf([1]));

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('files', file1)
      .attach('files', file2)
      .field('project_name', 'Ambiguous')
      .field('printer_models', JSON.stringify(['x1c', 'p1s']));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ambiguous model assignment/i);
  });

  test('returns 400 when printer_model is omitted and filename has no model suffix', async () => {
    const buf = make3mf([1]);
    const filePath = path.join(tmpDir, 'single.3mf');
    fs.writeFileSync(filePath, buf);

    const res = await request(app)
      .post('/api/projects/import-3mf')
      .attach('file', filePath)
      .field('project_name', 'Missing Model');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/printer_model is required/i);
  });
});

describe('POST /api/projects/:id/reimport-3mf', () => {
  test('updates matching plates in place and adds new split plates', async () => {
    const before = fs.existsSync(GCODE_DIR) ? fs.readdirSync(GCODE_DIR) : [];
    const projectId = seedProject('Chunky Jessie');
    const p1 = seedPart(projectId, 'Plate 1', 0);
    const p2 = seedPart(projectId, 'Plate 2', 1);
    seedPartGcode(p1, 'x1c', 'old_x1c.3mf', 'old_x1c.3mf', 1);
    seedPartGcode(p2, 'x1c', 'old_x1c.3mf', 'old_x1c.3mf', 2);

    const filePath = path.join(tmpDir, 'jessie_x1c.gcode.3mf');
    fs.writeFileSync(filePath, make3mf([1, 2]));

    const res = await request(app)
      .post(`/api/projects/${projectId}/reimport-3mf`)
      .attach('file', filePath)
      .field('printer_model', 'x1c')
      .field('obsolete_action', 'keep');

    trackGcodeDir(before);

    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(projectId);
    expect(res.body.summary.updated_parts).toBe(2);
    expect(res.body.summary.created_parts).toBe(0);

    const gcodes = db.prepare('SELECT part_id, printer_model, filename, plate_no FROM gcodes ORDER BY part_id, id').all();
    expect(gcodes).toHaveLength(2);
    expect(gcodes[0].filename).toBe('jessie_x1c.gcode.3mf');
    expect(gcodes[1].filename).toBe('jessie_x1c.gcode.3mf');
  });

  test('archives unmatched existing parts when obsolete_action=archive', async () => {
    const projectId = seedProject('Archive Me');
    const p1 = seedPart(projectId, 'Plate 1', 0, 1, 0, 'open');
    const p9 = seedPart(projectId, 'Plate 9', 1, 1, 0, 'open');
    seedPartGcode(p1, 'x1c', 'old.3mf', 'old.3mf', 1);
    seedPartGcode(p9, 'x1c', 'old.3mf', 'old.3mf', 9);

    const filePath = path.join(tmpDir, 'archive_x1c.gcode.3mf');
    fs.writeFileSync(filePath, make3mf([1]));

    const res = await request(app)
      .post(`/api/projects/${projectId}/reimport-3mf`)
      .attach('file', filePath)
      .field('printer_model', 'x1c')
      .field('obsolete_action', 'archive');

    expect(res.status).toBe(200);
    const archived = db.prepare('SELECT * FROM parts WHERE id = ?').get(p9);
    expect(archived.status).toBe('closed');
    expect(archived.target_qty).toBe(0);
    expect(res.body.summary.obsolete_action).toBe('archive');
  });

  test('returns 409 when reimport filename size does not match project size', async () => {
    const projectId = seedProject('Chunky Jessie - 80 Percent');
    const p1 = seedPart(projectId, 'Plate 1', 0, 1, 0, 'open');
    seedPartGcode(p1, 'x1c', 'old_80_x1c.3mf', 'old_80_x1c.3mf', 1);

    const filePath = path.join(tmpDir, 'chunky_jessie_100_x1c.gcode.3mf');
    fs.writeFileSync(filePath, make3mf([1]));

    const res = await request(app)
      .post(`/api/projects/${projectId}/reimport-3mf`)
      .attach('file', filePath)
      .field('printer_model', 'x1c')
      .field('obsolete_action', 'keep');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not match project size/i);
  });

  test('reimport returns 400 for ambiguous multi-file assignment when global printer_models has multiple models', async () => {
    const projectId = seedProject('Ambiguous Reimport');
    const p1 = seedPart(projectId, 'Plate 1', 0);
    seedPartGcode(p1, 'x1c', 'old_x1c.3mf', 'old_x1c.3mf', 1);

    const file1 = path.join(tmpDir, 'r1_x1c.gcode.3mf');
    const file2 = path.join(tmpDir, 'r1_p1s.gcode.3mf');
    fs.writeFileSync(file1, make3mf([1]));
    fs.writeFileSync(file2, make3mf([1]));

    const res = await request(app)
      .post(`/api/projects/${projectId}/reimport-3mf`)
      .attach('files', file1)
      .attach('files', file2)
      .field('obsolete_action', 'keep')
      .field('printer_models', JSON.stringify(['x1c', 'p1s']));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ambiguous model assignment/i);
  });
});
