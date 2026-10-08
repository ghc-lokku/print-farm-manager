const express = require('express');

module.exports = (db) => {
  const router = express.Router();

  const hasFilamentBrandsTable = (() => {
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'filament_brands'").get();
      return !!row;
    } catch (_) {
      return false;
    }
  })();

  const hasProjectsRequiredBrand = (() => {
    try {
      return db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'required_brand');
    } catch (_) {
      return false;
    }
  })();

  const hasGcodesRequiredBrand = (() => {
    try {
      return db.prepare('PRAGMA table_info(gcodes)').all().some((c) => c.name === 'required_brand');
    } catch (_) {
      return false;
    }
  })();

  // ── Filament Types ────────────────────────────────────────────────────────

  router.get('/types', (_req, res) => {
    res.json(db.prepare('SELECT * FROM filament_types ORDER BY name').all());
  });

  router.put('/types/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM filament_types WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const name = req.body?.name?.trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
      db.prepare('UPDATE filament_types SET name = ? WHERE id = ?').run(name, req.params.id);
      res.json(db.prepare('SELECT * FROM filament_types WHERE id = ?').get(req.params.id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists` });
      throw err;
    }
  });

  router.post('/types', (req, res) => {
    const name = req.body?.name?.trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const result = db.prepare('INSERT INTO filament_types (name) VALUES (?)').run(name);
      res.status(201).json(db.prepare('SELECT * FROM filament_types WHERE id = ?').get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists` });
      throw err;
    }
  });

  // Blocked if any colors belong to this type
  router.delete('/types/:id', (req, res) => {
    const colorCount = db.prepare('SELECT COUNT(*) as count FROM filament_colors WHERE type_id = ?').get(req.params.id);
    if (colorCount.count > 0) {
      return res.status(409).json({ error: `Cannot delete — ${colorCount.count} color(s) belong to this type. Delete them first.` });
    }
    const result = db.prepare('DELETE FROM filament_types WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ── Filament Colors ───────────────────────────────────────────────────────

  // Returns colors with their type name included
  router.get('/colors', (_req, res) => {
    res.json(db.prepare(`
      SELECT fc.*, ft.name AS type_name
      FROM filament_colors fc
      JOIN filament_types ft ON ft.id = fc.type_id
      ORDER BY ft.name, fc.name
    `).all());
  });

  router.get('/brands', (_req, res) => {
    if (hasFilamentBrandsTable) {
      const rows = db.prepare('SELECT name FROM filament_brands ORDER BY name COLLATE NOCASE').all();
      return res.json(rows.map((r) => r.name));
    }

    let rows = [];
    try {
      rows = db.prepare(`
        SELECT DISTINCT brand
        FROM filament_colors
        WHERE brand IS NOT NULL AND TRIM(brand) != ''
        ORDER BY brand COLLATE NOCASE
      `).all();
    } catch (_) {
      rows = [];
    }
    res.json(rows.map((r) => r.brand));
  });

  router.post('/brands', (req, res) => {
    if (!hasFilamentBrandsTable) {
      return res.status(500).json({ error: 'Filament brands are not available in this database schema' });
    }

    const name = req.body?.name?.trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
      const result = db.prepare('INSERT INTO filament_brands (name) VALUES (?)').run(name);
      const row = db.prepare('SELECT * FROM filament_brands WHERE id = ?').get(result.lastInsertRowid);
      return res.status(201).json(row);
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists` });
      throw err;
    }
  });

  router.delete('/brands/:id', (req, res) => {
    if (!hasFilamentBrandsTable) {
      return res.status(500).json({ error: 'Filament brands are not available in this database schema' });
    }

    const raw = decodeURIComponent(String(req.params.id || '')).trim();
    const existing = /^\d+$/.test(raw)
      ? db.prepare('SELECT * FROM filament_brands WHERE id = ?').get(raw)
      : db.prepare('SELECT * FROM filament_brands WHERE name = ?').get(raw);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const colorCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM filament_colors
      WHERE brand IS NOT NULL AND TRIM(brand) = ?
    `).get(existing.name).count;

    const projectCount = hasProjectsRequiredBrand
      ? db.prepare(`
          SELECT COUNT(*) AS count
          FROM projects
          WHERE required_brand IS NOT NULL AND TRIM(required_brand) = ?
        `).get(existing.name).count
      : 0;

    const gcodeCount = hasGcodesRequiredBrand
      ? db.prepare(`
          SELECT COUNT(*) AS count
          FROM gcodes
          WHERE required_brand IS NOT NULL AND TRIM(required_brand) = ?
        `).get(existing.name).count
      : 0;

    const totalRefs = colorCount + projectCount + gcodeCount;
    if (totalRefs > 0) {
      return res.status(409).json({
        error: `Cannot delete — brand is in use (${colorCount} color(s), ${projectCount} project default(s), ${gcodeCount} gcode override(s)).`,
      });
    }

    db.prepare('DELETE FROM filament_brands WHERE id = ?').run(existing.id);
    return res.json({ ok: true });
  });

  router.post('/colors', (req, res) => {
    const name    = req.body?.name?.trim();
    const type_id = parseInt(req.body?.type_id, 10);
    if (!name)         return res.status(400).json({ error: 'name is required' });
    if (!type_id)      return res.status(400).json({ error: 'type_id is required' });
    const typeExists = db.prepare('SELECT 1 FROM filament_types WHERE id = ?').get(type_id);
    if (!typeExists)   return res.status(400).json({ error: 'filament type not found' });
    const hex = req.body?.hex_color?.trim() || null;
    const brand = req.body?.brand?.trim() || null;
    if (brand && hasFilamentBrandsTable) {
      db.prepare('INSERT OR IGNORE INTO filament_brands (name) VALUES (?)').run(brand);
    }
    try {
      const result = db.prepare('INSERT INTO filament_colors (type_id, name, brand, hex_color) VALUES (?, ?, ?, ?)').run(type_id, name, brand, hex);
      res.status(201).json(db.prepare(`
        SELECT fc.*, ft.name AS type_name
        FROM filament_colors fc JOIN filament_types ft ON ft.id = fc.type_id
        WHERE fc.id = ?
      `).get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists for this type` });
      throw err;
    }
  });

  router.put('/colors/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM filament_colors WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const name = req.body?.name?.trim();
    const type_id = parseInt(req.body?.type_id, 10);
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!type_id) return res.status(400).json({ error: 'type_id is required' });

    const typeExists = db.prepare('SELECT 1 FROM filament_types WHERE id = ?').get(type_id);
    if (!typeExists) return res.status(400).json({ error: 'filament type not found' });

    const hex = req.body?.hex_color?.trim() || null;
    const brand = req.body?.brand?.trim() || null;
    if (brand && hasFilamentBrandsTable) {
      db.prepare('INSERT OR IGNORE INTO filament_brands (name) VALUES (?)').run(brand);
    }

    try {
      db.prepare('UPDATE filament_colors SET type_id = ?, name = ?, brand = ?, hex_color = ? WHERE id = ?')
        .run(type_id, name, brand, hex, req.params.id);
      res.json(db.prepare(`
        SELECT fc.*, ft.name AS type_name
        FROM filament_colors fc JOIN filament_types ft ON ft.id = fc.type_id
        WHERE fc.id = ?
      `).get(req.params.id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists for this type` });
      throw err;
    }
  });

  router.delete('/colors/:id', (req, res) => {
    const result = db.prepare('DELETE FROM filament_colors WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return router;
};
