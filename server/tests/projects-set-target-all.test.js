const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
let scheduler;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER,
      gcode_id INTEGER,
      parts_per_plate INTEGER,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER
    );
  `);
});

beforeEach(() => {
  db.exec(`
    DELETE FROM jobs;
    DELETE FROM gcodes;
    DELETE FROM parts;
    DELETE FROM projects;
  `);

  scheduler = { sweepIdlePrinters: jest.fn() };
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db, scheduler));
});

function seedProject(status = 'active') {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO projects (name, status, created_at, updated_at)
    VALUES ('Bulk Target Project', ?, ?, ?)
  `).run(status, now, now).lastInsertRowid;
}

function seedPart(projectId, name, targetQty, completedQty, status, sortOrder) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, name, targetQty, completedQty, status, sortOrder, now, now).lastInsertRowid;
}

describe('POST /api/projects/:id/set-target-all', () => {
  test('returns 404 for unknown project', async () => {
    const res = await request(app)
      .post('/api/projects/99999/set-target-all')
      .send({ target_qty: 25 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  test('returns 400 when target_qty is invalid', async () => {
    const projectId = seedProject('active');
    seedPart(projectId, 'Plate 1', 10, 2, 'open', 0);

    const res = await request(app)
      .post(`/api/projects/${projectId}/set-target-all`)
      .send({ target_qty: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target_qty must be an integer/i);
  });

  test('returns 400 when project has no parts', async () => {
    const projectId = seedProject('active');

    const res = await request(app)
      .post(`/api/projects/${projectId}/set-target-all`)
      .send({ target_qty: 25 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no parts/i);
  });

  test('sets target_qty for every part', async () => {
    const projectId = seedProject('active');
    const p1 = seedPart(projectId, 'Plate 1', 10, 2, 'open', 0);
    const p2 = seedPart(projectId, 'Plate 2', 5, 0, 'open', 1);

    const res = await request(app)
      .post(`/api/projects/${projectId}/set-target-all`)
      .send({ target_qty: 25 });

    expect(res.status).toBe(200);
    expect(res.body.updated_parts).toBe(2);
    expect(res.body.target_qty).toBe(25);

    const part1 = db.prepare('SELECT * FROM parts WHERE id = ?').get(p1);
    const part2 = db.prepare('SELECT * FROM parts WHERE id = ?').get(p2);
    expect(part1.target_qty).toBe(25);
    expect(part2.target_qty).toBe(25);
  });

  test('reopens closed parts below new target and closes open parts at or above target', async () => {
    const projectId = seedProject('active');
    const reopenedId = seedPart(projectId, 'Plate 1', 10, 10, 'closed', 0);
    const closedId = seedPart(projectId, 'Plate 2', 50, 30, 'open', 1);

    const res = await request(app)
      .post(`/api/projects/${projectId}/set-target-all`)
      .send({ target_qty: 30 });

    expect(res.status).toBe(200);
    expect(res.body.reopened_parts).toBe(1);
    expect(res.body.closed_parts).toBe(1);

    const reopened = db.prepare('SELECT * FROM parts WHERE id = ?').get(reopenedId);
    const closed = db.prepare('SELECT * FROM parts WHERE id = ?').get(closedId);
    expect(reopened.status).toBe('open');
    expect(closed.status).toBe('closed');
  });

  test('reactivates completed project when remaining work exists', async () => {
    const projectId = seedProject('completed');
    seedPart(projectId, 'Plate 1', 10, 10, 'closed', 0);

    const res = await request(app)
      .post(`/api/projects/${projectId}/set-target-all`)
      .send({ target_qty: 25 });

    expect(res.status).toBe(200);
    expect(res.body.reactivated_project).toBe(true);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });

  test('calls scheduler sweep when remaining work exists', async () => {
    const projectId = seedProject('active');
    seedPart(projectId, 'Plate 1', 10, 10, 'closed', 0);

    const res = await request(app)
      .post(`/api/projects/${projectId}/set-target-all`)
      .send({ target_qty: 25 });

    expect(res.status).toBe(200);
    expect(scheduler.sweepIdlePrinters).toHaveBeenCalledTimes(1);
  });

  test('does not sweep when no remaining work exists after update', async () => {
    const projectId = seedProject('active');
    seedPart(projectId, 'Plate 1', 10, 200, 'closed', 0);

    const res = await request(app)
      .post(`/api/projects/${projectId}/set-target-all`)
      .send({ target_qty: 150 });

    expect(res.status).toBe(200);
    expect(scheduler.sweepIdlePrinters).not.toHaveBeenCalled();
  });
});
