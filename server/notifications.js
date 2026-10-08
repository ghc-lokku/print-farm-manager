// In-memory notification store — survives as long as the server process is running.
// Notifications are lost on restart, which is fine: actionable errors will recur
// naturally on the next dispatch attempt if the underlying issue hasn't been fixed.

let _nextId = 1;
const _store = [];

function add(message) {
  const note = { id: _nextId++, message, timestamp: Date.now() };
  _store.push(note);
  console.warn(`[notifications] ${message}`);
  return note;
}

function list() {
  return [..._store].reverse(); // newest first
}

function dismiss(id) {
  const idx = _store.findIndex(n => n.id === id);
  if (idx === -1) return false;
  _store.splice(idx, 1);
  return true;
}

module.exports = { add, list, dismiss };
