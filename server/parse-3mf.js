'use strict';
// Shared utilities for reading Bambu/OrcaSlicer .3mf project files.
// A .3mf is a ZIP archive. These functions parse its structure without
// requiring an external zip library.

const fs   = require('fs');
const zlib = require('zlib');

// Opens a .3mf (a ZIP archive) and returns a reader over its entries, or null
// on failure. reader.names lists all entry names; reader.extractText(name)
// inflates and returns the entry's UTF-8 text (or null). Metadata (plate gcode,
// slice_info) lives under Metadata/.
function openThreeMf(threeMfPath) {
  let buf;
  try {
    buf = fs.readFileSync(threeMfPath);
  } catch (_) {
    return null;
  }

  const eocdSig = 0x06054b50;
  const cdfhSig = 0x02014b50;
  const searchStart = Math.max(0, buf.length - 22 - 0xFFFF);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const cdSize   = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEnd    = cdOffset + cdSize;
  if (cdOffset < 0 || cdEnd > buf.length) return null;

  const entries = new Map();
  let p = cdOffset;
  while (p + 46 <= cdEnd && buf.readUInt32LE(p) === cdfhSig) {
    const flags          = buf.readUInt16LE(p + 8);
    const method         = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen        = buf.readUInt16LE(p + 28);
    const extraLen       = buf.readUInt16LE(p + 30);
    const commentLen     = buf.readUInt16LE(p + 32);
    const localOffset    = buf.readUInt32LE(p + 42);
    const nameStart      = p + 46;
    const nameEnd        = nameStart + nameLen;
    if (nameEnd > buf.length) break;

    const isUtf8 = (flags & (1 << 11)) !== 0;
    const name   = buf.toString(isUtf8 ? 'utf8' : 'binary', nameStart, nameEnd);
    entries.set(name, { method, compressedSize, localOffset });
    p = nameEnd + extraLen + commentLen;
  }

  const extractBytes = (entryName) => {
    const meta = entries.get(entryName);
    if (!meta) return null;
    const { method, compressedSize, localOffset } = meta;

    if (!Number.isFinite(localOffset) || localOffset < 0 || localOffset + 30 > buf.length) return null;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;

    const localNameLen  = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart     = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd       = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > buf.length) return null;

    const raw = buf.subarray(dataStart, dataEnd);
    if (method === 0) {
      return raw;
    }
    if (method === 8) {
      try { return zlib.inflateRawSync(raw); } catch (_) { return null; }
    }
    return null;
  };

  const extractText = (entryName) => {
    const payload = extractBytes(entryName);
    if (!payload) return null;
    try {
      return payload.toString('utf8');
    } catch (_) {
      return null;
    }
  };

  return { names: [...entries.keys()], extractText, extractBytes };
}

// Detects which plate to print and returns its MQTT param and bed type.
// plateNo overrides auto-detection when a specific plate has been saved on the
// gcode record (multi-plate import stores plate_no per gcode row).
function detectProjectMetadata(threeMfPath, plateNo = null) {
  const fallback = { projectFileParam: 'Metadata/plate_1.gcode', bedType: 'auto', plateIndex: 1 };

  const mf = openThreeMf(threeMfPath);
  if (!mf) return fallback;

  let selected;

  if (plateNo != null) {
    const gcodeEntry  = mf.names.find(n => new RegExp(`^Metadata/plate_${plateNo}\\.gcode$`, 'i').test(n));
    const bgcodeEntry = mf.names.find(n => new RegExp(`^Metadata/plate_${plateNo}\\.bgcode$`, 'i').test(n));
    const entryName   = gcodeEntry || bgcodeEntry;
    if (!entryName) return fallback;
    selected = { index: plateNo, name: entryName };
  } else {
    const plateEntries = [];
    for (const name of mf.names) {
      const m = /^Metadata\/plate_(\d+)\.(?:b?gcode)$/i.exec(name);
      if (m) plateEntries.push({ index: parseInt(m[1], 10), name });
    }
    if (plateEntries.length === 0) return fallback;
    plateEntries.sort((a, b) => a.index - b.index);
    selected = plateEntries[0];
  }

  let bedType = 'auto';
  const plateJsonText = mf.extractText(`Metadata/plate_${selected.index}.json`);
  if (plateJsonText) {
    try {
      const parsed = JSON.parse(plateJsonText);
      if (typeof parsed?.bed_type === 'string' && parsed.bed_type.trim()) {
        bedType = parsed.bed_type.trim();
      }
    } catch (_) {}
  }

  return { projectFileParam: selected.name, bedType, plateIndex: selected.index };
}

// Parses Metadata/slice_info.config for the given plate and returns
// { filamentCount, filaments: [{ id, hex, type }] } or null on failure.
function parsePlateFilaments(threeMfPath, plateIndex) {
  const mf = openThreeMf(threeMfPath);
  if (!mf) return null;
  const text = mf.extractText('Metadata/slice_info.config');
  if (!text) return null;

  const blocks = text.split(/<plate\b/i).slice(1).map(b => b.split(/<\/plate>/i)[0]);
  if (blocks.length === 0) return null;
  const block = blocks.find(b =>
    new RegExp(`key="index"\\s+value="${plateIndex}"`, 'i').test(b)
  ) || blocks[0];

  const filaments = [];
  const re = /<filament\b[^>]*>/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const tag        = m[0];
    const idMatch    = /\bid="(\d+)"/.exec(tag);
    if (!idMatch) continue;
    const colorMatch = /\bcolor="#?([0-9A-Fa-f]{6,8})"/.exec(tag);
    const typeMatch  = /\btype="([^"]*)"/.exec(tag);
    filaments.push({
      id:   parseInt(idMatch[1], 10),
      hex:  colorMatch ? colorMatch[1].slice(0, 6).toUpperCase() : null,
      type: typeMatch ? typeMatch[1] : null,
    });
  }
  if (filaments.length === 0) return null;

  const mapsMatch = /key="filament_maps"\s+value="([^"]*)"/i.exec(block);
  const filamentCount = mapsMatch
    ? mapsMatch[1].trim().split(/\s+/).filter(Boolean).length
    : Math.max(...filaments.map(f => f.id));

  return { filamentCount, filaments };
}

// Returns metadata for every sliced plate in the .3mf. Only plates that have an
// embedded gcode file (Metadata/plate_N.gcode or .bgcode) are included — unsliced
// plates have plate_N.json but no gcode, and are skipped.
// Returns [] when the 3MF contains no sliced plates (unsliced project file).
function extractPlates(threeMfPath) {
  const mf = openThreeMf(threeMfPath);
  if (!mf) return [];

  const plateEntries = [];
  for (const name of mf.names) {
    const m = /^Metadata\/plate_(\d+)\.(?:b?gcode)$/i.exec(name);
    if (m) plateEntries.push({ index: parseInt(m[1], 10), entryName: name });
  }
  if (plateEntries.length === 0) return [];
  plateEntries.sort((a, b) => a.index - b.index);

  const sliceInfoText = mf.extractText('Metadata/slice_info.config');

  const result = [];
  for (const { index, entryName } of plateEntries) {
    let estPrintSecs     = null;
    let materialGrams    = null;
    let requiredMaterial = null;
    let requiredColor    = null;
    let bedType          = 'auto';
    let partsPerPlate    = 1;

    const plateJsonText = mf.extractText(`Metadata/plate_${index}.json`);
    if (plateJsonText) {
      try {
        const pj = JSON.parse(plateJsonText);
        // A plate is a single print job. The number of object instances in the
        // sliced plate is not the farm's target quantity. Bambu/Orca can include
        // multiple repeated objects per plate (for example, a 5-up layout) without
        // meaning we should auto-scale the part target to 5 or treat the plate as a
        // 5-part batch. The operator edits target_qty explicitly when they want a
        // plate repeated; default imports should stay at one plate per part.
        if (typeof pj.bed_type === 'string' && pj.bed_type.trim()) {
          bedType = pj.bed_type.trim();
        }
      } catch (_) {}
    }

    if (sliceInfoText) {
      const blocks = sliceInfoText.split(/<plate\b/i).slice(1)
        .map(b => b.split(/<\/plate>/i)[0]);
      const block = blocks.find(b =>
        new RegExp(`key="index"\\s+value="${index}"`, 'i').test(b)
      );
      if (block) {
        const predMatch = /key="prediction"\s+value="(\d+)"/i.exec(block);
        if (predMatch) estPrintSecs = parseInt(predMatch[1], 10);

        const weightMatch = /key="weight"\s+value="([\d.]+)"/i.exec(block);
        if (weightMatch) materialGrams = parseFloat(weightMatch[1]);

        const filamentRe = /<filament\b[^>]*>/gi;
        const colors = [];
        const types  = new Set();
        let fm;
        while ((fm = filamentRe.exec(block)) !== null) {
          const tag = fm[0];
          // Skip filaments that are support-only (not used for the model itself).
          if (/\bused_for_object="false"/.test(tag) && !/\bused_for_support="true"/.test(tag)) continue;
          const colorMatch = /\bcolor="#?([0-9A-Fa-f]{6,8})"/.exec(tag);
          const typeMatch  = /\btype="([^"]*)"/.exec(tag);
          if (colorMatch) colors.push(colorMatch[1].slice(0, 6).toUpperCase());
          if (typeMatch && typeMatch[1]) types.add(typeMatch[1]);
        }
        if (colors.length > 0) requiredColor    = colors.join(', ');
        if (types.size  > 0)   requiredMaterial = [...types][0];
      }
    }

    result.push({
      plateIndex: index,
      entryName,
      partsPerPlate,
      estPrintSecs,
      materialGrams,
      requiredMaterial,
      requiredColor,
      bedType,
    });
  }

  return result;
}

module.exports = { openThreeMf, detectProjectMetadata, parsePlateFilaments, extractPlates };
