// 仅用于在浏览器里预览界面的假数据，Electron 里不会加载
(() => {
  const m = (code, title, section, day, start, end, location) => ({
    code, title, section, kind: section.slice(0, 3), day, start, end, location, delivery: 'INPER',
  });
  const c = (code, title, credits) => ({ code, title, credits });

  const fall = {
    id: '20269', name: '2026 秋季', start: '2026-09-02', end: '2026-12-05',
    courses: [
      c('CSC373H1', 'Algorithm Design, Analysis & Complexity', '0.50'),
      c('MAT237Y1', 'Multivariable Calculus with Proofs', '1.00'),
      c('STA247H1', 'Probability with Computer Applications', '0.50'),
      c('CSC369H1', 'Operating Systems', '0.50'),
      c('PHL245H1', 'Modern Symbolic Logic', '0.50'),
    ],
    meetings: [
      m('CSC373H1', 'Algorithm Design, Analysis & Complexity', 'LEC0101', 1, '10:00', '11:00', 'BA 1160'),
      m('CSC373H1', 'Algorithm Design, Analysis & Complexity', 'LEC0101', 3, '10:00', '11:00', 'BA 1160'),
      m('CSC373H1', 'Algorithm Design, Analysis & Complexity', 'TUT0201', 5, '10:00', '11:00', 'BA 2155'),
      m('MAT237Y1', 'Multivariable Calculus with Proofs', 'LEC0101', 2, '13:00', '14:00', 'MP 202'),
      m('MAT237Y1', 'Multivariable Calculus with Proofs', 'LEC0101', 4, '13:00', '15:00', 'MP 202'),
      m('MAT237Y1', 'Multivariable Calculus with Proofs', 'TUT0301', 3, '16:00', '17:00', 'BA 1240'),
      m('STA247H1', 'Probability with Computer Applications', 'LEC0101', 3, '13:00', '15:00', 'SS 2117'),
      m('STA247H1', 'Probability with Computer Applications', 'TUT0102', 5, '14:00', '15:00', 'SS 1086'),
      m('CSC369H1', 'Operating Systems', 'LEC5101', 2, '18:00', '20:00', 'BA 1130'),
      m('PHL245H1', 'Modern Symbolic Logic', 'LEC0101', 1, '15:00', '16:00', 'SS 2135'),
      m('PHL245H1', 'Modern Symbolic Logic', 'LEC0101', 3, '15:00', '16:00', 'SS 2135'),
      m('PHL245H1', 'Modern Symbolic Logic', 'TUT0104', 4, '11:00', '12:00', 'UC 179'),
    ],
  };

  const winter = {
    id: '20271', name: '2027 冬季', start: '2027-01-05', end: '2027-04-10',
    courses: [
      c('MAT237Y1', 'Multivariable Calculus with Proofs', '1.00'),
      c('CSC343H1', 'Introduction to Databases', '0.50'),
      c('CSC384H1', 'Introduction to Artificial Intelligence', '0.50'),
      c('STA261H1', 'Probability and Statistics II', '0.50'),
    ],
    meetings: [
      m('MAT237Y1', 'Multivariable Calculus with Proofs', 'LEC0101', 2, '13:00', '14:00', 'MP 202'),
      m('MAT237Y1', 'Multivariable Calculus with Proofs', 'LEC0101', 4, '13:00', '15:00', 'MP 202'),
      m('MAT237Y1', 'Multivariable Calculus with Proofs', 'TUT0301', 3, '16:00', '17:00', 'BA 1240'),
      m('CSC343H1', 'Introduction to Databases', 'LEC0201', 1, '11:00', '13:00', 'BA 1180'),
      m('CSC343H1', 'Introduction to Databases', 'TUT0201', 3, '11:00', '12:00', 'BA 2165'),
      m('CSC384H1', 'Introduction to Artificial Intelligence', 'LEC0101', 2, '15:00', '17:00', 'BA 1170'),
      m('CSC384H1', 'Introduction to Artificial Intelligence', 'TUT0101', 4, '16:00', '17:00', 'BA 2175'),
      m('STA261H1', 'Probability and Statistics II', 'LEC0101', 5, '10:00', '12:00', 'SS 2102'),
    ],
  };

  // iCal 给的是每节课的起止日期和停课日；这里简单地铺满整个学期，秋季 Reading Week 停课
  for (const t of [fall, winter]) {
    for (const x of t.meetings) Object.assign(x, { from: t.start, until: t.end, exdates: t === fall ? ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'] : [] });
  }

  const g = (code, title, weight, mark, grade, avg) => ({ code, title, weight, mark, grade, avg });
  const transcript = {
    cgpa: '3.68',
    sessions: [
      {
        name: '2025 秋季', sessionalGpa: '3.71', cumulativeGpa: '3.71', average: '82.4',
        courses: [
          g('CSC110Y1', 'Foundations of Computer Science I', '1.00', '86', 'A', 'B'),
          g('MAT137Y1', 'Calculus with Proofs', '1.00', '', 'IPR', ''),
          g('ECO101H1', 'Principles of Microeconomics', '0.50', '78', 'B+', 'B-'),
          g('PSY100H1', 'Introductory Psychology', '0.50', '81', 'A-', 'B'),
        ],
      },
      {
        name: '2026 冬季', sessionalGpa: '3.64', cumulativeGpa: '3.67', average: '81.0',
        notes: ["Dean's List Scholar"],
        courses: [
          g('CSC111H1', 'Foundations of Computer Science II', '0.50', '89', 'A', 'B'),
          g('MAT137Y1', 'Calculus with Proofs', '1.00', '77', 'B+', 'C+'),
          g('ECO102H1', 'Principles of Macroeconomics', '0.50', '74', 'B', 'B-'),
          g('STA130H1', 'An Introduction to Statistical Reasoning and Data Science', '0.50', '91', 'A+', 'B'),
        ],
      },
      {
        name: '2026 夏季', sessionalGpa: '3.70', cumulativeGpa: '3.68', average: '82.0',
        courses: [g('CSC236H1', 'Introduction to the Theory of Computation', '0.50', '82', 'A-', 'B-')],
      },
      {
        name: '2026 秋季',
        courses: fall.courses.map((x) => g(x.code, x.title, x.credits, '', 'IPR', '')),
      },
    ],
  };

  const data = { fetchedAt: new Date().toISOString(), terms: [fall, winter], transcript };
  const noop = () => {};
  window.acornMock = {
    getState: async () => ({ data, status: { state: 'ok' }, pinned: false }),
    refresh: noop, login: noop, togglePin: noop, hide: noop, openMenu: noop, onUpdate: noop, onPinned: noop,
  };
})();
