'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Grades = require('../src/shared/grade-book');
const assessment = (id, weight, score) => ({ id, title: id, weight, status: score === null ? 'ungraded' : 'graded', score: score === null ? null : { mode: 'ratio', value: score } });
const course = assessments => ({ id: 'synthetic-course', title: 'Synthetic course', rules: { kind: 'weighted' }, assessments });
test('ungraded and genuine zero are distinct; three headline metrics use graded weight', () => {
 const result = Grades.calculateCourse(course([assessment('a', .1, .8), assessment('b', .2, 0), assessment('c', .7, null)]));
 assert.ok(result.ok); assert.ok(Math.abs(result.metrics.currentAverage - .08 / .3) < 1e-12);
 assert.ok(Math.abs(result.metrics.earnedContribution - .08) < 1e-12);
 assert.equal(result.metrics.pendingWeight, .7); assert.ok(Math.abs(result.metrics.maximumFinal - .78) < 1e-12);
});
test('all ungraded shows unknown average, never zero or NaN', () => {
 const m = Grades.calculateCourse(course([assessment('a', 1, null)])).metrics;
 assert.equal(m.currentAverage, null); assert.equal(m.pendingWeight, 1); assert.equal(m.maximumFinal, 1);
});
test('decimal percentage and earned/possible parse without executing formulas', () => {
 for (const input of ['81%', '.81', '40.5/50', '81.0%']) { const result = Grades.parseGradeInput(input); assert.ok(result.ok); }
 assert.deepEqual(Grades.parseGradeInput('40.5/50').score, { mode: 'points', earned: 40.5, possible: 50 });
 assert.equal(Grades.parseGradeInput('81', 'percentage').score.value, .81);
 for (const input of ['=40/50', '=IMPORTXML("secret")', '40/0', '-1', 'Infinity', 'NaN', '101%', '80', '1e2', [], {}]) assert.equal(Grades.parseGradeInput(input).ok, false, String(input));
 assert.equal(Grades.parseGradeInput('').score, null); assert.equal(Grades.parseGradeInput('0').score.value, 0);
});
test('weights are never guessed or normalized; unsupported rules disable final projections', () => {
 const partial = course([assessment('a', .2, .5)]);
 let result = Grades.calculateCourse(partial); assert.equal(result.metrics.currentAverage, .5); assert.equal(result.metrics.maximumFinal, null);
 assert.ok(result.warnings.some(w => w.code === 'incomplete-weights'));
 partial.assessments[0].weight = 1; partial.rules.dropLowest = 1;
 result = Grades.calculateCourse(partial); assert.equal(result.metrics.provisional, true); assert.equal(result.metrics.maximumFinal, null);
 partial.rules = { kind: 'bonus' }; assert.equal(Grades.calculateCourse(partial).metrics.maximumFinal, null);
});
test('invalid/nonfinite weights, missing scores, duplicates, bonus and negative values fail', () => {
 for (const weight of [NaN, Infinity, -.1, 2, '.5']) assert.equal(Grades.validateCourse(course([assessment('a', weight, .5)])).ok, false);
 assert.equal(Grades.validateCourse(course([assessment('a', .5, .5), assessment('a', .5, .5)])).ok, false);
 const a = assessment('a', 1, .5); a.score = null; assert.equal(Grades.validateCourse(course([a])).ok, false);
 a.score = { mode: 'points', earned: 11, possible: 10 }; assert.equal(Grades.validateCourse(course([a])).ok, false);
});
test('exemption requires explicit redistribution; scores cannot hide on ungraded items', () => {
 const c = course([{ ...assessment('a', 1, null), status: 'exempt' }]);
 assert.equal(Grades.calculateCourse(c).metrics.maximumFinal, null);
 c.assessments[0].score = { mode: 'ratio', value: 0 }; assert.equal(Grades.validateCourse(c).ok, false);
});
test('immutable editing keeps IDs and original data; normalization strips unknown/private fields', () => {
 const c = course([assessment('a', 1, null)]);
 const updated = Grades.updateAssessment(c, 'a', { status: 'graded', score: { mode: 'points', earned: 0, possible: 10 } });
 assert.ok(updated.ok); assert.equal(c.assessments[0].status, 'ungraded');
 assert.equal(Grades.updateAssessment(c, 'a', { id: 'other' }).ok, false);
 const normalized = Grades.normalizeBook({ schemaVersion: 1, secret: 'test-only-placeholder', courses: [{ ...c, token: 'test-only-placeholder', rules: { kind: 'weighted', dropLowest: 1 } }] });
 assert.equal(normalized.secret, undefined); assert.equal(normalized.courses[0].token, undefined); assert.equal(normalized.courses[0].rules.kind, 'unconfirmed');
 assert.throws(() => Grades.normalizeBook({ schemaVersion: 2, courses: [] }));
});
test('all assessments contribute; totals do not rely on hard-coded spreadsheet row ranges', () => {
 const c = course(Array.from({ length: 20 }, (_, i) => assessment('a' + i, .05, i === 19 ? 1 : 0)));
 const result = Grades.calculateCourse(c); assert.ok(Math.abs(result.metrics.earnedContribution - .05) < 1e-12); assert.equal(result.warnings.length, 0);
});
