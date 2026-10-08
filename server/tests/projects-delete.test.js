const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

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
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT DEFAULT 'UNKNOWN',
      is_held INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE project_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE project_tag_links (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES project_tags(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, tag_id)
    );
  `);

  // project_tags/project_tag_links must exist before mount so the route detects them.
  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db, null));
});

beforeEach(() => {
  db.exec(`
    DELETE FROM project_tag_links;
    DELETE FROM project_tags;
    DELETE FROM jobs;
    DELETE FROM gcodes;
    DELETE FROM parts;
    DELETE FROM printers;
    DELETE FROM projects;
  `);
  const now = Date.now();
  db.prepare("INSERT INTO printers (id, name, model, created_at) VALUES (1, 'P1', 'x1c', ?)").run(now);
});

// Seeds a project with one part, one gcode, and one job (in the given job status).
// Filepath is deliberately a name that does not exist on disk so the handler's
// fs.unlink step is skipped.
function seedProject(status, jobStatus = 'queued') {
  const now = Date.now();
  const proj = db.prepare(
    'INSERT INTO projects (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(`Proj ${status}`, status, now, now);
  const projectId = proj.lastInsertRowid;

  const part = db.prepare(
    "INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at) VALUES (?, 'Plate 1', 10, 0, 'open', 0, ?, ?)"
  ).run(projectId, now, now);
  const partId = part.lastInsertRowid;

  const gcode = db.prepare(
    "INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'x1c', 'p.gcode', '__delete_test_nonexistent.gcode', 1, ?)"
  ).run(partId, now);
  const gcodeId = gcode.lastInsertRowid;

  const job = db.prepare(
    'INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at) VALUES (?, 1, ?, 1, ?, ?)'
  ).run(partId, gcodeId, jobStatus, now);

  return { projectId, partId, gcodeId, jobId: job.lastInsertRowid };
}

function countFor(projectId) {
  return {
    projects: db.prepare('SELECT COUNT(*) AS c FROM projects WHERE id = ?').get(projectId).c,
    parts:    db.prepare('SELECT COUNT(*) AS c FROM parts WHERE project_id = ?').get(projectId).c,
  };
}

describe('DELETE /api/projects/:id', () => {
  test('returns 404 for an unknown project', async () => {
    const res = await request(app).delete('/api/projects/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('deletes a draft project and cascades its parts, gcodes, and jobs', async () => {
    const { projectId, partId, gcodeId, jobId } = seedProject('draft');

    const res = await request(app).delete(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    expect(db.prepare('SELECT COUNT(*) AS c FROM projects WHERE id = ?').get(projectId).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM parts WHERE id = ?').get(partId).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM gcodes WHERE id = ?').get(gcodeId).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE id = ?').get(jobId).c).toBe(0);
  });

  test('deletes an active project (no longer draft-only)', async () => {
    const { projectId } = seedProject('active', 'printing');
    const res = await request(app).delete(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    const counts = countFor(projectId);
    expect(counts.projects).toBe(0);
    expect(counts.parts).toBe(0);
  });

  test('deletes a paused project', async () => {
    const { projectId } = seedProject('paused');
    const res = await request(app).delete(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(countFor(projectId).projects).toBe(0);
  });

  test('deletes a completed project', async () => {
    const { projectId } = seedProject('completed');
    const res = await request(app).delete(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(countFor(projectId).projects).toBe(0);
  });

  test('removes the project tag links but keeps the tag itself', async () => {
    const { projectId } = seedProject('active');
    const now = Date.now();
    const tag = db.prepare("INSERT INTO project_tags (name, created_at) VALUES ('rush', ?)").run(now);
    const tagId = tag.lastInsertRowid;
    db.prepare('INSERT INTO project_tag_links (project_id, tag_id, created_at) VALUES (?, ?, ?)').run(projectId, tagId, now);

    const res = await request(app).delete(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS c FROM project_tag_links WHERE project_id = ?').get(projectId).c).toBe(0);
    // The shared tag survives so other projects can still use it.
    expect(db.prepare('SELECT COUNT(*) AS c FROM project_tags WHERE id = ?').get(tagId).c).toBe(1);
  });

  test('leaves other projects untouched', async () => {
    const keep = seedProject('active');
    const drop = seedProject('active');

    const res = await request(app).delete(`/api/projects/${drop.projectId}`);
    expect(res.status).toBe(200);

    expect(countFor(drop.projectId).projects).toBe(0);
    expect(countFor(keep.projectId).projects).toBe(1);
    expect(countFor(keep.projectId).parts).toBe(1);
  });
});
