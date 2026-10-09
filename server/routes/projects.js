const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const { extractPlates } = require('../parse-3mf');
const partLedger = require('../partLedger');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const threeMfStorage = multer.diskStorage({
  destination: GCODE_DIR,
  filename: (_req, file, cb) => cb(null, Date.now() + '_' + file.originalname),
});
const uploadThreeMf = multer({
  storage: threeMfStorage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.3mf')) return cb(null, true);
    cb(new Error('Only .3mf files are accepted'));
  },
});

function runThreeMfUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadThreeMf.fields([
      { name: 'file', maxCount: 1 },
      { name: 'files', maxCount: 50 },
    ])(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function collectUploadedFiles(req) {
  const single = req?.files?.file || [];
  const many = req?.files?.files || [];
  return [...single, ...many];
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function detectPrinterModelFromFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  // Accept both *_model.3mf and *_model.gcode.3mf naming.
  let base = filename.trim();
  base = base.replace(/\.3mf$/i, '');
  base = base.replace(/\.(?:b?gcode)$/i, '');
  const m = /_([a-z0-9-]+)$/i.exec(base);
  return m ? m[1].toLowerCase() : null;
}

function detectSizeRankFromFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  let base = filename.trim();
  base = base.replace(/\.3mf$/i, '');
  base = base.replace(/\.(?:b?gcode)$/i, '');

  // Preferred pattern: *_<size>_<model>.gcode.3mf (example: chunky_jessie_100_x1c.gcode.3mf)
  let m = /_(\d{2,3})_[a-z0-9-]+$/i.exec(base);
  if (!m) {
    // Fallback: *_<size>.gcode.3mf
    m = /_(\d{2,3})$/i.exec(base);
  }
  if (!m) return null;

  const size = parseInt(m[1], 10);
  if (!Number.isFinite(size) || size < 1) return null;
  return size;
}

function parsePrinterModels(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  return trimmed.split(',');
}

function parsePerFilePrinterModels(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parsePlateNumberFromPartName(name) {
  if (!name) return null;
  const m = /^\s*plate\s*(\d+)\b/i.exec(String(name));
  return m ? parseInt(m[1], 10) : null;
}

function parseObsoleteAction(raw) {
  const value = String(raw || 'keep').trim().toLowerCase();
  if (value === 'keep' || value === 'archive' || value === 'remove') return value;
  return null;
}

function parseProjectVariantFromName(name, fallbackSizeRank = null) {
  const raw = String(name || '').trim();
  const m = raw.match(/^(.*?)(?:\s*-\s*|\s*\()(?:(\d{2,3})\s*(?:%|percent))(?:\))?\s*$/i);
  if (m) {
    const familyName = (m[1] || '').trim();
    const sizeNum = parseInt(m[2], 10);
    if (familyName && Number.isFinite(sizeNum)) {
      return { family_name: familyName, size_label: `${sizeNum}%`, size_rank: sizeNum };
    }
  }
  if (Number.isFinite(fallbackSizeRank) && fallbackSizeRank > 0) {
    return { family_name: raw, size_label: `${fallbackSizeRank}%`, size_rank: fallbackSizeRank };
  }
  return { family_name: raw, size_label: '100%', size_rank: 100 };
}

function parseTagIds(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const id = Number.parseInt(raw, 10);
    if (!Number.isInteger(id) || id < 1) return null;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// scheduler is optional — only needed at runtime for sweepIdlePrinters on reactivate.
// Tests pass null so there is no live scheduler dependency.
module.exports = (db, scheduler = null) => {
  const projectColumnNames = (() => {
    try {
      return db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
    } catch (_) {
      return [];
    }
  })();
  const hasProjectSizeColumns = projectColumnNames.includes('family_name')
    && projectColumnNames.includes('size_label')
    && projectColumnNames.includes('size_rank');
  const hasProjectRequiredBrand = projectColumnNames.includes('required_brand');

  const hasProjectTagTables = (() => {
    try {
      const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project_tags','project_tag_links')").all();
      const names = new Set(tableRows.map(r => r.name));
      return names.has('project_tags') && names.has('project_tag_links');
    } catch (_) {
      return false;
    }
  })();

  function addTagsToProjects(projectRows) {
    const rows = Array.isArray(projectRows) ? projectRows : [];
    if (!hasProjectTagTables || rows.length === 0) {
      return rows.map((p) => ({ ...p, tags: [] }));
    }

    const ids = rows.map((p) => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const links = db.prepare(`
      SELECT l.project_id, t.id, t.name
      FROM project_tag_links l
      JOIN project_tags t ON t.id = l.tag_id
      WHERE l.project_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE, t.id ASC
    `).all(...ids);

    const tagsByProject = new Map();
    for (const link of links) {
      if (!tagsByProject.has(link.project_id)) tagsByProject.set(link.project_id, []);
      tagsByProject.get(link.project_id).push({ id: link.id, name: link.name });
    }

    return rows.map((p) => ({ ...p, tags: tagsByProject.get(p.id) || [] }));
  }

  router.get('/', (req, res) => {
    const projects = db.prepare('SELECT * FROM projects ORDER BY priority ASC, created_at ASC').all();
    res.json(addTagsToProjects(projects));
  });

  router.get('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(addTagsToProjects([project])[0]);
  });

  router.put('/:id/tags', (req, res) => {
    if (!hasProjectTagTables) return res.status(500).json({ error: 'Project tags are not available in this database schema' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tagIds = parseTagIds(req.body?.tag_ids);
    if (tagIds == null) {
      return res.status(400).json({ error: 'tag_ids must be an array of positive integers' });
    }

    if (tagIds.length > 0) {
      const placeholders = tagIds.map(() => '?').join(',');
      const existing = db.prepare(`SELECT id FROM project_tags WHERE id IN (${placeholders})`).all(...tagIds);
      if (existing.length !== tagIds.length) {
        return res.status(400).json({ error: 'One or more tag_ids do not exist' });
      }
    }

    const now = Date.now();
    db.transaction(() => {
      db.prepare('DELETE FROM project_tag_links WHERE project_id = ?').run(project.id);
      const insert = db.prepare('INSERT INTO project_tag_links (project_id, tag_id, created_at) VALUES (?, ?, ?)');
      for (const tagId of tagIds) insert.run(project.id, tagId, now);
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project.id);
    })();

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    res.json(addTagsToProjects([updated])[0]);
  });

  router.post('/', (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const now = Date.now();
    const variant = parseProjectVariantFromName(name);
    const result = hasProjectSizeColumns
      ? db.prepare(`
          INSERT INTO projects (name, description, family_name, size_label, size_rank, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          name,
          description || null,
          variant.family_name,
          variant.size_label,
          variant.size_rank,
          now,
          now
        )
      : db.prepare(`
          INSERT INTO projects (name, description, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(name, description || null, now, now);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(project);
  });

  // POST /import-3mf — upload one or more pre-sliced Bambu/OrcaSlicer .3mf files
  // and auto-create one project with one part per plate.
  // Body (multipart/form-data): file or files[], project_name, optional
  // printer_model, optional printer_models (global list for each file), optional
  // file_printer_models (JSON array, one model id per uploaded file index).
  // Every resolved model must exist in printer_models with connector = 'bambu'.
  // Returns { project, plates: [{ plate_index, part_id, gcode_id, ... }] }.
  router.post('/import-3mf', async (req, res) => {
    try {
      await runThreeMfUpload(req, res);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const uploadedFiles = collectUploadedFiles(req);
    if (uploadedFiles.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    const inferredSizes = [...new Set(
      uploadedFiles.map(f => detectSizeRankFromFilename(f.originalname)).filter(v => v != null)
    )];
    if (inferredSizes.length > 1) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({
        error: 'Uploaded filenames contain mixed size suffixes. Import one size per project (for example all *_100_* or all *_80_*).',
      });
    }
    const inferredSizeRank = inferredSizes.length === 1 ? inferredSizes[0] : null;

    const { project_name, printer_model, printer_models, file_printer_models } = req.body;
    if (!project_name || !project_name.trim()) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({ error: 'project_name is required' });
    }

    const globalModels = parsePrinterModels(printer_models)
      .map(m => String(m || '').trim().toLowerCase())
      .filter(Boolean);
    if (globalModels.length === 0 && printer_model && String(printer_model).trim()) {
      globalModels.push(String(printer_model).trim().toLowerCase());
    }

    const perFileModels = parsePerFilePrinterModels(file_printer_models)
      .map(m => String(m || '').trim().toLowerCase());

    if (uploadedFiles.length > 1 && perFileModels.length === 0 && globalModels.length > 1) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({
        error: 'Ambiguous model assignment: when uploading multiple files with multiple models, use file_printer_models (one model per file) or filename suffix detection.',
      });
    }

    if (perFileModels.length > 0 && perFileModels.length !== uploadedFiles.length) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({
        error: 'file_printer_models must contain one entry per uploaded file (use empty string to fall back to suffix detection).',
      });
    }

    const allResolvedModels = new Set();
    const filePlan = [];
    for (let idx = 0; idx < uploadedFiles.length; idx += 1) {
      const file = uploadedFiles[idx];
      const perFileModel = perFileModels[idx] || '';
      const inferredModel = detectPrinterModelFromFilename(file.originalname);

      const resolvedModels = [...new Set(
        perFileModel
          ? [perFileModel]
          : (globalModels.length > 0 ? globalModels : (inferredModel ? [inferredModel] : []))
      )];

      if (resolvedModels.length === 0) {
        for (const f of uploadedFiles) safeUnlink(f.path);
        const missingModelError = (!printer_model && !printer_models && !file_printer_models)
          ? 'printer_model is required'
          : `No model resolved for file "${file.originalname}". Provide file_printer_models, printer_model/printer_models, or a filename suffix like *_x1c.gcode.3mf`;
        return res.status(400).json({ error: missingModelError });
      }

      filePlan.push({ file, resolvedModels });
      for (const modelId of resolvedModels) allResolvedModels.add(modelId);
    }

    const modelCache = new Map();
    for (const modelId of allResolvedModels) {
      const row = db.prepare('SELECT * FROM printer_models WHERE model_id = ?').get(modelId);
      if (!row) {
        for (const file of uploadedFiles) safeUnlink(file.path);
        return res.status(400).json({ error: `Unknown model "${modelId}". Add it in Settings first.` });
      }
      if (row.connector !== 'bambu') {
        for (const file of uploadedFiles) safeUnlink(file.path);
        return res.status(400).json({ error: `3MF import requires Bambu models. "${modelId}" uses connector "${row.connector}".` });
      }
      modelCache.set(modelId, row);
    }

    const plannedImports = [];
    for (const entry of filePlan) {
      const plates = extractPlates(entry.file.path);
      if (plates.length === 0) {
        for (const file of uploadedFiles) safeUnlink(file.path);
        return res.status(400).json({
          error: `No sliced plates found in "${entry.file.originalname}". Export a sliced project from Bambu Studio or OrcaSlicer first.`,
        });
      }
      plannedImports.push({
        file: entry.file,
        modelRows: entry.resolvedModels.map(modelId => modelCache.get(modelId)),
        plates,
      });
    }

    const plateGroups = new Map();
    for (const item of plannedImports) {
      const filename = item.file.originalname;
      const filepath = item.file.filename;
      for (const plate of item.plates) {
        const key = String(plate.plateIndex);
        if (!plateGroups.has(key)) {
          plateGroups.set(key, {
            plateIndex: plate.plateIndex,
            partsPerPlate: plate.partsPerPlate,
            estPrintSecs: plate.estPrintSecs ?? null,
            materialGrams: plate.materialGrams ?? null,
            requiredMaterial: plate.requiredMaterial ?? null,
            requiredColor: plate.requiredColor ?? null,
            sources: [],
          });
        }

        const group = plateGroups.get(key);
        if (group.partsPerPlate !== plate.partsPerPlate) {
          for (const file of uploadedFiles) safeUnlink(file.path);
          return res.status(400).json({
            error: `Plate ${plate.plateIndex} has inconsistent parts_per_plate across files. Ensure each model-specific slice uses matching plate layout.`,
          });
        }

        group.sources.push({
          filename,
          filepath,
          modelRows: item.modelRows,
          plate,
        });
      }
    }

    const orderedPlateGroups = Array.from(plateGroups.values()).sort((a, b) => a.plateIndex - b.plateIndex);

    const now      = Date.now();

    let project;
    const createdPlates = [];

    db.transaction(() => {
      const parsedVariant = parseProjectVariantFromName(project_name.trim(), inferredSizeRank);
      const projResult = hasProjectSizeColumns
        ? db.prepare(`
            INSERT INTO projects (name, family_name, size_label, size_rank, status, priority, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'draft', 0, ?, ?)
          `).run(
            project_name.trim(),
            parsedVariant.family_name,
            parsedVariant.size_label,
            parsedVariant.size_rank,
            now,
            now
          )
        : db.prepare(`
            INSERT INTO projects (name, status, priority, created_at, updated_at)
            VALUES (?, 'draft', 0, ?, ?)
          `).run(project_name.trim(), now, now);
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projResult.lastInsertRowid);

      let globalSortOrder = 0;
      for (const group of orderedPlateGroups) {
        const partResult = db.prepare(`
          INSERT INTO parts (project_id, name, target_qty, completed_qty, status,
                             sort_order, print_time_seconds, material_grams, created_at, updated_at)
          VALUES (?, ?, 1, 0, 'open', ?, ?, ?, ?, ?)
        `).run(
          project.id,
          `Plate ${group.plateIndex}`,
          globalSortOrder,
          group.estPrintSecs,
          group.materialGrams,
          now, now
        );
        globalSortOrder += 1;

        const gcodeRows = [];
        for (const source of group.sources) {
          for (const model of source.modelRows) {
            const gcodeResult = db.prepare(`
              INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                                  est_print_secs, material_grams, required_material, required_color,
                                  plate_no, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              partResult.lastInsertRowid,
              model.model_id,
              source.filename,
              source.filepath,
              source.plate.partsPerPlate,
              source.plate.estPrintSecs ?? null,
              source.plate.materialGrams ?? null,
              source.plate.requiredMaterial ?? null,
              source.plate.requiredColor ?? null,
              source.plate.plateIndex,
              now
            );
            gcodeRows.push({
              printer_model: model.model_id,
              gcode_id: gcodeResult.lastInsertRowid,
              source_file: source.filename,
            });
          }
        }

        createdPlates.push({
          source_files:      [...new Set(group.sources.map(s => s.filename))],
          plate_index:       group.plateIndex,
          part_id:           partResult.lastInsertRowid,
          gcode_id:          gcodeRows[0]?.gcode_id || null,
          gcodes:            gcodeRows,
          parts_per_plate:   group.partsPerPlate,
          est_print_secs:    group.estPrintSecs,
          material_grams:    group.materialGrams,
          required_material: group.requiredMaterial,
          required_color:    group.requiredColor,
        });
      }
    })();

    console.log(`[projects] Imported ${uploadedFiles.length} 3MF file(s) — project ${project.id} with ${createdPlates.length} plate(s)`);
    res.status(201).json({ project, plates: createdPlates });
  });

  // POST /:id/reimport-3mf - update an existing project in place from one or
  // more sliced 3MF files. Matches existing parts by plate_no first, then
  // by part name prefix "Plate N".
  //
  // obsolete_action:
  // - keep (default): leave unmatched existing parts untouched
  // - archive: close unmatched existing parts (history kept)
  // - remove: delete unmatched existing parts and their jobs/gcodes
  router.post('/:id/reimport-3mf', async (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      await runThreeMfUpload(req, res);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const uploadedFiles = collectUploadedFiles(req);
    if (uploadedFiles.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    const inferredSizes = [...new Set(
      uploadedFiles.map(f => detectSizeRankFromFilename(f.originalname)).filter(v => v != null)
    )];
    if (inferredSizes.length > 1) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({
        error: 'Uploaded filenames contain mixed size suffixes. Re-import one size per project.',
      });
    }
    const inferredSizeRank = inferredSizes.length === 1 ? inferredSizes[0] : null;
    if (inferredSizeRank != null) {
      const currentSize = Number.isFinite(Number(project.size_rank))
        ? Number(project.size_rank)
        : parseProjectVariantFromName(project.name).size_rank;
      if (currentSize !== inferredSizeRank) {
        for (const file of uploadedFiles) safeUnlink(file.path);
        return res.status(409).json({
          error: `Filename size suffix (${inferredSizeRank}%) does not match project size (${currentSize}%). Re-import into the matching size variant project.`,
        });
      }
    }

    const { printer_model, printer_models, file_printer_models, obsolete_action } = req.body;
    const obsoleteAction = parseObsoleteAction(obsolete_action);
    if (!obsoleteAction) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({ error: 'obsolete_action must be one of: keep, archive, remove' });
    }

    const globalModels = parsePrinterModels(printer_models)
      .map(m => String(m || '').trim().toLowerCase())
      .filter(Boolean);
    if (globalModels.length === 0 && printer_model && String(printer_model).trim()) {
      globalModels.push(String(printer_model).trim().toLowerCase());
    }

    const perFileModels = parsePerFilePrinterModels(file_printer_models)
      .map(m => String(m || '').trim().toLowerCase());

    if (uploadedFiles.length > 1 && perFileModels.length === 0 && globalModels.length > 1) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({
        error: 'Ambiguous model assignment: when uploading multiple files with multiple models, use file_printer_models (one model per file) or filename suffix detection.',
      });
    }

    if (perFileModels.length > 0 && perFileModels.length !== uploadedFiles.length) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(400).json({
        error: 'file_printer_models must contain one entry per uploaded file (use empty string to fall back to suffix detection).',
      });
    }

    const allResolvedModels = new Set();
    const filePlan = [];
    for (let idx = 0; idx < uploadedFiles.length; idx += 1) {
      const file = uploadedFiles[idx];
      const perFileModel = perFileModels[idx] || '';
      const inferredModel = detectPrinterModelFromFilename(file.originalname);

      const resolvedModels = [...new Set(
        perFileModel
          ? [perFileModel]
          : (globalModels.length > 0 ? globalModels : (inferredModel ? [inferredModel] : []))
      )];

      if (resolvedModels.length === 0) {
        for (const f of uploadedFiles) safeUnlink(f.path);
        const missingModelError = (!printer_model && !printer_models && !file_printer_models)
          ? 'printer_model is required'
          : `No model resolved for file "${file.originalname}". Provide file_printer_models, printer_model/printer_models, or a filename suffix like *_x1c.gcode.3mf`;
        return res.status(400).json({ error: missingModelError });
      }

      filePlan.push({ file, resolvedModels });
      for (const modelId of resolvedModels) allResolvedModels.add(modelId);
    }

    const modelCache = new Map();
    for (const modelId of allResolvedModels) {
      const row = db.prepare('SELECT * FROM printer_models WHERE model_id = ?').get(modelId);
      if (!row) {
        for (const file of uploadedFiles) safeUnlink(file.path);
        return res.status(400).json({ error: `Unknown model "${modelId}". Add it in Settings first.` });
      }
      if (row.connector !== 'bambu') {
        for (const file of uploadedFiles) safeUnlink(file.path);
        return res.status(400).json({ error: `3MF import requires Bambu models. "${modelId}" uses connector "${row.connector}".` });
      }
      modelCache.set(modelId, row);
    }

    const plannedImports = [];
    for (const entry of filePlan) {
      const plates = extractPlates(entry.file.path);
      if (plates.length === 0) {
        for (const file of uploadedFiles) safeUnlink(file.path);
        return res.status(400).json({
          error: `No sliced plates found in "${entry.file.originalname}". Export a sliced project from Bambu Studio or OrcaSlicer first.`,
        });
      }
      plannedImports.push({
        file: entry.file,
        modelRows: entry.resolvedModels.map(modelId => modelCache.get(modelId)),
        plates,
      });
    }

    const plateGroups = new Map();
    for (const item of plannedImports) {
      const filename = item.file.originalname;
      const filepath = item.file.filename;
      for (const plate of item.plates) {
        const key = String(plate.plateIndex);
        if (!plateGroups.has(key)) {
          plateGroups.set(key, {
            plateIndex: plate.plateIndex,
            partsPerPlate: plate.partsPerPlate,
            estPrintSecs: plate.estPrintSecs ?? null,
            materialGrams: plate.materialGrams ?? null,
            requiredMaterial: plate.requiredMaterial ?? null,
            requiredColor: plate.requiredColor ?? null,
            sources: [],
          });
        }

        const group = plateGroups.get(key);
        if (group.partsPerPlate !== plate.partsPerPlate) {
          for (const file of uploadedFiles) safeUnlink(file.path);
          return res.status(400).json({
            error: `Plate ${plate.plateIndex} has inconsistent parts_per_plate across files. Ensure each model-specific slice uses matching plate layout.`,
          });
        }

        group.sources.push({
          filename,
          filepath,
          modelRows: item.modelRows,
          plate,
        });
      }
    }

    const orderedPlateGroups = Array.from(plateGroups.values()).sort((a, b) => a.plateIndex - b.plateIndex);
    const now = Date.now();

    const existingParts = db.prepare(`
      SELECT p.*,
             (
               SELECT MIN(g.plate_no) FROM gcodes g
               WHERE g.part_id = p.id AND g.plate_no IS NOT NULL
             ) AS plate_no_hint
      FROM parts p
      WHERE p.project_id = ?
      ORDER BY p.sort_order ASC, p.id ASC
    `).all(project.id);

    const byPlateNo = new Map();
    const byNamePlateNo = new Map();
    for (const part of existingParts) {
      if (part.plate_no_hint != null && !byPlateNo.has(part.plate_no_hint)) {
        byPlateNo.set(part.plate_no_hint, part);
      }
      const fromName = parsePlateNumberFromPartName(part.name);
      if (fromName != null && !byNamePlateNo.has(fromName)) {
        byNamePlateNo.set(fromName, part);
      }
    }

    const touchedPartIds = new Set();
    const appliedPlates = [];
    let createdParts = 0;
    let updatedParts = 0;
    let insertedGcodes = 0;
    let updatedGcodes = 0;

    try {
      db.transaction(() => {
        let maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM parts WHERE project_id = ?').get(project.id).max;

        for (const group of orderedPlateGroups) {
          const sourceModelMap = new Map();
          for (const source of group.sources) {
            for (const model of source.modelRows) {
              if (!sourceModelMap.has(model.model_id)) {
                sourceModelMap.set(model.model_id, source);
              }
            }
          }

          const desiredModels = [...sourceModelMap.keys()];
          const desiredByModel = new Map(desiredModels.map((modelId) => {
            const source = sourceModelMap.get(modelId);
            return [modelId, {
              filename: source.filename,
              filepath: source.filepath,
              parts_per_plate: source.plate.partsPerPlate,
              est_print_secs: source.plate.estPrintSecs ?? null,
              material_grams: source.plate.materialGrams ?? null,
              required_material: source.plate.requiredMaterial ?? null,
              required_color: source.plate.requiredColor ?? null,
              plate_no: source.plate.plateIndex,
            }];
          }));

          let matched = byPlateNo.get(group.plateIndex) || byNamePlateNo.get(group.plateIndex) || null;
          if (matched && touchedPartIds.has(matched.id)) {
            matched = null;
          }

          let partId;
          if (matched) {
            partId = matched.id;
            db.prepare(`
              UPDATE parts
              SET print_time_seconds = ?, material_grams = ?, updated_at = ?
              WHERE id = ?
            `).run(group.estPrintSecs, group.materialGrams, now, partId);
            updatedParts += 1;
          } else {
            maxSort += 1;
            const inserted = db.prepare(`
              INSERT INTO parts (project_id, name, target_qty, completed_qty, status,
                                 sort_order, print_time_seconds, material_grams, created_at, updated_at)
              VALUES (?, ?, 1, 0, 'open', ?, ?, ?, ?, ?)
            `).run(project.id, `Plate ${group.plateIndex}`, maxSort, group.estPrintSecs, group.materialGrams, now, now);
            partId = inserted.lastInsertRowid;
            createdParts += 1;
          }

          touchedPartIds.add(partId);

          const existingGcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ? ORDER BY id').all(partId);
          const existingByModel = new Map();
          for (const gc of existingGcodes) {
            if (!existingByModel.has(gc.printer_model)) existingByModel.set(gc.printer_model, gc);
          }

          for (const [modelId, desired] of desiredByModel.entries()) {
            const current = existingByModel.get(modelId);
            if (current) {
              db.prepare(`
                UPDATE gcodes
                SET filename = ?, filepath = ?, parts_per_plate = ?, est_print_secs = ?,
                    material_grams = ?, required_material = ?, required_color = ?, plate_no = ?
                WHERE id = ?
              `).run(
                desired.filename,
                desired.filepath,
                desired.parts_per_plate,
                desired.est_print_secs,
                desired.material_grams,
                desired.required_material,
                desired.required_color,
                desired.plate_no,
                current.id
              );
              updatedGcodes += 1;
            } else {
              db.prepare(`
                INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                                    est_print_secs, material_grams, required_material, required_color,
                                    plate_no, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                partId,
                modelId,
                desired.filename,
                desired.filepath,
                desired.parts_per_plate,
                desired.est_print_secs,
                desired.material_grams,
                desired.required_material,
                desired.required_color,
                desired.plate_no,
                now
              );
              insertedGcodes += 1;
            }
          }

          if (obsoleteAction === 'remove') {
            const obsoleteGcodes = existingGcodes.filter(gc => !desiredByModel.has(gc.printer_model));
            for (const gc of obsoleteGcodes) {
              const hasJobs = db.prepare('SELECT 1 FROM jobs WHERE gcode_id = ? LIMIT 1').get(gc.id);
              if (!hasJobs) {
                db.prepare('DELETE FROM gcodes WHERE id = ?').run(gc.id);
              }
            }
          }

          appliedPlates.push({
            plate_index: group.plateIndex,
            part_id: partId,
            source_files: [...new Set(group.sources.map(s => s.filename))],
            models: desiredModels,
            parts_per_plate: group.partsPerPlate,
          });
        }

        const untouched = existingParts.filter((p) => !touchedPartIds.has(p.id));
        if (obsoleteAction === 'archive') {
          for (const part of untouched) {
            db.prepare(`
              UPDATE parts
              SET status = 'closed', target_qty = completed_qty, updated_at = ?
              WHERE id = ?
            `).run(now, part.id);
          }
        }

        if (obsoleteAction === 'remove') {
          for (const part of untouched) {
            const active = db.prepare(
              "SELECT 1 FROM jobs WHERE part_id = ? AND status IN ('uploading','printing') LIMIT 1"
            ).get(part.id);
            if (active) {
              throw new Error(`Cannot remove obsolete part "${part.name}" because it has an active job in progress.`);
            }

            db.prepare('DELETE FROM jobs WHERE part_id = ?').run(part.id);
            db.prepare('DELETE FROM gcodes WHERE part_id = ?').run(part.id);
            db.prepare('DELETE FROM parts WHERE id = ?').run(part.id);
          }
        }

        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project.id);
      })();
    } catch (err) {
      for (const file of uploadedFiles) safeUnlink(file.path);
      return res.status(409).json({ error: err.message });
    }

    const untouchedCount = existingParts.filter((p) => !touchedPartIds.has(p.id)).length;
    const summary = {
      updated_parts: updatedParts,
      created_parts: createdParts,
      updated_gcodes: updatedGcodes,
      inserted_gcodes: insertedGcodes,
      obsolete_action: obsoleteAction,
      untouched_parts: untouchedCount,
    };

    console.log(`[projects] Re-imported ${uploadedFiles.length} 3MF file(s) into project ${project.id} — ${updatedParts} part(s) updated, ${createdParts} part(s) created`);
    const refreshed = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    res.status(200).json({ project: refreshed, summary, plates: appliedPlates });
  });

  // PUT /reorder — set priority for an ordered list of project IDs.
  // Body: { ids: [3, 1, 2] } — index becomes priority (0 = highest).
  // Must be defined before /:id so Express doesn't match 'reorder' as an id.
  router.put('/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const update = db.prepare('UPDATE projects SET priority = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    db.transaction(() => {
      ids.forEach((id, index) => update.run(index, now, id));
    })();
    res.json({ success: true });
  });

  // Set project-level filament defaults — explicitly nullable (empty string → NULL)
  router.put('/:id/filament', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const mat = req.body?.required_material?.trim() || null;
    const col = req.body?.required_color?.trim()    || null;
    const brand = req.body?.required_brand?.trim() || null;
    if (hasProjectRequiredBrand) {
      db.prepare(`
        UPDATE projects
        SET required_material = ?, required_color = ?, required_brand = ?, updated_at = ?
        WHERE id = ?
      `).run(mat, col, brand, Date.now(), project.id);
    } else {
      db.prepare(`
        UPDATE projects SET required_material = ?, required_color = ?, updated_at = ? WHERE id = ?
      `).run(mat, col, Date.now(), project.id);
    }
    if (scheduler) scheduler.sweepIdlePrinters();
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
  });

  // Set project-level group defaults: cascades to every gcode in this project
  // that doesn't set its own allowed_groups override (see scheduler.js's
  // COALESCE(gcodes.allowed_groups, projects.allowed_groups)). Empty selection
  // stores NULL, never '[]': COALESCE(...) = '[]' would be non-NULL and match
  // zero printers, silently freezing dispatch for the whole project.
  router.put('/:id/groups', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const arr = Array.isArray(req.body?.allowed_groups)
      ? req.body.allowed_groups.map(s => String(s).trim()).filter(Boolean)
      : [];
    const value = arr.length > 0 ? JSON.stringify(arr) : null;
    db.prepare(`
      UPDATE projects SET allowed_groups = ?, updated_at = ? WHERE id = ?
    `).run(value, Date.now(), project.id);
    if (scheduler) scheduler.sweepIdlePrinters();
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
  });

  // POST /:id/add-qty — increment target_qty for every part in a project.
  // Body: { qty: 2 }
  // Reopens closed parts that now have remaining work. If the project was
  // completed and any part now has remaining qty, reactivate to active.
  router.post('/:id/add-qty', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const qty = parseInt(req.body?.qty, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({ error: 'qty must be an integer of 1 or greater' });
    }

    const parts = db.prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC, id ASC').all(project.id);
    if (parts.length === 0) {
      return res.status(400).json({ error: 'Project has no parts to update' });
    }

    const now = Date.now();
    let reopenedParts = 0;
    let partsWithRemaining = 0;

    db.transaction(() => {
      const updatePart = db.prepare(`
        UPDATE parts
        SET target_qty = ?, status = ?, updated_at = ?
        WHERE id = ?
      `);

      for (const part of parts) {
        const newTarget = part.target_qty + qty;
        const resolvedStatus = part.completed_qty >= newTarget ? 'closed' : 'open';
        if (part.status === 'closed' && resolvedStatus === 'open') reopenedParts += 1;
        if (part.completed_qty < newTarget) partsWithRemaining += 1;
        updatePart.run(newTarget, resolvedStatus, now, part.id);
      }

      if (project.status === 'completed' && partsWithRemaining > 0) {
        db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
      } else {
        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project.id);
      }
    })();

    if (scheduler && partsWithRemaining > 0) {
      scheduler.sweepIdlePrinters();
    }

    const refreshed = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    res.json({
      project: refreshed,
      qty_added: qty,
      updated_parts: parts.length,
      reopened_parts: reopenedParts,
      reactivated_project: project.status === 'completed' && refreshed.status === 'active',
    });
  });

  // POST /:id/set-target-all — set the same target_qty for every part in a project.
  // Body: { target_qty: 25 }
  // Reopens closed parts that now have remaining work. If the project was
  // completed and any part now has remaining qty, reactivate to active.
  router.post('/:id/set-target-all', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const targetQty = parseInt(req.body?.target_qty, 10);
    if (!Number.isInteger(targetQty) || targetQty < 1) {
      return res.status(400).json({ error: 'target_qty must be an integer of 1 or greater' });
    }

    const parts = db.prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC, id ASC').all(project.id);
    if (parts.length === 0) {
      return res.status(400).json({ error: 'Project has no parts to update' });
    }

    const now = Date.now();
    let reopenedParts = 0;
    let closedParts = 0;
    let partsWithRemaining = 0;

    db.transaction(() => {
      const updatePart = db.prepare(`
        UPDATE parts
        SET target_qty = ?, status = ?, updated_at = ?
        WHERE id = ?
      `);

      for (const part of parts) {
        const resolvedStatus = part.completed_qty >= targetQty ? 'closed' : 'open';
        if (part.status === 'closed' && resolvedStatus === 'open') reopenedParts += 1;
        if (part.status === 'open' && resolvedStatus === 'closed') closedParts += 1;
        if (part.completed_qty < targetQty) partsWithRemaining += 1;
        updatePart.run(targetQty, resolvedStatus, now, part.id);
      }

      if (project.status === 'completed' && partsWithRemaining > 0) {
        db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
      } else {
        db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project.id);
      }
    })();

    if (scheduler && partsWithRemaining > 0) {
      scheduler.sweepIdlePrinters();
    }

    const refreshed = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    res.json({
      project: refreshed,
      target_qty: targetQty,
      updated_parts: parts.length,
      reopened_parts: reopenedParts,
      closed_parts: closedParts,
      reactivated_project: project.status === 'completed' && refreshed.status === 'active',
    });
  });

  router.put('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, description, status } = req.body;
    const now = Date.now();

    if (hasProjectSizeColumns && typeof name === 'string' && name.trim()) {
      const fallbackSize = Number.isFinite(Number(project.size_rank)) ? Number(project.size_rank) : null;
      const parsedVariant = parseProjectVariantFromName(name, fallbackSize);
      db.prepare(`
        UPDATE projects
        SET name = ?,
            family_name = ?,
            size_label = ?,
            size_rank = ?,
            description = COALESCE(?, description),
            status = COALESCE(?, status),
            updated_at = ?
        WHERE id = ?
      `).run(
        name,
        parsedVariant.family_name,
        parsedVariant.size_label,
        parsedVariant.size_rank,
        description,
        status,
        now,
        req.params.id
      );
    } else {
      db.prepare(`
        UPDATE projects
        SET name = COALESCE(?, name),
            description = COALESCE(?, description),
            status = COALESCE(?, status),
            updated_at = ?
        WHERE id = ?
      `).run(name, description, status, now, req.params.id);
    }
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
  });

  // DELETE /:id. Permanently removes a project and everything under it: its parts, their
  // gcodes (and the uploaded files on disk), and jobs. The project's tag links go with it
  // via project_tag_links' ON DELETE CASCADE. Allowed for any status; the client gates it
  // behind a confirm modal. An in-flight print keeps running on the printer but is no
  // longer tracked, so no part count is credited once it finishes.
  router.delete('/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parts = db.prepare('SELECT id FROM parts WHERE project_id = ?').all(project.id);

    db.transaction(() => {
      for (const part of parts) {
        db.prepare('DELETE FROM jobs WHERE part_id = ?').run(part.id);

        const gcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part.id);
        for (const gcode of gcodes) {
          const basename = gcode.filepath.split(/[\\/]/).pop();
          const fullPath = path.join(GCODE_DIR, basename);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          db.prepare('DELETE FROM gcodes WHERE id = ?').run(gcode.id);
        }

        partLedger.deleteForPart(db, part.id);
        db.prepare('DELETE FROM parts WHERE id = ?').run(part.id);
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    })();

    console.log(`[projects] Deleted project ${project.id} "${project.name}" (${parts.length} part(s) removed)`);
    res.json({ success: true });
  });

  // POST /:id/complete — force-close a project before all parts hit their target qty.
  // Closes all open parts and cancels any queued/uploading jobs for them.
  router.post('/:id/complete', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.status === 'completed') return res.status(400).json({ error: 'Project is already completed' });

    const now = Date.now();
    const openParts = db.prepare("SELECT * FROM parts WHERE project_id = ? AND status = 'open'").all(project.id);

    db.prepare("UPDATE parts SET status = 'closed', updated_at = ? WHERE project_id = ? AND status = 'open'").run(now, project.id);

    let cancelledJobs = 0;
    if (openParts.length > 0) {
      const placeholders = openParts.map(() => '?').join(',');
      const result = db.prepare(
        `UPDATE jobs SET status = 'cancelled' WHERE part_id IN (${placeholders}) AND status IN ('queued', 'uploading')`
      ).run(...openParts.map(p => p.id));
      cancelledJobs = result.changes;
    }

    db.prepare("UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?").run(now, project.id);
    console.log(`[server] Project ${project.id} "${project.name}" force-completed — ${openParts.length} part(s) closed, ${cancelledJobs} job(s) cancelled`);

    res.json({
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
      closed_parts: openParts.length,
      cancelled_jobs: cancelledJobs,
    });
  });

  // POST /:id/reactivate — re-open a completed project.
  // Reopens closed parts that still have remaining qty. Returns nothing_to_reopen: true
  // if all parts are already at or above target so the UI can warn before dispatching nothing.
  router.post('/:id/reactivate', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const now = Date.now();
    const eligible = db.prepare(`
      SELECT * FROM parts
      WHERE project_id = ? AND status = 'closed' AND completed_qty < target_qty
    `).all(project.id);

    const openRemaining = db.prepare(`
      SELECT COUNT(*) AS count FROM parts
      WHERE project_id = ? AND status = 'open' AND completed_qty < target_qty
    `).get(project.id).count;

    if (eligible.length === 0 && openRemaining === 0) {
      return res.json({ nothing_to_reopen: true, project });
    }

    if (eligible.length > 0) {
      const placeholders = eligible.map(() => '?').join(',');
      db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id IN (${placeholders})`)
        .run(now, ...eligible.map((p) => p.id));
    }

    db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);

    console.log(`[server] Project ${project.id} "${project.name}" re-activated — ${eligible.length} part(s) reopened`);

    if (scheduler) scheduler.sweepIdlePrinters();

    res.json({
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
      reopened_parts: eligible.length,
    });
  });

  // POST /:id/duplicate — create a new draft project copied from an existing one.
  // Body: { name?: string } — defaults to "Copy of <source name>".
  // All parts are copied with completed_qty reset to 0 and status reset to open.
  // Each part's G-code files are physically copied to new unique filenames so the
  // two projects are fully independent — deleting one won't affect the other.
  router.post('/:id/duplicate', (req, res) => {
    const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Project not found' });

    const name = (req.body.name || '').trim() || `Copy of ${source.name}`;
    const now  = Date.now();

    const sourceParts = db
      .prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(source.id);

    let newProject;
    let copiedParts  = 0;
    let copiedGcodes = 0;

    db.transaction(() => {
      const parsedVariant = parseProjectVariantFromName(name);
      const projResult = hasProjectSizeColumns
        ? db.prepare(`
            INSERT INTO projects (name, description, family_name, size_label, size_rank, status, priority, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?)
          `).run(
            name,
            source.description ?? null,
            parsedVariant.family_name,
            parsedVariant.size_label,
            parsedVariant.size_rank,
            now,
            now
          )
        : db.prepare(`
            INSERT INTO projects (name, description, status, priority, created_at, updated_at)
            VALUES (?, ?, 'draft', 0, ?, ?)
          `).run(name, source.description ?? null, now, now);
      newProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(projResult.lastInsertRowid);

      if (hasProjectTagTables) {
        const sourceTagIds = db.prepare('SELECT tag_id FROM project_tag_links WHERE project_id = ? ORDER BY tag_id ASC').all(source.id);
        const insertProjectTag = db.prepare('INSERT INTO project_tag_links (project_id, tag_id, created_at) VALUES (?, ?, ?)');
        for (const row of sourceTagIds) {
          insertProjectTag.run(newProject.id, row.tag_id, now);
        }
      }

      for (const part of sourceParts) {
        const partResult = db.prepare(`
          INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order,
                             print_time_seconds, material_grams, created_at, updated_at)
          VALUES (?, ?, ?, 0, 'open', ?, ?, ?, ?, ?)
        `).run(
          newProject.id, part.name, part.target_qty, part.sort_order,
          part.print_time_seconds ?? null, part.material_grams ?? null, now, now
        );
        copiedParts++;

        const gcodes = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part.id);
        for (const gcode of gcodes) {
          const srcBasename = gcode.filepath.split(/[\\/]/).pop();
          const srcPath     = path.join(GCODE_DIR, srcBasename);
          const newBasename = `${now}_dup${gcode.id}_${gcode.filename}`;
          let   newFilepath = newBasename;

          if (fs.existsSync(srcPath)) {
            try {
              fs.copyFileSync(srcPath, path.join(GCODE_DIR, newBasename));
            } catch (_) {
              newFilepath = gcode.filepath; // fallback: keep original path reference
            }
          } else {
            newFilepath = gcode.filepath; // source file missing — preserve metadata only
          }

          db.prepare(`
            INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                                est_print_secs, material_grams, ams_slot, plate_no, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            partResult.lastInsertRowid, gcode.printer_model, gcode.filename, newFilepath,
            gcode.parts_per_plate, gcode.est_print_secs ?? null, gcode.material_grams ?? null,
            gcode.ams_slot ?? null, gcode.plate_no ?? null, now
          );
          copiedGcodes++;
        }
      }
    })();

    res.status(201).json({ project: addTagsToProjects([newProject])[0], copied_parts: copiedParts, copied_gcodes: copiedGcodes });
  });

  return router;
};
