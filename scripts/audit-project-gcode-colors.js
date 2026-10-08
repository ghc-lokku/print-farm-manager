#!/usr/bin/env node
/*
  Usage:
    node scripts/audit-project-gcode-colors.js --db server/data/printfarm.db --project "Haunted House"
*/

const path = require('path');
const Database = require('better-sqlite3');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

const dbPathArg = argValue('--db') || path.join('server', 'data', 'printfarm.db');
const projectNameArg = argValue('--project');

if (!projectNameArg) {
  console.error('Missing --project "Project Name"');
  process.exit(1);
}

const db = new Database(dbPathArg, { readonly: true });

const projects = db.prepare(`
  SELECT id, name, status
  FROM projects
  WHERE lower(name) LIKE lower(?)
  ORDER BY id ASC
`).all(`%${projectNameArg}%`);

if (projects.length === 0) {
  console.log(`No projects match "${projectNameArg}" in ${dbPathArg}`);
  process.exit(0);
}

for (const proj of projects) {
  console.log(`\n=== Project ${proj.id}: ${proj.name} (${proj.status}) ===`);

  const rows = db.prepare(`
    SELECT
      p.id AS part_id,
      p.name AS part_name,
      g.id AS gcode_id,
      g.plate_no,
      g.printer_model,
      g.filename,
      g.required_color,
      g.required_material,
      g.created_at
    FROM parts p
    JOIN gcodes g ON g.part_id = p.id
    WHERE p.project_id = ?
    ORDER BY p.sort_order ASC, p.id ASC, g.printer_model ASC, g.id ASC
  `).all(proj.id);

  if (rows.length === 0) {
    console.log('No gcodes found for this project.');
    continue;
  }

  const byPartModel = new Map();
  for (const r of rows) {
    const key = `${r.part_id}::${r.printer_model}`;
    if (!byPartModel.has(key)) byPartModel.set(key, []);
    byPartModel.get(key).push(r);
  }

  for (const [key, group] of byPartModel.entries()) {
    const [partId, printerModel] = key.split('::');
    const newest = group[group.length - 1];
    if (group.length > 1) {
      console.log(`\nDUPLICATE part/model rows -> part ${partId}, model ${printerModel}, count=${group.length}`);
      for (const g of group) {
        const mark = g.gcode_id === newest.gcode_id ? ' [NEWEST USED BY SCHEDULER]' : '';
        console.log(`  gcode_id=${g.gcode_id}, plate_no=${g.plate_no}, required_color=${JSON.stringify(g.required_color)}, file=${g.filename}${mark}`);
      }
    }
  }

  const byPart = new Map();
  for (const r of rows) {
    if (!byPart.has(r.part_id)) byPart.set(r.part_id, []);
    byPart.get(r.part_id).push(r);
  }

  for (const [partId, group] of byPart.entries()) {
    const label = `${group[0].part_name} (part_id=${partId})`;
    const uniqueColorStrings = [...new Set(group.map(g => (g.required_color || '').trim()).filter(Boolean))];
    if (uniqueColorStrings.length > 1) {
      console.log(`\nINCONSISTENT required_color across models -> ${label}`);
      for (const g of group) {
        console.log(`  model=${g.printer_model}, gcode_id=${g.gcode_id}, plate_no=${g.plate_no}, required_color=${JSON.stringify(g.required_color)}, file=${g.filename}`);
      }
    }

    const hasYellow = group.some(g => /(^|[\s,|])(?:yellow|ffff00)([\s,|]|$)/i.test(String(g.required_color || '')));
    const hasBlack = group.some(g => /(^|[\s,|])(?:black|000000)([\s,|]|$)/i.test(String(g.required_color || '')));
    if (hasBlack && !hasYellow) {
      console.log(`\nPOSSIBLE MISSING YELLOW -> ${label}`);
      for (const g of group) {
        console.log(`  model=${g.printer_model}, gcode_id=${g.gcode_id}, plate_no=${g.plate_no}, required_color=${JSON.stringify(g.required_color)}`);
      }
    }
  }
}

console.log('\nAudit complete.');
