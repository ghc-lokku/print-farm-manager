// Persistent printer event log — records decommission, recommission, job outcomes,
// and freeform operator notes. Events are never deleted.
// No FK constraint on printer_id — history survives printer deletion.

const db = require('./db');

const _insert = db.prepare(
  'INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, ?, ?, ?)'
);

function insert(printerId, eventType, note = null) {
  _insert.run(printerId, eventType, note ?? null, Date.now());
}

module.exports = { insert };
