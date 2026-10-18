/* Portable user data only. Remote ownership, credentials and journals never cross this boundary. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./course-tools'), require('./grade-book'));
  else root.UserBackup = factory(root.CourseTools, root.GradeBook);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Courses, Grades) {
  'use strict';
  const FORMAT = 'bcorn-user-backup', VERSION = 1, MAX_BYTES = 5 * 1024 * 1024;
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const PREFS = Object.freeze({ tab: ['today', 'term', 'grades'], 'map-provider': ['google', 'amap'] });
  function preferences(value = {}) {
    if (!object(value)) throw new Error('备份偏好设置必须是对象。');
    const result = {};
    for (const [key, allowed] of Object.entries(PREFS)) {
      if (value[key] === undefined || value[key] === null) continue;
      if (!allowed.includes(value[key])) throw new Error('无效的本地偏好设置：' + key);
      result[key] = value[key];
    }
    return result;
  }
  function parse(input) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('完整备份不能超过 5 MiB。');
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!object(raw)) throw new Error('JSON 必须是对象。');
    const envelope = Object.hasOwn(raw, 'format') || Object.hasOwn(raw, 'backupVersion');
    if (envelope && (raw.format !== FORMAT || raw.backupVersion !== VERSION)) throw new Error('不支持此备份格式或版本。');
    const checked = Courses.validateImport(envelope ? raw.timetable : raw);
    if (!checked.ok) throw new Error(checked.errors.join('\n'));
    let gradebook = null;
    if (envelope) {
      if (new TextEncoder().encode(JSON.stringify(raw.gradebook) || '').length > 2 * 1024 * 1024) throw new Error('作业成绩部分不能超过 2 MiB。');
      const valid = Grades.validateBook(raw.gradebook);
      if (!valid.ok) throw new Error(valid.errors.map(e => e.message).join('\n'));
      gradebook = Grades.normalizeBook(raw.gradebook);
    }
    return { kind: envelope ? 'backup' : 'legacy', timetable: checked.data, gradebook,
      preferences: envelope ? preferences(raw.preferences) : {}, warnings: checked.warnings };
  }
  function create(timetable, gradebook, prefs) {
    const clean = parse({ format: FORMAT, backupVersion: VERSION, timetable: timetable || { terms: [] }, gradebook, preferences: prefs });
    return { format: FORMAT, backupVersion: VERSION, createdAt: new Date().toISOString(), timetable: clean.timetable, gradebook: clean.gradebook, preferences: clean.preferences };
  }
  /** Validate before any I/O. Compensate even a rejected write (its outcome may be uncertain).
   * Hosts expose separate atomic files, not a cross-file transaction. Rollback failures are explicit.
   */
  async function restore(input, io, options = {}) {
    const plan = parse(input);
    const replaceGrades = plan.kind === 'backup' && options.replaceGrades === true;
    const writes = [];
    if (replaceGrades) writes.push({ name: '作业成绩', save: io.saveGrades, before: await io.loadGrades(), after: plan.gradebook });
    writes.push({ name: '课表', save: io.saveTimetable, before: await io.loadTimetable(), after: plan.timetable });
    if (plan.kind === 'backup') writes.push({ name: '偏好设置', save: io.savePreferences, before: await io.loadPreferences(), after: plan.preferences });
    const attempted = [];
    try {
      for (const entry of writes) { attempted.push(entry); await entry.save(entry.after); }
    } catch (error) {
      const failed = [];
      for (const entry of attempted.reverse()) { try { await entry.save(entry.before); } catch (_) { failed.push(entry.name); } }
      if (failed.length) throw new Error(`导入失败，${failed.join('、')}回滚未确认成功。请保留备份并重新导入恢复；不要继续编辑。原错误：${error.message}`);
      throw new Error('导入失败，已恢复原本地数据：' + error.message);
    }
    return plan;
  }
  return Object.freeze({ FORMAT, VERSION, MAX_BYTES, PREFS, parse, create, restore, preferences });
}));
