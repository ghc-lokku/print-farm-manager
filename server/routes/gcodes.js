const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { openThreeMf } = require('../parse-3mf');
const router = express.Router();

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const storage = multer.diskStorage({
  destination: GCODE_DIR,
  filename: (_req, file, cb) => cb(null, Date.now() + '_' + file.originalname),
});
const upload = multer({ storage });

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Model token in filename → internal ID
const MODEL_TOKEN_MAP = {
  mk4s: 'mk4s',
  mk4:  'mk4',
  c1l:  'c1l',
  c1:   'c1',
  core1l: 'c1l',
  coreone: 'c1',
  core1:   'c1',
  xl:   'xl',
};

function parseFilename(filename) {
  // Allow an optional trailing token (e.g. _37grams, _45g) after the time field before the extension.
  const regex = /^(\d+)x\s+(.+?)_(\d+\.\d+n)_(\d+\.\d+mm)_([A-Za-z]+)_([A-Za-z0-9]+)_(\d+h\d+m)(?:_[^.]+)?\.(bgcode|gcode)$/i;
  const match = filename.match(regex);
  if (!match) return null;

  const parts_per_plate = parseInt(match[1], 10);
  const model_token = match[6].toLowerCase();
  const printer_model = MODEL_TOKEN_MAP[model_token] || null;

  // Parse "5h11m" → seconds
  const timeMatch = match[7].match(/(\d+)h(\d+)m/);
  const est_print_secs = timeMatch
    ? parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60
    : null;

  return { parts_per_plate, printer_model, est_print_secs, part_name_hint: match[2] };
}

// Extract material grams from any filename — flexible pattern matching.
// kg before g to avoid "1.2kg" matching "2" with /g/.
function extractMaterialGramsFromFilename(filename) {
  const kg = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*kg(?:[_\s\-\.\(]|$)/i);
  if (kg) return parseFloat(kg[1]) * 1000;
  const g = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*(?:grams?|g)(?:[_\s\-\.\(]|$)/i);
  if (g) return parseFloat(g[1]);
  return null;
}

// Accepts: bare integer (seconds), HH:MM:SS, H:MM, or component form (2h15m, 1h 30m, etc.)
function normalizePrintTime(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = s.match(/^(\d{1,3}):(\d{2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60;
  let total = 0, found = false;
  m = s.match(/(\d+)\s*h/i); if (m) { total += +m[1] * 3600; found = true; }
  m = s.match(/(\d+)\s*m/i); if (m) { total += +m[1] * 60;   found = true; }
  m = s.match(/(\d+)\s*s/i); if (m) { total += +m[1];        found = true; }
  return found ? total : null;
}

// Accepts: bare number (grams), "45g", "45.5 grams", "1.2kg", "1.2 kilograms"
function normalizeMaterialGrams(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  let m = s.match(/^(\d+(?:\.\d+)?)\s*kg(?:ilograms?)?$/i);
  if (m) return parseFloat(m[1]) * 1000;
  m = s.match(/^(\d+(?:\.\d+)?)\s*g(?:rams?)?$/i);
  if (m) return parseFloat(m[1]);
  return null;
}

function findPlatePreview(mf, plateNo = null) {
  if (!mf) return null;
  const names = mf.names || [];

  const orderedCandidates = [];
  if (plateNo != null) {
    orderedCandidates.push(
      `Metadata/plate_${plateNo}.png`,
      `Metadata/plate_${plateNo}.jpg`,
      `Metadata/plate_${plateNo}.jpeg`,
      `Metadata/plate_${plateNo}.webp`
    );
  }

  orderedCandidates.push(
    'Metadata/thumbnail.png',
    'Metadata/thumbnail.jpg',
    'Metadata/thumbnail.jpeg',
    '3D/Thumbnail.png',
    '3D/thumbnail.png'
  );

  for (const name of orderedCandidates) {
    const exact = names.find((n) => n.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  }

  const generic = names.find((n) => /(?:thumbnail|preview|plate_\d+)\.(?:png|jpe?g|webp)$/i.test(n));
  return generic || null;
}

function contentTypeForName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

// scheduler is optional, only needed at runtime for sweepIdlePrinters after an upload
// makes a part schedulable. Tests pass null so there is no live scheduler dependency.
module.exports = (db, scheduler = null) => {
  const gcodeColumns = (() => {
    try {
      return db.prepare('PRAGMA table_info(gcodes)').all().map((c) => c.name);
    } catch (_) {
      return [];
    }
  })();
  const hasRequiredBrand = gcodeColumns.includes('required_brand');

  // GET /api/gcodes — list, optionally filtered by part_id
  router.get('/', (req, res) => {
    const { part_id } = req.query;
    const gcodes = part_id
      ? db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part_id)
      : db.prepare('SELECT * FROM gcodes ORDER BY created_at DESC').all();
    res.json(gcodes);
  });

  // POST /api/gcodes/parse-filename — parse filename, return fields, don't save anything
  router.post('/parse-filename', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const parsed = parseFilename(filename);
    const material_grams = extractMaterialGramsFromFilename(filename);
    if (!parsed) {
      return res.json({ parse_failed: true, material_grams });
    }
    res.json({ parse_failed: false, ...parsed, material_grams });
  });

  // GET /api/gcodes/:id/preview - return embedded 3MF plate preview image when available.
  router.get('/:id/preview', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const basename = gcode.filepath.split(/[\\/]/).pop();
    const fullPath = path.join(GCODE_DIR, basename);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'G-code file missing' });

    const ext = path.extname(gcode.filename || fullPath).toLowerCase();
    if (ext !== '.3mf') return res.status(404).json({ error: 'Preview is available only for 3MF files' });

    const mf = openThreeMf(fullPath);
    if (!mf || typeof mf.extractBytes !== 'function') {
      return res.status(404).json({ error: 'No preview image found' });
    }

    const previewEntry = findPlatePreview(mf, gcode.plate_no ?? null);
    if (!previewEntry) return res.status(404).json({ error: 'No preview image found' });

    const bytes = mf.extractBytes(previewEntry);
    if (!bytes) return res.status(404).json({ error: 'No preview image found' });

    res.setHeader('Content-Type', contentTypeForName(previewEntry));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(bytes);
  });

  // POST /api/gcodes/upload — upload G-code file and create DB record
  router.post('/upload', async (req, res) => {
    try {
      await runUpload(req, res);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const { part_id, parts_per_plate, printer_model, est_print_secs, ams_slot, material_grams,
          allowed_groups, required_material, required_color, required_brand } = req.body;

    if (!part_id || !parts_per_plate || !printer_model) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'part_id, parts_per_plate, and printer_model are required' });
    }

    if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(printer_model)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Unknown model "${printer_model}". Add it in Settings → Printer Models first.` });
    }

    // Enforce uniqueness on (part_id, printer_model) at app layer
    const existing = db.prepare(
      'SELECT id FROM gcodes WHERE part_id = ? AND printer_model = ?'
    ).get(part_id, printer_model);
    if (existing) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({
        error: `This Part already has a G-code for ${printer_model}. Delete the existing one before uploading a replacement.`,
      });
    }

    // ams_slot: -1 = external spool, 0–N = AMS slot, null = not applicable (non-Bambu)
    const parsedAmsSlot = ams_slot !== undefined && ams_slot !== '' ? parseInt(ams_slot, 10) : null;

    const parsedMaterialGrams = material_grams ? parseFloat(material_grams) : null;
    // allowed_groups: JSON array string e.g. '["MK4S Farm","XL Farm"]', or null = all groups
    const parsedAllowedGroups = allowed_groups && allowed_groups !== '' ? allowed_groups : null;
    const parsedRequiredMaterial = required_material && required_material !== '' ? required_material.trim() : null;
    const parsedRequiredColor = required_color && required_color !== ''
      ? String(required_color).split(/[\n,|]/).map(v => v.trim()).filter(Boolean).join(', ')
      : null;
    const parsedRequiredBrand = required_brand && required_brand !== '' ? String(required_brand).trim() : null;

    const gcode = hasRequiredBrand
      ? db.prepare(`
          INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, ams_slot, allowed_groups, required_material, required_color, required_brand, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          part_id,
          printer_model,
          req.file.originalname,
          req.file.filename,
          parseInt(parts_per_plate, 10),
          est_print_secs ? parseInt(est_print_secs, 10) : null,
          parsedMaterialGrams,
          parsedAmsSlot,
          parsedAllowedGroups,
          parsedRequiredMaterial,
          parsedRequiredColor,
          parsedRequiredBrand,
          Date.now()
        )
      : db.prepare(`
          INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, ams_slot, allowed_groups, required_material, required_color, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          part_id,
          printer_model,
          req.file.originalname,
          req.file.filename,
          parseInt(parts_per_plate, 10),
          est_print_secs ? parseInt(est_print_secs, 10) : null,
          parsedMaterialGrams,
          parsedAmsSlot,
          parsedAllowedGroups,
          parsedRequiredMaterial,
          parsedRequiredColor,
          Date.now()
        );

    // A part only becomes a real dispatch candidate once it has a matching G-code: the
    // scheduler's candidate query joins on gcodes. Sweep now so an idle printer picks up
    // work immediately instead of waiting for a manual dispatch or the next printer status
    // transition. Safe to call unconditionally: sweepIdlePrinters already filters to active
    // projects with open, unmet parts internally.
    if (scheduler) scheduler.sweepIdlePrinters();

    res.status(201).json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(gcode.lastInsertRowid));
  });

  // PUT /api/gcodes/:id — update est_print_secs and/or material_grams
  // Accepts human-readable strings ("2h15m", "45g") or raw numbers; omitting a field leaves it unchanged.
  router.put('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    let estPrintSecs = gcode.est_print_secs;
    if ('print_time' in req.body) {
      if (!req.body.print_time) {
        estPrintSecs = null;
      } else {
        estPrintSecs = normalizePrintTime(req.body.print_time);
        if (estPrintSecs === null) {
          return res.status(400).json({ error: 'Cannot parse print time. Use formats like "2h15m", "90m", or "1:30:00".' });
        }
      }
    }

    let materialGrams = gcode.material_grams;
    if ('material_grams' in req.body) {
      if (!req.body.material_grams) {
        materialGrams = null;
      } else {
        materialGrams = normalizeMaterialGrams(req.body.material_grams);
        if (materialGrams === null) {
          return res.status(400).json({ error: 'Cannot parse material. Use formats like "45g", "45.5g", or "1.2kg".' });
        }
      }
    }

    // allowed_groups / required_material / required_color: present-in-body wins; absent = keep existing
    const allowedGroups      = 'allowed_groups'      in req.body ? (req.body.allowed_groups      || null) : gcode.allowed_groups;
    const requiredMaterial   = 'required_material'   in req.body ? (req.body.required_material   || null) : gcode.required_material;
    const requiredColor      = 'required_color'      in req.body ? (req.body.required_color       || null) : gcode.required_color;
    const requiredBrand      = 'required_brand'      in req.body ? (req.body.required_brand       || null) : gcode.required_brand;

    if (hasRequiredBrand) {
      db.prepare('UPDATE gcodes SET est_print_secs = ?, material_grams = ?, allowed_groups = ?, required_material = ?, required_color = ?, required_brand = ? WHERE id = ?')
        .run(estPrintSecs, materialGrams, allowedGroups, requiredMaterial, requiredColor, requiredBrand, req.params.id);
    } else {
      db.prepare('UPDATE gcodes SET est_print_secs = ?, material_grams = ?, allowed_groups = ?, required_material = ?, required_color = ? WHERE id = ?')
        .run(estPrintSecs, materialGrams, allowedGroups, requiredMaterial, requiredColor, req.params.id);
    }

    res.json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id));
  });

  // DELETE /api/gcodes/:id
  router.delete('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const activeJob = db.prepare(
      "SELECT id FROM jobs WHERE gcode_id = ? AND status IN ('queued', 'uploading', 'printing') LIMIT 1"
    ).get(req.params.id);
    if (activeJob) {
      return res.status(409).json({ error: 'Cannot delete — this G-code has an active job in progress.' });
    }

    // Detach historical jobs so the FK doesn't block deletion
    db.prepare("UPDATE jobs SET gcode_id = NULL WHERE gcode_id = ?").run(req.params.id);

    const gcodeFilename = gcode.filepath.split(/[\\/]/).pop();
    const fullPath = path.join(GCODE_DIR, gcodeFilename);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
    db.prepare('DELETE FROM gcodes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
