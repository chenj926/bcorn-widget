'use strict';
// Separate private gradebook store. A timetable replacement/clear never touches it.
const fs = require('node:fs');
const path = require('node:path');
const GradeBook = require('./shared/grade-book');
const MAX_BYTES = 2 * 1024 * 1024;
function createGradeStore(directory) {
  const target = path.join(directory, 'grades-v1.json');
  function validate(book) {
    const text = JSON.stringify(book);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Gradebook exceeds the 2 MiB limit.');
    const result = GradeBook.validateBook(book);
    if (!result.ok) throw new Error(result.errors.map(e => e.message).join('\n'));
    return GradeBook.normalizeBook ? JSON.stringify(GradeBook.normalizeBook(book)) : text;
  }
  return Object.freeze({
    load() {
      let text;
      try { if (fs.statSync(target).size > MAX_BYTES) throw new Error('Gradebook exceeds the 2 MiB limit.'); text = fs.readFileSync(target, 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      const book = JSON.parse(text); validate(book); return book;
    },
    save(book) {
      const text = validate(book);
      fs.mkdirSync(directory, { recursive: true });
      const temporary = target + '.tmp';
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
      return { ok: true };
    }
  });
}
module.exports = { createGradeStore, MAX_BYTES };
