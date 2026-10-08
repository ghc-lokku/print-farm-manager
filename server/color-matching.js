// Shared printer color matching logic for dispatch and diagnostics.
//
// Rules:
// - Keep existing behavior: printer.loaded_color is always a valid direct match.
// - For Bambu printers, also treat currently loaded AMS/external trays as printable
//   color inventory by mapping tray hex colors to Filament Library color names.
// - A required color can match by name (e.g. "Black") or by hex string
//   (e.g. "#000000" or "000000").

function normalizeText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.toLowerCase() : null;
}

function materialNamesMatch(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return !!left && !!right && left === right;
}

function normalizeHex(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(s)) return null;
  return s.length === 8 ? s.slice(0, 6) : s;
}

function colorAliases(value) {
  const aliases = new Set();
  const normalized = normalizeText(value);
  if (!normalized) return aliases;

  aliases.add(normalized);

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    for (let i = 0; i < tokens.length; i++) {
      aliases.add(tokens.slice(i).join(' '));
    }
    aliases.add(tokens[tokens.length - 1]);
  }

  const withoutBrand = normalized.replace(/^(?:bambu|sunlu|esun|elegoo|polymaker|prusa|creality|generic|orca|makerbot)\s+/i, '');
  if (withoutBrand !== normalized) aliases.add(withoutBrand);

  return aliases;
}

function colorNamesMatch(a, b) {
  if (a == null || b == null) return false;
  const left = colorAliases(a);
  const right = colorAliases(b);
  for (const name of left) {
    if (right.has(name)) return true;
  }
  return false;
}

function parseRequiredColors(requiredColor) {
  if (requiredColor == null || requiredColor === '') return [];
  if (Array.isArray(requiredColor)) {
    return requiredColor
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  const raw = String(requiredColor).trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => String(value).trim())
        .filter(Boolean);
    }
  } catch (_) {
    // Fall through to comma-delimited parsing below.
  }

  return raw
    .split(/[\n,|]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseRequiredBrand(requiredBrand) {
  const normalized = normalizeText(requiredBrand);
  return normalized || null;
}

function slotMatchesRequiredColor(slot, requiredName, requiredHex, requiredBrand, colorIndex) {
  const slotHex = normalizeHex(slot.color);
  if (!slotHex) return false;

  const slotBrand = normalizeText(slot.brand);
  if (requiredBrand && slotBrand && slotBrand !== requiredBrand) return false;

  if (requiredHex && requiredHex === slotHex) return true;

  if (!requiredName && !requiredBrand) return false;

  const typeName = normalizeText(slot.type);
  const typedNames = typeName
    ? colorIndex.byTypeAndHex.get(typeName)?.get(slotHex)
    : null;
  const names = typedNames || colorIndex.anyByHex.get(slotHex) || [];
  if (names.length === 0) return false;

  const requiredAliases = requiredName ? colorAliases(requiredName) : null;
  for (const entry of names) {
    if (requiredBrand && entry.brand && entry.brand !== requiredBrand) continue;
    if (!requiredAliases) return true;
    for (const alias of requiredAliases) {
      if (entry.aliases.has(alias)) return true;
    }
  }

  return false;
}

function buildFilamentColorIndex(db) {
  const anyByHex = new Map();            // hex -> Array<{ aliases:Set<string>, brand:string|null }>
  const byTypeAndHex = new Map();        // normalized type -> Map<hex, Array<{ aliases:Set<string>, brand:string|null }>>

  let rows = [];
  try {
    const colorColumns = db.prepare('PRAGMA table_info(filament_colors)').all().map((c) => c.name);
    const brandExpr = colorColumns.includes('brand') ? 'fc.brand' : 'NULL AS brand';
    rows = db.prepare(`
      SELECT ft.name AS type_name, fc.name AS color_name, ${brandExpr}, fc.hex_color
      FROM filament_colors fc
      JOIN filament_types ft ON ft.id = fc.type_id
      WHERE fc.hex_color IS NOT NULL AND fc.hex_color != ''
    `).all();
  } catch (_) {
    // Tests may use minimal schemas without filament tables.
    return { anyByHex, byTypeAndHex };
  }

  for (const row of rows) {
    const hex = normalizeHex(row.hex_color);
    const colorName = normalizeText(row.color_name);
    const typeName = normalizeText(row.type_name);
    const brandName = normalizeText(row.brand);
    if (!hex || !colorName) continue;

    const entry = { aliases: colorAliases(colorName), brand: brandName };

    if (!anyByHex.has(hex)) anyByHex.set(hex, []);
    anyByHex.get(hex).push(entry);

    if (!typeName) continue;
    if (!byTypeAndHex.has(typeName)) byTypeAndHex.set(typeName, new Map());
    const typedMap = byTypeAndHex.get(typeName);
    if (!typedMap.has(hex)) typedMap.set(hex, []);
    typedMap.get(hex).push(entry);
  }

  return { anyByHex, byTypeAndHex };
}

function createPrinterColorMatcher(db, printer) {
  const loadedColorName = normalizeText(printer.loaded_color);
  const loadedColorHex = normalizeHex(printer.loaded_color);

  let indexed = false;
  let trayColorNames = new Set();
  let trayColorHexes = new Set();

  function indexBambuTrays() {
    indexed = true;
    trayColorNames = new Set();
    trayColorHexes = new Set();

    if (printer.type !== 'bambu') return;

    let slots = [];
    try {
      const { getAmsSlots } = require('./drivers/bambu');
      slots = getAmsSlots(printer) || [];
    } catch (_) {
      slots = [];
    }

    if (slots.length === 0) return;

    const colorIndex = buildFilamentColorIndex(db);

    for (const slot of slots) {
      const slotHex = normalizeHex(slot.color);
      if (!slotHex) continue;

      trayColorHexes.add(slotHex);

      const typeName = normalizeText(slot.type);
      const typedNames = typeName
        ? colorIndex.byTypeAndHex.get(typeName)?.get(slotHex)
        : null;
      const names = typedNames || colorIndex.anyByHex.get(slotHex);
      if (!names) continue;
      for (const name of names) trayColorNames.add(name);
    }
  }

  return (requiredColor, requiredMaterial = null, requiredBrand = null) => {
    const requiredColors = parseRequiredColors(requiredColor);
    if (requiredColors.length === 0) return true;

    const requiredMaterialName = normalizeText(requiredMaterial);
    const requiredBrandName = parseRequiredBrand(requiredBrand);

    return requiredColors.every((value) => {
      const requiredName = normalizeText(value);
      const requiredHex = normalizeHex(value);

      // For non-Bambu printers, loaded_color remains authoritative.
      // For Bambu, we trust live tray telemetry first so stale manual fields do not
      // satisfy a color requirement when no matching tray is actually loaded.
      if (printer.type !== 'bambu') {
        if (requiredName && loadedColorName && colorNamesMatch(requiredName, loadedColorName)) return true;
        if (requiredHex && loadedColorHex && requiredHex === loadedColorHex) return true;
      }

      if (!indexed) indexBambuTrays();

      if (printer.type === 'bambu') {
        let slots = [];
        try {
          const { getAmsSlots } = require('./drivers/bambu');
          slots = getAmsSlots(printer) || [];
        } catch (_) {
          slots = [];
        }

        const colorIndex = buildFilamentColorIndex(db);
        const match = slots.find((slot) => {
          if (!slotMatchesRequiredColor(slot, requiredName, requiredHex, requiredBrandName, colorIndex)) return false;
          if (!requiredMaterialName) return true;
          return materialNamesMatch(slot.type, requiredMaterialName);
        });
        if (match) return true;

        return false;
      }

      const requiredAliases = colorAliases(requiredName);
      for (const name of requiredAliases) {
        if (requiredName && trayColorNames.has(name)) return true;
      }
      if (requiredHex && trayColorHexes.has(requiredHex)) return true;
      return false;
    });
  };
}

function createPrinterMaterialMatcher(db, printer) {
  const loadedMaterialName = normalizeText(printer.loaded_material);
  let indexed = false;
  let trayMaterialNames = new Set();

  function indexBambuTrayMaterials() {
    indexed = true;
    trayMaterialNames = new Set();

    if (printer.type !== 'bambu') return;

    let slots = [];
    try {
      const { getAmsSlots } = require('./drivers/bambu');
      slots = getAmsSlots(printer) || [];
    } catch (_) {
      slots = [];
    }

    for (const slot of slots) {
      const typeName = normalizeText(slot.type);
      if (!typeName) continue;
      trayMaterialNames.add(typeName);
    }
  }

  return (requiredMaterial) => {
    const requiredName = normalizeText(requiredMaterial);
    if (!requiredName) return true;

    if (printer.type !== 'bambu') {
      return materialNamesMatch(loadedMaterialName, requiredName);
    }

    if (!indexed) indexBambuTrayMaterials();
    return trayMaterialNames.has(requiredName);
  };
}

function pickBambuAmsSlotsForRequiredColors(db, printer, requiredColor, requiredMaterial = null, requiredBrand = null) {
  if (printer.type !== 'bambu') return [];

  const requiredColors = parseRequiredColors(requiredColor);
  if (requiredColors.length === 0) return [];

  let slots = [];
  try {
    const { getAmsSlots } = require('./drivers/bambu');
    slots = getAmsSlots(printer) || [];
  } catch (_) {
    slots = [];
  }

  if (slots.length === 0) return [];

  const colorIndex = buildFilamentColorIndex(db);
  const requiredMaterialName = normalizeText(requiredMaterial);
  const requiredBrandName = parseRequiredBrand(requiredBrand);
  const chosenSlots = [];
  const usedSlots = new Set();

  for (const value of requiredColors) {
    const requiredName = normalizeText(value);
    const requiredHex = normalizeHex(value);
    const matched = slots.find((slot) => {
      if (usedSlots.has(slot.slot)) return false;
      if (!slotMatchesRequiredColor(slot, requiredName, requiredHex, requiredBrandName, colorIndex)) return false;
      if (!requiredMaterialName) return true;
      return materialNamesMatch(slot.type, requiredMaterialName);
    });

    if (!matched) return [];
    chosenSlots.push(matched.slot);
    usedSlots.add(matched.slot);
  }

  return chosenSlots;
}

function pickBambuAmsSlotForRequiredColor(db, printer, requiredColor, requiredMaterial = null, requiredBrand = null) {
  const slots = pickBambuAmsSlotsForRequiredColors(db, printer, requiredColor, requiredMaterial, requiredBrand);
  return slots.length > 0 ? slots[0] : null;
}

module.exports = {
  createPrinterColorMatcher,
  createPrinterMaterialMatcher,
  pickBambuAmsSlotForRequiredColor,
  pickBambuAmsSlotsForRequiredColors,
};
