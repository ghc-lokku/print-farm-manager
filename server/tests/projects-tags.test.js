const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      print_time_seconds INTEGER,
      material_grams REAL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER,
      created_at INTEGER NOT NULL,
      ams_slot INTEGER,
      material_grams REAL,
      allowed_groups TEXT,
      required_material TEXT,
      required_color TEXT,
      plate_no INTEGER
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER,
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  db.prepare('INSERT INTO projects (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run('Tagged Project', 'active', now, now);
  db.prepare('INSERT INTO project_tags (name, created_at) VALUES (?, ?)').run('rush', now);
  db.prepare('INSERT INTO project_tags (name, created_at) VALUES (?, ?)').run('yellow', now);

  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db, null));
  app.use('/api/project-tags', require('../routes/project-tags')(db));
});

describe('Project tags', () => {
  test('lists tags in alphabetical order', async () => {
    const res = await request(app).get('/api/project-tags');
    expect(res.status).toBe(200);
    expect(res.body.map(t => t.name)).toEqual(['rush', 'yellow']);
  });

  test('creates a tag and blocks duplicates', async () => {
    const createRes = await request(app)
      .post('/api/project-tags')
      .send({ name: 'overnight' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('overnight');

    const dupRes = await request(app)
      .post('/api/project-tags')
      .send({ name: 'overnight' });

    expect(dupRes.status).toBe(409);
  });

  test('cannot delete a tag that is linked to a project', async () => {
    const projectId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
    const tagId = db.prepare('SELECT id FROM project_tags WHERE name = ?').get('rush').id;
    db.prepare('INSERT INTO project_tag_links (project_id, tag_id, created_at) VALUES (?, ?, ?)').run(projectId, tagId, Date.now());

    const res = await request(app).delete(`/api/project-tags/${tagId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/assigned/i);
  });

  test('can assign tags to a project and project payload includes tags', async () => {
    const projectId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
    const tags = db.prepare('SELECT id, name FROM project_tags ORDER BY id').all();

    const putRes = await request(app)
      .put(`/api/projects/${projectId}/tags`)
      .send({ tag_ids: tags.map(t => t.id) });

    expect(putRes.status).toBe(200);
    expect(putRes.body.tags).toEqual([
      expect.objectContaining({ name: 'rush' }),
      expect.objectContaining({ name: 'yellow' }),
    ]);

    const listRes = await request(app).get('/api/projects');
    expect(listRes.status).toBe(200);
    expect(listRes.body[0].tags).toHaveLength(2);

    const detailRes = await request(app).get(`/api/projects/${projectId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.tags.map(t => t.name)).toEqual(['rush', 'yellow']);
  });
});
