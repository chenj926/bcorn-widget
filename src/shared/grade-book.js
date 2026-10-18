/* Local assessment grades, separate from the authoritative ACORN transcript. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GradeBook = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EPSILON = 1e-9;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = v => JSON.parse(JSON.stringify(v));
  const validId = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);
  const numberPattern = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
  function failure(code, message) { return { ok: false, error: { code, message } }; }

  /** Plain numbers are ratios (0.8); percentages require %, or explicit percentage mode. */
  function parseGradeInput(input, mode) {
    if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) return { ok: true, score: null };
    if (typeof input !== 'string' && typeof input !== 'number') return failure('invalid-score', 'Enter a decimal, percentage, or earned/possible fraction.');
    if (typeof input === 'number') {
      const score = { mode: 'ratio', value: input / (mode === 'percentage' ? 100 : 1) };
      const error = validateScore(score);
      return error ? failure('invalid-score', error) : { ok: true, score };
    }
    const text = input.trim();
    const parts = text.split('/');
    let score;
    if (parts.length === 2 && parts.every(p => numberPattern.test(p.trim()))) {
      score = { mode: 'points', earned: Number(parts[0]), possible: Number(parts[1]) };
    } else if (text.endsWith('%') && numberPattern.test(text.slice(0, -1).trim())) {
      score = { mode: 'ratio', value: Number(text.slice(0, -1)) / 100 };
    } else if (numberPattern.test(text)) {
      score = { mode: 'ratio', value: Number(text) / (mode === 'percentage' ? 100 : 1) };
    } else return failure('invalid-score', 'Formula execution is not supported; enter e.g. 80%, 0.8, or 40/50.');
    const error = validateScore(score);
    return error ? failure('invalid-score', error) : { ok: true, score };
  }
  function validateScore(score) {
    if (!object(score)) return 'A graded assessment needs a score.';
    if (score.mode === 'ratio') {
      if (!finite(score.value) || score.value < 0 || score.value > 1) return 'The score must be between 0 and 100%; bonus marks need an explicit rule.';
    } else if (score.mode === 'points') {
      if (!finite(score.earned) || !finite(score.possible) || score.possible <= 0 || score.earned < 0 || score.earned > score.possible) return 'Points require 0 ≤ earned ≤ possible and a positive possible value; bonus marks need an explicit rule.';
    } else return 'Unknown score mode.';
    return null;
  }
  function ratio(score) { return score.mode === 'points' ? score.earned / score.possible : score.value; }
  function validateCourse(course) {
    const errors = [], warnings = [];
    if (!object(course)) return { ok: false, errors: [{ code: 'invalid-course', path: '', message: 'Course must be an object.' }], warnings };
    const fail = (path, message) => errors.push({ code: 'invalid-course', path, message });
    if (!validId(course.id)) fail('id', 'A stable course ID is required.');
    if (!Array.isArray(course.assessments) || course.assessments.length > 1000) fail('assessments', 'Use an array of at most 1000 assessments.');
    const seen = new Set();
    for (const [i, a] of (Array.isArray(course.assessments) ? course.assessments : []).entries()) {
      const path = `assessments[${i}]`;
      if (!object(a)) { fail(path, 'Assessment must be an object.'); continue; }
      if (!validId(a.id) || seen.has(a.id)) fail(path + '.id', 'Assessment IDs must be nonempty and unique.');
      seen.add(a.id);
      if (typeof a.title !== 'string' || !a.title.trim() || a.title.length > 1000) fail(path + '.title', 'An assessment title is required.');
      if (!finite(a.weight) || a.weight < 0 || a.weight > 1) fail(path + '.weight', 'Weight must be a finite ratio from 0 to 1.');
      if (!['ungraded', 'graded', 'exempt'].includes(a.status)) fail(path + '.status', 'Choose ungraded, graded, or exempt.');
      if (a.status === 'graded') { const error = validateScore(a.score); if (error) fail(path + '.score', error); }
      else if (a.score !== null && a.score !== undefined) fail(path + '.score', 'Ungraded/exempt assessments cannot carry a score.');
      if (a.status === 'exempt' && a.weight > 0) warnings.push({ code: 'exemption-rule-required', path, message: 'Explicitly redistribute the exempt weight according to the syllabus.' });
    }
    if (!course.rules || course.rules.kind !== 'weighted' || Object.keys(course.rules).some(k => k !== 'kind')) warnings.push({ code: 'grading-rule-required', message: 'Confirm ordinary weighted grading. Drop-lowest, bonus, replacement, and other rules cannot be inferred.' });
    if (!errors.length) {
      const total = course.assessments.reduce((sum, a) => sum + a.weight, 0);
      if (Math.abs(total - 1) > EPSILON) warnings.push({ code: 'incomplete-weights', message: `Weights total ${(total * 100).toFixed(4)}%; they have not been normalized.` });
    }
    return { ok: errors.length === 0, errors, warnings };
  }
  /** Metrics are ratios; multiply by 100 for percentage labels. No rounding of stored data. */
  function calculateCourse(course) {
    const validation = validateCourse(course);
    if (!validation.ok) return { ...validation, metrics: null };
    let earnedContribution = 0, gradedWeight = 0, pendingWeight = 0, exemptWeight = 0;
    for (const a of course.assessments) {
      if (a.status === 'graded') { earnedContribution += a.weight * ratio(a.score); gradedWeight += a.weight; }
      else if (a.status === 'ungraded') pendingWeight += a.weight;
      else exemptWeight += a.weight;
    }
    const provisional = validation.warnings.length > 0;
    return { ...validation, metrics: {
      currentAverage: gradedWeight > 0 ? earnedContribution / gradedWeight : null,
      earnedContribution, gradedWeight, pendingWeight, exemptWeight,
      totalWeight: gradedWeight + pendingWeight + exemptWeight,
      maximumFinal: provisional ? null : earnedContribution + pendingWeight,
      minimumFinal: provisional ? null : earnedContribution,
      provisional
    } };
  }
  function updateAssessment(course, id, changes) {
    if (!object(changes) || Object.prototype.hasOwnProperty.call(changes, 'id')) return failure('invalid-update', 'Assessment IDs cannot be changed.');
    if (!validateCourse(course).ok) return failure('invalid-course', 'Repair the course before editing it.');
    const index = course.assessments.findIndex(a => a.id === id);
    if (index < 0) return failure('not-found', 'Assessment not found.');
    const updated = clone(course);
    updated.assessments[index] = { ...updated.assessments[index], ...clone(changes) };
    const validation = validateCourse(updated);
    return validation.ok ? { ok: true, course: updated, warnings: validation.warnings } : { ...validation, course: null };
  }
  function validateBook(book) {
    const errors = [], warnings = [];
    if (!object(book) || book.schemaVersion !== 1 || !Array.isArray(book.courses) || book.courses.length > 500) return { ok: false, errors: [{ code: 'invalid-book', message: 'Expected version 1 gradebook with at most 500 courses.' }], warnings };
    const seen = new Set();
    for (const [i, course] of book.courses.entries()) {
      const checked = validateCourse(course);
      errors.push(...checked.errors.map(error => ({ ...error, path: `courses[${i}].${error.path || ''}` })));
      warnings.push(...checked.warnings);
      if (course && seen.has(course.id)) errors.push({ code: 'duplicate-course', message: 'Course IDs must be unique.' });
      if (course) seen.add(course.id);
    }
    return { ok: errors.length === 0, errors, warnings };
  }
  function normalizeBook(book) {
    const check = validateBook(book);
    if (!check.ok) throw new Error('Invalid gradebook; no data was saved.');
    const text = (value, fallback) => typeof value === 'string' ? value.slice(0, 1000) : fallback;
    return { schemaVersion: 1, courses: book.courses.map(course => ({
      id: course.id, title: text(course.title, course.id), termId: text(course.termId, ''),
      rules: { kind: course.rules && course.rules.kind === 'weighted' && Object.keys(course.rules).length === 1 ? 'weighted' : 'unconfirmed' },
      assessments: course.assessments.map(a => ({ id: a.id, title: a.title, weight: a.weight, status: a.status,
        score: a.status !== 'graded' ? null : a.score.mode === 'points' ? { mode: 'points', earned: a.score.earned, possible: a.score.possible } : { mode: 'ratio', value: a.score.value }
      }))
    })) };
  }
  return Object.freeze({ parseGradeInput, validateBook, normalizeBook, validateCourse, calculateCourse, updateAssessment });
}));
