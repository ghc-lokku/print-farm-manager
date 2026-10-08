const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  jest.resetModules();

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE filament_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE filament_brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE filament_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL REFERENCES filament_types(id),
      name TEXT NOT NULL,
      brand TEXT,
      hex_color TEXT,
      UNIQUE(type_id, name, brand)
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      required_brand TEXT
    );

    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER,
      required_brand TEXT
    );
  `);

  db.prepare("INSERT INTO filament_types (name) VALUES ('PLA')").run();

  app = express();
  app.use(express.json());
  app.use('/api/filaments', require('../routes/filaments')(db));
});

afterEach(() => {
  try { db.close(); } catch (_) {}
});

describe('Filament brands routes', () => {
  test('GET /api/filaments/brands returns managed brands sorted', async () => {
    db.prepare('INSERT INTO filament_brands (name) VALUES (?)').run('Polymaker');
    db.prepare('INSERT INTO filament_brands (name) VALUES (?)').run('Bambu');

    const res = await request(app).get('/api/filaments/brands');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(['Bambu', 'Polymaker']);
  });

  test('POST /api/filaments/brands creates a brand and blocks duplicates', async () => {
    const created = await request(app)
      .post('/api/filaments/brands')
      .send({ name: 'Overture' });

    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Overture');

    const duplicate = await request(app)
      .post('/api/filaments/brands')
      .send({ name: 'Overture' });

    expect(duplicate.status).toBe(409);
  });

  test('DELETE /api/filaments/brands/:id blocks when brand is in use', async () => {
    const brandId = db.prepare('INSERT INTO filament_brands (name) VALUES (?)').run('Bambu').lastInsertRowid;
    db.prepare('INSERT INTO filament_colors (type_id, name, brand, hex_color) VALUES (?, ?, ?, ?)')
      .run(1, 'Black', 'Bambu', '#000000');
    db.prepare('INSERT INTO projects (name, required_brand) VALUES (?, ?)')
      .run('Project A', 'Bambu');
    db.prepare('INSERT INTO gcodes (part_id, required_brand) VALUES (?, ?)')
      .run(1, 'Bambu');

    const res = await request(app).delete(`/api/filaments/brands/${brandId}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in use/i);
  });

  test('DELETE /api/filaments/brands/:name deletes unused brand by name', async () => {
    db.prepare('INSERT INTO filament_brands (name) VALUES (?)').run('eSun');

    const res = await request(app).delete('/api/filaments/brands/eSun');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const remaining = db.prepare('SELECT * FROM filament_brands WHERE name = ?').get('eSun');
    expect(remaining).toBeUndefined();
  });
});
