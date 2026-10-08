const express = require('express');

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const tags = db.prepare('SELECT * FROM project_tags ORDER BY name COLLATE NOCASE, id ASC').all();
    res.json(tags);
  });

  router.post('/', (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    try {
      const now = Date.now();
      const result = db.prepare('INSERT INTO project_tags (name, created_at) VALUES (?, ?)').run(name, now);
      const tag = db.prepare('SELECT * FROM project_tags WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(tag);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Tag "${name}" already exists` });
      }
      throw err;
    }
  });

  router.delete('/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid tag id' });

    const tag = db.prepare('SELECT * FROM project_tags WHERE id = ?').get(id);
    if (!tag) return res.status(404).json({ error: 'Tag not found' });

    const usage = db.prepare('SELECT COUNT(*) AS count FROM project_tag_links WHERE tag_id = ?').get(id).count;
    if (usage > 0) {
      return res.status(409).json({ error: `Cannot delete: tag "${tag.name}" is assigned to ${usage} project(s)` });
    }

    db.prepare('DELETE FROM project_tags WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return router;
};
