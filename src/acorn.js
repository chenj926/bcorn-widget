// ACORN 没有公开 API，这里调用的是 ACORN 网页自己用的内部接口（只读）：
//   课程列表   /sws/rest/enrolment/eligible-registrations + /sws/rest/enrolment/course/enrolled-courses
//   上课时间   /sws/rest/timetable/export-iCalEvents（"Timetable & Exams" 页的日历导出，带真实日期和停课日）
//   成绩单     /sws/rest/history/academic/complete（"Academic History" 页的完整版，HTML 片段）
// 所有请求都走登录窗口同一个 session，所以会自动带上登录后的 cookie。

const BASE = 'https://acorn.utoronto.ca';
const HOME = `${BASE}/sws/`;

class LoginRequired extends Error {
  constructor() {
    super('需要登录 ACORN');
    this.code = 'LOGIN_REQUIRED';
  }
}

function isAcornAppUrl(url) {
  try {
    const u = new URL(url);
    return u.host === 'acorn.utoronto.ca' && u.pathname.startsWith('/sws');
  } catch {
    return false;
  }
}

async function request(ses, pathAndQuery) {
  const res = await ses.fetch(BASE + pathAndQuery, {
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  // 会话过期时 ACORN 会把请求重定向到 UofT 登录页（一个 text/html 页面）。
  // Electron 的 fetch 不填 res.url，所以主要靠 content-type 判断。
  const landed = res.url ? new URL(res.url).host : 'acorn.utoronto.ca';
  const type = res.headers.get('content-type') || '';
  if (landed !== 'acorn.utoronto.ca' || res.status === 401 || res.status === 403 || type.startsWith('text/html')) {
    throw new LoginRequired();
  }
  if (!res.ok) throw new Error(`ACORN 返回 ${res.status}（${pathAndQuery.split('?')[0]}）`);
  return res;
}

const getJSON = async (ses, p) => (await request(ses, p)).json();
const getText = async (ses, p) => (await request(ses, p)).text();

async function isLoggedIn(ses) {
  try {
    await getJSON(ses, '/sws/rest/enrolment/eligible-registrations');
    return true;
  } catch (err) {
    if (err.code === 'LOGIN_REQUIRED') return false;
    throw err;
  }
}

// ---- 学期 ----
// 学期 id 用 ACORN 的 sessionCode 规则：年份 + 9（秋）/ 1（冬）/ 5（夏）。

const SEASONS = {
  9: { zh: '秋季', months: [9, 12] },
  1: { zh: '冬季', months: [1, 4] },
  5: { zh: '夏季', months: [5, 8] },
};

const seasonOfMonth = (month) => (month >= 9 ? 9 : month >= 5 ? 5 : 1);

function termShell(id) {
  const year = Number(id.slice(0, 4));
  const season = SEASONS[id.slice(4)];
  const [m1, m2] = season.months;
  const lastDay = new Date(Date.UTC(year, m2, 0)).getUTCDate();
  return {
    id,
    name: `${year} ${season.zh}`,
    bounds: [`${year}-${pad(m1)}-01`, `${year}-${pad(m2)}-${lastDay}`],
    courses: [],
    meetings: [],
  };
}

// ACORN 的一次注册：20269 = 2026 秋 + 2027 冬（F/S/Y 三种课段），20265 = 2026 夏
function termIdsForCourse(sessionCode, sectionCode) {
  const year = Number(String(sessionCode).slice(0, 4));
  if (String(sessionCode).endsWith('5')) return [`${year}5`];
  if (String(sessionCode).endsWith('1')) return [`${year}1`];
  if (sectionCode === 'Y') return [`${year}9`, `${year + 1}1`];
  return [sectionCode === 'S' ? `${year + 1}1` : `${year}9`];
}

// ---- iCal 课表 ----

const pad = (n) => String(n).padStart(2, '0');
const icalDate = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
const icalTime = (v) => `${v.slice(9, 11)}:${v.slice(11, 13)}`;
const icalText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const isoDayOf = (ymd) => ((new Date(`${ymd}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
const BYDAY = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function parseICal(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); // 先展开折行
  const meetings = [];
  let ev = null;
  let inAlarm = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = { exdates: [] };
    else if (line === 'BEGIN:VALARM') inAlarm = true;
    else if (line === 'END:VALARM') inAlarm = false;
    else if (line === 'END:VEVENT') {
      if (ev?.start) meetings.push(...meetingsFromEvent(ev));
      ev = null;
    } else if (ev && !inAlarm) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).split(';')[0];
      const value = line.slice(colon + 1);
      if (name === 'SUMMARY') ev.summary = icalText(value);
      else if (name === 'DESCRIPTION') ev.description = icalText(value);
      else if (name === 'LOCATION') ev.location = icalText(value);
      else if (name === 'DTSTART') ev.start = value;
      else if (name === 'DTEND') ev.end = value;
      else if (name === 'RRULE') ev.rrule = Object.fromEntries(value.split(';').map((kv) => kv.split('=')));
      else if (name === 'EXDATE') ev.exdates.push(...value.split(',').map(icalDate));
    }
  }
  return meetings;
}

function meetingsFromEvent(ev) {
  const [code = '', section = ''] = (ev.summary || '').trim().split(/\s+/);
  const [title = '', building = ''] = (ev.description || '').split('\n');
  const from = icalDate(ev.start);
  const until = ev.rrule?.UNTIL ? icalDate(ev.rrule.UNTIL) : from;
  const days = ev.rrule?.BYDAY ? ev.rrule.BYDAY.split(',').map((d) => BYDAY[d.slice(-2)]) : [isoDayOf(from)];
  return days.map((day) => ({
    code,
    title: title.trim(),
    kind: section.replace(/\d+$/, ''),
    section,
    day,
    start: icalTime(ev.start),
    end: icalTime(ev.end || ev.start),
    location: (ev.location || '').trim(),
    building: building.trim(),
    from,
    until,
    exdates: ev.exdates,
  }));
}

// 一节课的日期范围可能跨学期（全年课），按月份把它放进经过的每个学期
function termIdsForRange(from, until) {
  const ids = new Set();
  let [y, m] = from.split('-').map(Number);
  const [y2, m2] = until.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) {
    ids.add(`${y}${seasonOfMonth(m)}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return [...ids];
}

async function fetchTerms(ses) {
  const terms = {};
  const term = (id) => (terms[id] ??= termShell(id));

  // 1. 已选课程（含没有固定上课时间的课）和学分
  const registrations = await getJSON(ses, '/sws/rest/enrolment/eligible-registrations');
  for (const reg of registrations) {
    const query = new URLSearchParams(reg.registrationParams).toString();
    const enrolled = await getJSON(ses, `/sws/rest/enrolment/course/enrolled-courses?${query}`);
    for (const course of enrolled.APP || []) {
      for (const id of termIdsForCourse(course.sessionCode || reg.sessionCode, course.sectionCode)) {
        term(id).courses.push({ code: course.code, title: titleCase(course.title), credits: course.courseCredits });
      }
    }
  }

  // 2. 上课时间
  const meetings = parseICal(await getText(ses, '/sws/rest/timetable/export-iCalEvents'));
  for (const m of meetings) {
    for (const id of termIdsForRange(m.from, m.until)) {
      const t = term(id);
      t.meetings.push(m);
      const course = t.courses.find((c) => c.code === m.code);
      if (!course) t.courses.push({ code: m.code, title: m.title, credits: '' });
      else if (m.title) course.title = m.title; // iCal 里的课名大小写更好看
    }
  }

  // 学期起止：有上课时间就用真实日期，否则用学期所在月份
  return Object.values(terms)
    .map(({ bounds, ...t }) => {
      const inside = (d) => d >= bounds[0] && d <= bounds[1];
      const froms = t.meetings.map((m) => (inside(m.from) ? m.from : bounds[0]));
      const untils = t.meetings.map((m) => (inside(m.until) ? m.until : bounds[1]));
      return {
        ...t,
        start: froms.length ? froms.sort()[0] : bounds[0],
        end: untils.length ? untils.sort().at(-1) : bounds[1],
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

// ---- 成绩单 ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const htmlText = (s) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m,
    );

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', '&']);
const ROMAN = /^(i|ii|iii|iv|v|vi)$/i;

// 成绩单里的课名是全大写缩写（"CALCULUS FOR ENGINEERS I"），转成正常大小写
function titleCase(title = '') {
  if (title !== title.toUpperCase()) return title;
  return title
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      if (ROMAN.test(w)) return w.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.replace(/(^|[-/.(&])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    })
    .join(' ');
}

function parseTranscript(html) {
  const blocks = [...html.matchAll(/<(h3|h4|p|div)\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/gi)].map(([, , cls, inner]) => ({
    cls,
    text: htmlText(inner),
  }));
  const sessions = [];
  let cur = null;

  for (const { cls, text } of blocks) {
    if (/\binfo-section\b/.test(cls)) {
      // 学期标题形如 "2025 Fall - BASc - ..."；之前的 Registration History 段落跳过
      const m = /^(\d{4}) (Fall|Winter|Summer) - /.exec(text.trim());
      if (m) {
        cur = { name: `${m[1]} ${SEASONS[{ Fall: 9, Winter: 1, Summer: 5 }[m[2]]].zh}`, courses: [], info: [], notes: [] };
        sessions.push(cur);
      } else {
        cur?.info.push(text.trim().replace(/\s+/g, ' '));
      }
    } else if (cur && /\bgpa-listing\b/.test(cls)) {
      const pick = (re) => re.exec(text)?.[1];
      if (/GPA|Average/.test(text)) {
        cur.sessionalGpa ??= pick(/Sessional GPA\s+([\d.]+)/);
        cur.annualGpa ??= pick(/Annual GPA\s+([\d.]+)/);
        cur.cumulativeGpa ??= pick(/Cumulative GPA\s+([\d.]+)/);
        cur.average ??= pick(/Sessional % Average\s+([\d.]+)/);
      } else {
        cur.notes.push(text.trim().replace(/\s+/g, ' '));
      }
    } else if (cur && /\bcourses\b/.test(cls)) {
      // 固定宽度的一行：课号  课名  学分  分数  等级  课程均分
      for (const line of text.split('\n')) {
        const m = /^\s*(\S+)\s+(.+?)\s+(\d+\.\d\d)\b(.*)$/.exec(line);
        if (!m) continue;
        const rest = m[4].trim().split(/\s+/).filter(Boolean);
        const mark = /^\d+$/.test(rest[0] || '') ? rest.shift() : '';
        const grade = rest.shift() || '';
        const avg = rest.shift() || '';
        cur.courses.push({ code: m[1], title: titleCase(m[2].trim()), weight: m[3], mark, grade, avg: avg === '*' ? '' : avg });
      }
    }
  }

  // 例行状态（"Status: Pass"、"May proceed"）和每学期都重复的项目名不算备注，
  // 留下的是 Dean's List、学术警告这类值得看一眼的
  const withCourses = sessions.filter((s) => s.courses.length);
  const seen = {};
  for (const s of withCourses) for (const line of new Set(s.info)) seen[line] = (seen[line] || 0) + 1;
  const routine = /^(status: pass|may proceed|in good standing)$/i;
  const result = withCourses.map(({ info, ...s }) => ({
    ...s,
    notes: [...s.notes, ...info.filter((line) => seen[line] <= withCourses.length / 2)].filter((line) => !routine.test(line)),
  }));

  const latest = [...result].reverse();
  return {
    sessions: result,
    cgpa: latest.find((s) => s.cumulativeGpa)?.cumulativeGpa ?? null,
  };
}

async function fetchTranscript(ses) {
  return parseTranscript(await getText(ses, '/sws/rest/history/academic/complete'));
}

// ---- 汇总 ----

async function fetchAll(ses, previous, log = () => {}) {
  const terms = await fetchTerms(ses);
  let transcript = previous?.transcript ?? null;
  try {
    transcript = await fetchTranscript(ses);
    // 成绩单里的课名是缩写（"Optimizat. in Machine Learning"），有课表全名的就换成全名
    const fullTitles = new Map(terms.flatMap((t) => t.courses.map((c) => [c.code, c.title])));
    for (const s of transcript.sessions) for (const c of s.courses) c.title = fullTitles.get(c.code) || c.title;
  } catch (err) {
    if (err.code === 'LOGIN_REQUIRED') throw err;
    log('transcript failed:', err);
  }
  return { fetchedAt: new Date().toISOString(), terms, transcript };
}

module.exports = { HOME, isAcornAppUrl, isLoggedIn, fetchAll, parseICal, parseTranscript };
