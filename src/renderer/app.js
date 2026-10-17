'use strict';

const WEEKDAY = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PALETTE = [212, 152, 28, 338, 262, 188, 96, 8];

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  },
};

const localId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const isoDay = (d) => ((d.getUTCDay() + 6) % 7) + 1;
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return h * 60 + m;
};
const clock = (min) => `${Math.floor(min / 60)}:${pad(min % 60)}`;
const fmtDate = (s) => {
  const [, m, d] = s.split('-').map(Number);
  return `${m}月${d}日`;
};
const fmtSpan = (mins) =>
  mins < 60 ? `${mins} 分钟` : `${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分钟` : ''}`;
const inTerm = (t, d) => !!(t.start && t.end) && ymd(d) >= t.start && ymd(d) <= t.end;
// 同一学期里按课程顺序取色，保证一学期内不撞色
const hueFor = (term, code) => PALETTE[Math.max(0, term.courses.findIndex((c) => c.code === code)) % PALETTE.length];
const empty = (title, sub = '') =>
  `<div class="empty"><div class="empty-title">${esc(title)}</div>${sub ? `<div class="empty-sub">${esc(sub)}</div>` : ''}</div>`;

const ui = { data: null, dataError: null, status: { state: 'idle' }, pinned: false, tab: store.get('tab', 'today'), termId: null, selectedDate: null, courseListOpen: false, selecting: false };
let bridge;
let preview = false;
const selected = new Set();
const timed = (m) => Number.isInteger(m.day) && m.day >= 1 && m.day <= 7 && /^([01]\d|2[0-3]):[0-5]\d$/.test(m.start || '') && /^([01]\d|2[0-3]):[0-5]\d$/.test(m.end || '') && toMin(m.end) > toMin(m.start);
const waiting = (course, meeting) => window.CourseTools.isWaitlisted(course) || window.CourseTools.isWaitlisted(meeting);
const waitTag = (yes) => yes ? '<span class="status-tag">候补</span>' : '';
const place = (m) => m.room || m.location || '';
const itemAttrs = (term, code, index, occurrenceDate = null, displayDate = null) => `data-course="${esc(code)}" data-course-term="${esc(term)}"${index == null ? '' : ` data-meeting="${index}"`}${occurrenceDate ? ` data-occurrence-date="${esc(occurrenceDate)}"` : ''}${displayDate ? ` data-display-date="${esc(displayDate)}"` : ''} role="button" tabindex="0"`;
let displayTimezone = 'America/Toronto';
const timezoneFormatters = new Map();
function wallClock(instant, timezone = displayTimezone) {
  if (!timezoneFormatters.has(timezone)) timezoneFormatters.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  const values = Object.fromEntries(timezoneFormatters.get(timezone).formatToParts(instant).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  // UTC fields carry civil time without the device timezone normalizing DST gaps.
  // This is not an instant; always use UTC calendar getters/setters on the carrier.
  return new Date(Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second));
}
const activeTerm = (instant = new Date()) => ui.data?.terms.find((t) => t.id === ui.termId) || ui.data?.terms.find((t) => inTerm(t, wallClock(instant, t.timezone || 'America/Toronto'))) || ui.data?.terms.find((t) => t.start > ymd(wallClock(instant, t.timezone || 'America/Toronto'))) || ui.data?.terms.at(-1);

// ---- 今天 ----

// 这一天是否真的上课：星期对得上、在起止日期内、不是停课日（Reading Week、假期）
const occursOn = (m, d) =>
  (m.recurrence === 'once' ? m.date === ymd(d) : m.day === isoDay(d)) && (!m.from || ymd(d) >= m.from) && (!m.until || ymd(d) <= m.until) && !(m.exdates || []).includes(ymd(d));

function classesOn(terms, d) {
  const seen = new Set();
  const date = ymd(d);
  const items = terms.flatMap((term) => {
    const timezone = term.timezone || 'America/Toronto';
    const matches = [];
    // Most terms share a timezone. For mixed-zone imports, convert the neighboring
    // source dates into the chosen display day instead of treating wall times as equal.
    const dates = timezone === displayTimezone ? [d] : [-1, 0, 1].map((offset) => {
      const candidate = new Date(d); candidate.setUTCDate(candidate.getUTCDate() + offset); return candidate;
    });
    for (const sourceDate of dates) {
      if (!inTerm(term, sourceDate)) continue;
      term.meetings.forEach((m, index) => {
        if (!timed(m) || !window.CourseTools.occursOn(term, m, ymd(sourceDate))) return;
        let s = toMin(m.start), e = toMin(m.end);
        if (timezone !== displayTimezone) {
          try {
            const start = wallClock(window.CourseTools.localToUtc(ymd(sourceDate), m.start, timezone));
            const end = wallClock(window.CourseTools.localToUtc(ymd(sourceDate), m.end, timezone));
            if (ymd(start) !== date) return;
            s = start.getUTCHours() * 60 + start.getUTCMinutes();
            e = end.getUTCHours() * 60 + end.getUTCMinutes() + (ymd(end) > date ? 1440 : 0);
          } catch { return; } // An impossible DST wall time has no occurrence.
        }
        matches.push({ ...m, occurrenceDate: ymd(sourceDate), displayDate: date, type: term.courses.find((c) => c.code === m.code)?.type || 'course', termId: term.id, index, s, e, h: hueFor(term, m.code), waitlisted: waiting(term.courses.find((c) => c.code === m.code), m) });
      });
    }
    return matches;
  });
  return items.filter((m) => {
    const key = JSON.stringify([m.termId, m.code, m.section, m.s, m.e]);
    return !seen.has(key) && seen.add(key);
  }).sort((a, b) => a.s - b.s);
}

function nextClassHint(terms, now) {
  for (let offset = 1; offset <= 14; offset++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + offset);
    const [first] = classesOn(terms, d);
    if (first) {
      const weeksAhead = Math.floor((offset + isoDay(now) - 1) / 7);
      const when =
        offset === 1 ? '明天'
        : weeksAhead === 0 ? WEEKDAY[isoDay(d)]
        : weeksAhead === 1 ? `下${WEEKDAY[isoDay(d)]}`
        : `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
      return `下一节：${when} ${clock(first.s)} ${first.code}`;
    }
  }
  return '';
}

function heroCard(m, label, when, progress) {
  return `<div class="hero ${m.waitlisted ? 'waitlisted' : ''}" ${itemAttrs(m.termId, m.code, m.index, m.occurrenceDate, m.displayDate)} style="--h:${m.h}">
    <div class="hero-top"><span class="hero-label">${label}</span><span class="hero-when">${when}</span></div>
    <div class="hero-code">${esc(m.type === 'event' ? m.title : m.code)}${m.section ? `<span class="tag">${esc(m.section)}</span>` : ''}${waitTag(m.waitlisted)}</div>
    <div class="hero-title">${esc(m.title)}</div>
    <div class="hero-meta"><span>${clock(m.s)}–${clock(m.e)}</span>${place(m) ? `<span>${esc(place(m))}</span>` : ''}</div>
    ${progress == null ? '' : `<div class="progress"><i style="width:${progress}%"></i></div>`}
  </div>`;
}

function slot(m, nowMin) {
  const state = m.e <= nowMin ? 'past' : m.s <= nowMin ? 'now' : '';
  return `<li class="slot ${state} ${m.waitlisted ? 'waitlisted' : ''}" ${itemAttrs(m.termId, m.code, m.index, m.occurrenceDate, m.displayDate)} style="--h:${m.h}">
    <div class="slot-time"><span>${clock(m.s)}</span><span>${clock(m.e)}</span></div>
    <div class="slot-bar"></div>
    <div>
      <div class="slot-title">${esc(m.type === 'event' ? m.title : m.code)}${m.section ? `<span class="tag">${esc(m.section)}</span>` : ''}${waitTag(m.waitlisted)}</div>
      <div class="slot-sub">${esc([place(m), m.title].filter(Boolean).join(' · '))}</div>
    </div>
  </li>`;
}

const selectedDay = (now = wallClock(new Date())) => ui.selectedDate ? new Date(`${ui.selectedDate}T12:00:00Z`) : now;
function selectCalendarDate(value) {
  if (value !== null && !window.CourseTools.validDate(value)) return;
  ui.selectedDate = value;
  const date = value || ymd(wallClock(new Date()));
  const term = ui.data?.terms.find((t) => t.id === ui.termId);
  if (!term || date < term.start || date > term.end || term.courses.every((c) => c.type === 'event')) {
    const match = ui.data?.terms.find((t) => t.start <= date && t.end >= date && t.courses.some((c) => c.type !== 'event')) || ui.data?.terms.find((t) => t.start <= date && t.end >= date);
    if (match) { ui.termId = match.id; selected.clear(); }
  }
}
function moveDate(amount) {
  const date = selectedDay(); date.setUTCDate(date.getUTCDate() + amount);
  if (!window.CourseTools.validDate(ymd(date))) return;
  selectCalendarDate(ymd(date)); render();
}
function calendarNav(now, weekly = false) {
  const date = selectedDay(now), start = new Date(date);
  if (weekly) start.setUTCDate(start.getUTCDate() - isoDay(start) + 1);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  const label = weekly ? `${fmtDate(ymd(start))} – ${fmtDate(ymd(end))}` : `${fmtDate(ymd(date))} · ${WEEKDAY[isoDay(date)]}`;
  return `<div class="calendar-nav"><div class="date-navigation"><button class="nav-arrow" data-action="previous-date" aria-label="${weekly ? '上一周' : '前一天'}">‹</button><label class="date-picker"><span class="date-picker-year">${date.getUTCFullYear()} 年</span><b>${label}<span class="picker-chevron">⌄</span></b><input id="calendar-date" aria-label="选择日期" type="date" min="1900-01-01" max="9998-12-31" value="${ymd(date)}"></label><button class="nav-arrow" data-action="next-date" aria-label="${weekly ? '下一周' : '后一天'}">›</button></div><button class="today-btn" data-action="go-today">今天</button></div>`;
}
function viewToday(data, now, instant) {
  const date = selectedDay(now), isToday = ymd(date) === ymd(now);
  const items = classesOn(data.terms, date);
  const nav = calendarNav(now);
  const add = `<button class="add-inline" data-action="add-menu"><span>＋</span> 新建课程或日程</button>`;
  if (!items.length) return `${nav}<div class="day-empty"><span class="empty-calendar" aria-hidden="true">☀</span>${empty(isToday ? '今天没有安排' : '这一天没有安排', nextClassHint(data.terms, date))}${add}</div>`;
  const nowMin = isToday ? now.getUTCHours() * 60 + now.getUTCMinutes() : -1;
  const current = isToday && items.find((m) => m.s <= nowMin && nowMin < m.e);
  const next = isToday && items.find((m) => m.s > nowMin);
  let hero = '';
  if (current) hero = heroCard(current, '正在进行', `还剩 ${fmtSpan(current.e - nowMin)}`, Math.round(((nowMin - current.s) / (current.e - current.s)) * 100));
  else if (next) hero = heroCard(next, '接下来', `${fmtSpan(next.s - nowMin)}后`);
  else if (isToday) hero = `<div class="hero done"><div class="hero-label">今天的安排已结束</div><div class="hero-sub">${esc(nextClassHint(data.terms, now))}</div></div>`;
  return `${nav}${hero}<div class="section-label"><span>${isToday ? '今日' : '当天'}安排 <b>${items.length}</b></span><span>${clock(items[0].s)}–${clock(items.at(-1).e)}</span></div><ol class="agenda">${items.map((m) => slot(m, nowMin)).join('')}</ol>${add}`;
}

// ---- 学期课表 ----

// 同一天时间重叠的课并排显示
function layoutLanes(meetings) {
  const sorted = [...meetings].sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const m of cluster) {
      let i = lanes.findIndex((end) => end <= m.s);
      if (i < 0) i = lanes.push(0) - 1;
      lanes[i] = m.e;
      m.lane = i;
    }
    for (const m of cluster) m.lanes = lanes.length;
    cluster = [];
  };
  for (const m of sorted) {
    if (cluster.length && m.s >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    cluster.push(m);
    clusterEnd = Math.max(clusterEnd, m.e);
  }
  flush();
  return sorted;
}

function week(term, now) {
  const anchor = selectedDay(now), monday = new Date(anchor);
  monday.setUTCDate(monday.getUTCDate() - isoDay(monday) + 1);
  const dates = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setUTCDate(d.getUTCDate() + i); return d; });
  // A dated week shows real occurrences, including exceptions and one-off events.
  const terms = ui.data.terms.filter((t) => t.id === term.id || t.courses.some((c) => c.type === 'event'));
  const perDay = dates.map((d) => classesOn(terms, d).filter((m) => m.termId === term.id || m.type === 'event'));
  const meetings = perDay.flat();
  const visibleDays = dates.map((date, index) => ({ date, index })).filter(({ index }) => index < 5 || perDay[index].length);
  const startH = Math.min(9, Math.floor(Math.min(...meetings.map((m) => m.s), 9 * 60) / 60));
  const endH = Math.max(17, Math.ceil(Math.max(...meetings.map((m) => m.e), 17 * 60) / 60));
  const span = (endH - startH) * 60, pct = (min) => ((min - startH * 60) / span) * 100;
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const head = visibleDays.map(({ date: d }) => `<button data-day-date="${ymd(d)}" ${window.CourseTools.validDate(ymd(d)) ? '' : 'disabled'} class="${ymd(d) === ymd(now) ? 'is-today' : ''}" aria-label="查看 ${fmtDate(ymd(d))}"><span>${WEEKDAY[isoDay(d)].slice(1)}</span><b>${d.getUTCDate()}</b></button>`).join('');
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => `<span style="top:${(i / (endH - startH)) * 100}%">${pad(startH + i)}<small>:00</small></span>`).join('');
  const columns = visibleDays.map(({ date: d, index }) => {
    const blocks = layoutLanes(perDay[index]).map((m) => {
      const tip = `${m.type === 'event' ? m.title : m.code} ${m.section}\n${m.title}\n${WEEKDAY[m.day]} ${clock(m.s)}–${clock(m.e)} ${place(m)}`;
      return `<div class="block ${m.waitlisted ? 'waitlisted' : ''} ${m.type === 'event' ? 'event-block' : ''}" ${itemAttrs(m.termId, m.code, m.index, m.occurrenceDate, m.displayDate)} title="${esc(tip)}" style="--h:${m.h};--lane:${m.lane};--lanes:${m.lanes};top:${pct(m.s)}%;height:${((m.e - m.s) / span) * 100}%"><b>${esc(m.type === 'event' ? m.title : m.code.replace(/[HY]\d$/, ''))}</b><span>${esc(m.type === 'event' ? '日程' : m.kind)}</span>${m.e - m.s >= 60 ? `<span class="block-time">${clock(m.s)}</span>` : ''}${m.e - m.s >= 90 && place(m) ? `<span>${esc(place(m))}</span>` : ''}${waitTag(m.waitlisted)}</div>`;
    }).join('');
    const today = ymd(d) === ymd(now);
    const line = today && nowMin > startH * 60 && nowMin < endH * 60 ? `<div class="now-line" style="top:${pct(nowMin)}%"></div>` : '';
    return `<div class="day ${today ? 'is-today' : ''}">${blocks}${line}</div>`;
  }).join('');
  return `<div class="week" style="--days:${visibleDays.length};--hours:${endH - startH}"><div class="week-head"><span></span>${head}</div><div class="week-body"><div class="hours">${hours}</div>${columns}</div></div>${meetings.length ? '' : '<p class="week-empty-note">本周没有安排 · 可选择其他日期或新建日程</p>'}`;
}
function viewTerm(data, now) {
  if (!data.terms.length) return `${calendarNav(now, true)}${empty('还没有课程或日程')}<button class="add-inline" data-action="add-menu">＋ 新建课程或日程</button>`;
  const term = activeTerm();
  ui.termId = term.id;
  for (const code of selected) if (!term.courses.some((c) => c.code === code)) selected.delete(code);
  const chips = data.terms.map((t) => `<button class="chip" data-term="${esc(t.id)}" aria-pressed="${t === term}">${esc(t.name)}</button>`).join('');
  const courses = term.courses.map((c) => {
    const waitlisted = waiting(c) || term.meetings.some((m) => m.code === c.code && waiting(null, m));
    const tba = !term.meetings.some((m) => m.code === c.code && timed(m));
    return `<li class="${waitlisted ? 'waitlisted' : ''}" style="--h:${hueFor(term, c.code)}">${ui.selecting ? `<input class="course-select" type="checkbox" data-select="${esc(c.code)}" aria-label="选择 ${esc(c.type === 'event' ? c.title : c.code)}" ${selected.has(c.code) ? 'checked' : ''}>` : ''}<button class="course-open" ${itemAttrs(term.id, c.code)}><span class="dot"></span><span class="course-name"><b>${esc(c.type === 'event' ? c.title : c.code)}</b><span class="course-title">${esc(c.type === 'event' ? '个人日程' : c.title)}</span></span><span class="course-chevron">›</span>${waitTag(waitlisted)}${tba ? '<span class="status-tag">时间待定 · TBA</span>' : ''}</button></li>`;
  }).join('');
  return `${calendarNav(now, true)}<div class="chips">${chips}</div>${week(term, now)}<button class="add-inline" data-action="add-menu"><span>＋</span> 新建课程或日程</button><section class="course-section ${ui.selecting ? 'is-selecting' : ''}"><div class="course-section-heading"><button class="course-list-toggle" data-action="toggle-course-list" aria-expanded="${ui.courseListOpen}"><span>${ui.courseListOpen ? '⌄' : '›'}</span> 课程与日程 <small>${term.courses.length}</small></button>${ui.courseListOpen ? `<button class="text-btn" data-action="toggle-selection">${ui.selecting ? '完成' : '选择'}</button>` : ''}</div><div ${ui.courseListOpen ? '' : 'hidden'}>${ui.selecting ? `<div class="course-toolbar"><button data-action="select-all">${term.courses.length && term.courses.every((c) => selected.has(c.code)) ? '取消全选' : '全选'}</button><span class="toolbar-spacer"></span>${selected.size ? `<button class="selection-export" data-action="export">导出已选 (${selected.size})</button>` : '<span class="muted">选择后可导出</span>'}</div>` : ''}<ul class="course-list">${courses}</ul></div></section><div class="term-note">${esc(displayTimezone)} · 点按查看详情，长按查看更多操作</div>`;
}

// ---- 成绩 ----

function viewGrades(data) {
  const t = data.transcript;
  if (!t?.sessions?.length) return empty('还没有成绩单数据', '刷新后会从 ACORN 的 Academic History 读取');

  const latest = [...t.sessions].reverse().find((s) => s.sessionalGpa || s.average);
  const side = !latest
    ? ''
    : latest.average
      ? `<div class="side"><div class="label">${esc(latest.name)} 均分</div><div class="mid">${esc(latest.average)}%</div></div>`
      : `<div class="side"><div class="label">${esc(latest.name)} GPA</div><div class="mid">${esc(latest.sessionalGpa)}</div></div>`;
  const summary = `<div class="gpa-card">
    <div><div class="label">累计 GPA</div><div class="big">${esc(t.cgpa ?? '—')}</div></div>${side}
  </div>`;

  // 还没出分的学期（在读、PEY）合并成一行课号，不占地方
  const isPending = (c) => !c.grade || /^IPR$/i.test(c.grade);
  const pendingSessions = t.sessions.filter((s) => s.courses.every(isPending));
  const pendingCourses = [...new Map(pendingSessions.flatMap((s) => s.courses).map((c) => [c.code, c])).values()];
  const pending = pendingCourses.length
    ? `<section class="session">
        <div class="session-head"><h3>等待出分</h3><span class="session-gpa">${pendingCourses.length} 门课</span></div>
        <div class="pending-list">${pendingCourses.map((c) => `<span title="${esc(c.title)}">${esc(c.code)}</span>`).join('')}</div>
      </section>`
    : '';

  const sessions = [...t.sessions]
    .reverse()
    .filter((s) => !pendingSessions.includes(s))
    .map((s) => {
      const gpa = [s.sessionalGpa && `GPA ${s.sessionalGpa}`, s.average && `均分 ${s.average}%`].filter(Boolean).join(' · ');
      const rows = s.courses
        .map((c) => {
          const score = isPending(c)
            ? '<span class="grade pending">进行中</span>'
            : `${c.mark ? `<span class="pct">${esc(c.mark)}</span>` : ''}<span class="grade">${esc(c.grade)}</span>`;
          return `<li>
            <div><div class="mark-code">${esc(c.code)}<span class="weight">${esc(c.weight)}</span></div><div class="mark-title">${esc(c.title)}</div></div>
            <div class="mark-score">${score}${c.avg ? `<span class="avg">班均 ${esc(c.avg)}</span>` : ''}</div>
          </li>`;
        })
        .join('');
      const notes = (s.notes || []).map((n) => `<div class="session-note">${esc(n)}</div>`).join('');
      return `<section class="session">
        <div class="session-head"><h3>${esc(s.name)}</h3><span class="session-gpa">${esc(gpa)}</span></div>
        <ul class="marks">${rows}</ul>${notes}
      </section>`;
    })
    .join('');
  return summary + pending + sessions;
}

// ---- 外壳 ----

function viewNoData() {
  const { state, message } = ui.status;
  if (state === 'idle' || state === 'loading') return empty('正在加载…');
  if (state === 'offline') return `${empty('本地课表', '导入 JSON 或手动添加课程；ACORN 仅在你主动登录或刷新时连接。')}<div class="empty-actions"><button class="primary-btn" data-action="import">导入 JSON</button><button class="secondary-btn" data-action="add-course">添加课程</button>${bridge?.capabilities?.login === false ? '' : '<button class="secondary-btn" data-action="login">登录 ACORN</button>'}</div>`;
  if (state === 'unsupported') return `${empty('本地课表', message || '此平台暂不支持 ACORN 登录；可以导入 JSON 或手动添加课程。')}<div class="empty-actions"><button class="primary-btn" data-action="import">导入 JSON</button><button class="secondary-btn" data-action="add-course">添加课程</button></div>`;
  if (state === 'error') return `${empty('加载失败', message)}<div class="empty-actions"><button class="primary-btn" data-action="import">导入 JSON 恢复</button><button class="secondary-btn" data-action="refresh">重试</button></div>`;
  return `<div class="empty">
    <div class="empty-title">登录 ACORN</div>
    <div class="empty-sub">在 UofT 官方登录页完成登录和 MFA，<br>小组件只保存登录后的会话。</div>
    <button class="primary-btn" data-action="login">登录</button>
  </div>`;
}

function footer() {
  const { state, message } = ui.status;
  let when = '';
  if (ui.data?.fetchedAt) {
    const d = wallClock(new Date(ui.data.fetchedAt));
    when = ymd(d) === ymd(wallClock(new Date())) ? `今天 ${clock(d.getUTCHours() * 60 + d.getUTCMinutes())}` : `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  }
  if (ui.dataError) return `<span title="${esc(ui.dataError)}">数据校验失败 · 保留现有课表</span><button class="link" data-action="import">导入恢复</button>`;
  if (preview) return `<span>${ui.data?.source === 'local' ? '本地数据' : '演示数据'} · 仅保存在此浏览器，不连接 ACORN</span>`;
  const authSupported = bridge?.capabilities?.login !== false;
  if (state === 'error') return `<span title="${esc(message)}">${authSupported ? '刷新失败' : '本地操作失败'}${ui.data ? ' · 已保留现有课表' : ''}${authSupported ? '' : ' · ACORN 登录暂不支持'}</span>${authSupported ? '<button class="link" data-action="refresh">重试</button>' : ''}`;
  if (state === 'unsupported' || !authSupported) return `<span>${esc(state === 'unsupported' && message ? message : 'ACORN 登录暂不支持 · 本地课表')}</span>`;
  if (state === 'loading') return '<span>正在刷新…</span>';
  if (state === 'login') return `<span>需要登录 ACORN${ui.data ? ' · 已保留现有课表' : ''}</span><button class="link" data-action="login">登录</button>`;
  if (state === 'local' || ui.data?.source === 'local') return '<span>本地课表 · 已保存，不代表 ACORN 同步状态</span>';
  if (!ui.data) return '';
  return `<span>更新于${when}</span>`;
}

function render() {
  const instant = new Date();
  document.body.dataset.activeTab = ui.tab;
  displayTimezone = activeTerm(instant)?.timezone || 'America/Toronto';
  const now = wallClock(instant);
  $('#date').textContent = `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 ${WEEKDAY[isoDay(now)]}`;
  $('#date').title = `课表时区：${displayTimezone}`;
  $('#timezone').textContent = displayTimezone;
  $('#btn-pin').hidden = bridge?.capabilities?.pin === false;
  $('#btn-refresh').hidden = bridge?.capabilities?.refresh === false;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
  $('#btn-pin').setAttribute('aria-pressed', String(ui.pinned));
  $('#btn-refresh').classList.toggle('spinning', ui.status.state === 'loading');

  const view = $('#view');
  const scroll = view.scrollTop;
  if (!ui.data) view.innerHTML = viewNoData();
  else if (ui.tab === 'term') view.innerHTML = viewTerm(ui.data, now);
  else if (ui.tab === 'grades') view.innerHTML = viewGrades(ui.data);
  else view.innerHTML = viewToday(ui.data, now, instant);
  view.scrollTop = scroll;
  $('#footer').innerHTML = footer();
}


function loadMock() {
  // 在普通浏览器里打开时没有 Electron 的 preload，用假数据预览界面
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'mock.js';
    script.onload = () => resolve(window.acornMock);
    script.onerror = reject;
    document.head.append(script);
  });
}

function receiveState(payload) {
  if ('data' in payload) {
    if (payload.data == null) { ui.data = null; ui.dataError = null; }
    else {
      const result = window.CourseTools.validateImport(payload.data);
      if (!result.ok) {
        ui.dataError = result.errors.join('\n');
        ui.status = { state: 'error', message: `课表数据校验失败。原文件未修改；可以导入有效 JSON 恢复。\n${ui.dataError}` };
        return;
      }
      ui.data = result.data;
      ui.dataError = null;
    }
  }
  if (payload.status) ui.status = payload.status;
  if (typeof payload.pinned === 'boolean') ui.pinned = payload.pinned;
}

(async function init() {
  try {
    preview = !window.acorn;
    bridge = window.acorn ?? (await loadMock());
    bridge.onUpdate?.((payload) => {
      receiveState(payload);
      render();
    });
    bridge.onPinned?.((pinned) => { ui.pinned = pinned; render(); });
    receiveState(await bridge.getState());
    if (preview) {
      const local = store.get('acorn-local-data', null);
      if (local) {
        try { const result = window.CourseTools.validateImport(JSON.parse(local)); if (result.ok) ui.data = result.data; } catch {}
      }
    }
    render();
    setInterval(() => { if (!document.hidden && !$('#app-dialog').open && $('#context-menu').hidden && !document.activeElement?.matches('input, select, textarea')) render(); }, 30_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app-dialog').open && $('#context-menu').hidden && !document.activeElement?.matches('input, select, textarea')) render(); });
  } catch (error) {
    ui.status = { state: 'error', message: error.message || '无法初始化课表' };
    render();
  }
})();

// ---- 本地课程 / 对话框 ----
let dialogContext = null;
let lastFocus = null;
let toastTimer;
function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}
let dialogHistory = [];
let editorBaseline = null;
function formSnapshot() {
  const form = $('#course-form') || $('#event-form');
  return form ? JSON.stringify([...new FormData(form).entries()]) : null;
}
function editorDirty() { return editorBaseline !== null && editorBaseline !== formSnapshot(); }
function showDialogContent(title, body, context, options = {}) {
  const dialog = $('#app-dialog');
  dialogContext = context;
  dialog.classList.toggle('editor-dialog', !!options.editor);
  dialog.dataset.title = title;
  dialog.dataset.editor = options.editor || '';
  $('#dialog-content').innerHTML = `<div class="dialog-head">${options.editor ? '<button class="dialog-back" data-action="close-dialog" aria-label="返回">‹ <span>返回</span></button>' : ''}<h2 id="dialog-title">${esc(title)}</h2>${options.editor ? `<button class="header-save" type="submit" form="${options.editor}">保存</button>` : '<button class="icon-btn" data-action="close-dialog" aria-label="关闭">✕</button>'}</div><div class="dialog-body">${body}</div>`;
  editorBaseline = options.editor ? formSnapshot() : null;
  dialog.scrollTop = 0;
}
function openDialog(title, body, context = null, options = {}) {
  closeMenu();
  const dialog = $('#app-dialog');
  if (!dialog.open) { lastFocus = document.activeElement; dialogHistory = []; }
  else if (options.push) dialogHistory.push({ title: dialog.dataset.title, body: $('.dialog-body').innerHTML, context: dialogContext, scroll: dialog.scrollTop });
  else dialogHistory = [];
  showDialogContent(title, body, context, options);
  if (!dialog.open) dialog.showModal();
}
function finishDialogBack() {
  editorBaseline = null;
  const previous = dialogHistory.pop();
  if (previous) { showDialogContent(previous.title, previous.body, previous.context); $('#app-dialog').scrollTop = previous.scroll; }
  else $('#app-dialog').close();
}
function closeDialog(force = false) {
  if (!force && ($('#course-form')?.dataset.saving || $('#event-form')?.dataset.saving)) return;
  if (force) { editorBaseline = null; dialogHistory = []; $('#app-dialog').close(); return; }
  if (editorDirty()) { if (!$('#discard-dialog').open) $('#discard-dialog').showModal(); return; }
  finishDialogBack();
}
window.acornHandleBack = window.__bcornHandleBack = () => {
  if ($('#discard-dialog').open) { $('#discard-dialog').close(); return true; }
  if (!$('#context-menu').hidden) { closeMenu(); menuOrigin?.focus(); return true; }
  if ($('#app-dialog').open) { closeDialog(); return true; }
  if (ui.selecting) { ui.selecting = false; selected.clear(); render(); return true; }
  return false;
};
$('#app-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
$('#app-dialog').addEventListener('close', () => {
  if ($('#app-dialog').open) return;
  dialogContext = null; editorBaseline = null; dialogHistory = [];
  if (lastFocus?.isConnected) lastFocus.focus();
});
$('#app-dialog').addEventListener('click', (event) => {
  if (event.target === $('#app-dialog')) {
    const r = event.target.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog();
  }
});
const clone = (data) => JSON.parse(JSON.stringify(data));
function checkedResult(result) {
  if (result === false || result?.ok === false || result?.success === false || result?.error) throw new Error(result?.error || result?.message || '操作失败');
  return result;
}
async function persist(data) {
  data.source = 'local';
  data.modifiedAt = new Date().toISOString();
  if (bridge?.saveData) checkedResult(await bridge.saveData(data));
  else {
    // A storage failure must not be presented as a successful save.
    localStorage.setItem('acorn-local-data', JSON.stringify(data));
  }
  ui.data = data;
  ui.dataError = null;
  if (!preview && ui.status.state !== 'unsupported') ui.status = { state: 'local' };
  render();
}
function contextFromElement(el) {
  const term = ui.data?.terms.find((t) => t.id === el.dataset.courseTerm);
  const course = term?.courses.find((c) => c.code === el.dataset.course);
  if (!term || !course) return null;
  const meetingIndex = el.dataset.meeting == null ? null : Number(el.dataset.meeting);
  return { term, course, meetingIndex, meeting: meetingIndex == null ? null : term.meetings[meetingIndex], occurrenceDate: el.dataset.occurrenceDate || null, displayDate: el.dataset.displayDate || null };
}
function nextCalendarEvent(term, course, meeting, occurrenceDate = null) {
  if (!bridge?.addCalendarEvent || !timed(meeting) || waiting(course, meeting)) return null;
  const timezone = term.timezone || 'America/Toronto';
  for (const date of window.CourseTools.occurrenceDates(term, meeting).filter((date) => !occurrenceDate || date === occurrenceDate)) {
    let start, end;
    try {
      start = window.CourseTools.localToUtc(date, meeting.start, timezone);
      end = window.CourseTools.localToUtc(date, meeting.end, timezone);
    } catch { continue; }
    if (+start <= Date.now()) continue;
    return { title: course.type === 'event' ? course.title : [course.code, meeting.section, course.title].filter(Boolean).join(' · '), location: [...new Set([meeting.location, meeting.room, meeting.address].filter(Boolean))].join(', '), description: `单次课程；时区 ${timezone}。完整学期请使用 ICS 导出。`, startMillis: +start, endMillis: +end };
  }
  return null;
}
function detail(context) {
  const { term, course, meeting } = context, isEvent = course.type === 'event';
  const all = meeting ? [meeting] : term.meetings.filter((m) => m.code === course.code);
  const today = ymd(wallClock(new Date(), term.timezone || 'America/Toronto'));
  const rows = all.map((m) => {
    const index = term.meetings.indexOf(m), calendar = nextCalendarEvent(term, course, m, context.occurrenceDate);
    const currentTime = wallClock(new Date(), term.timezone || 'America/Toronto');
    const next = window.CourseTools.occurrenceDates(term, m).find((date) => date > today || date === today && toMin(m.end) > currentTime.getUTCHours() * 60 + currentTime.getUTCMinutes());
    const provider = store.get('map-provider', 'google');
    const maps = ['google', 'amap'].map((provider) => window.CourseTools.buildMapUrl(m, { provider }));
    return `<section class="meeting-detail"><div class="detail-heading"><span class="detail-kind">${esc(m.section || (isEvent ? '日程' : m.kind) || '课程时间')}</span>${waitTag(waiting(course, m))}<span class="recurrence-tag">${m.recurrence === 'once' ? '仅一次' : '每周'}</span></div>
      <div class="detail-time">${timed(m) ? `${esc(m.start)}<span>–</span>${esc(m.end)}` : '时间待定'}</div><p class="detail-date" data-detail-occurrence="${esc(context.occurrenceDate || '')}">${context.occurrenceDate ? `${esc(context.occurrenceDate)} · ${WEEKDAY[isoDay(new Date(`${context.occurrenceDate}T12:00:00Z`))]}` : m.recurrence === 'once' ? `${esc(m.date)} · ${WEEKDAY[m.day]}` : `每${WEEKDAY[m.day]}`}</p>${context.displayDate && (context.displayDate !== context.occurrenceDate || term.timezone !== displayTimezone) ? `<p class="field-hint">此处为 ${esc(term.timezone)} 时间；日历视图日期 ${esc(context.displayDate)}（${esc(displayTimezone)}）</p>` : ''}<p class="detail-next">${next ? `下一次${isEvent ? '安排' : '上课'}：${esc(next)} ${esc(m.start)}` : '没有后续安排'}</p>
      <div class="location-card"><span class="location-pin" aria-hidden="true">⌖</span><div><b>${esc(place(m) || '地点待定')}</b>${m.address ? `<p>${esc(m.address)}</p>` : '<p>可在编辑中添加教室或地址</p>'}</div></div>
      ${maps.some(Boolean) ? `<div class="detail-actions"><button class="map-btn" data-action="map-${provider}" data-index="${index}">导航 · ${provider === 'amap' ? '高德地图' : 'Google 地图'} <span>↗</span></button></div>` : ''}
      <details class="more-details"><summary>更多详情</summary><dl><dt>日期范围</dt><dd>${esc(m.from || term.start)} 至 ${esc(m.until || term.end)}</dd><dt>时区</dt><dd>${esc(term.timezone || 'America/Toronto')}</dd>${m.location && m.location !== m.room ? `<dt>楼宇 / 地点</dt><dd>${esc(m.location)}</dd>` : ''}${m.delivery ? `<dt>授课方式</dt><dd>${esc(m.delivery)}</dd>` : ''}${m.exdates?.length ? `<dt>排除日期</dt><dd>${m.exdates.map(esc).join('、')}</dd>` : ''}</dl>${calendar ? `<button class="text-btn" data-action="calendar-preview" data-index="${index}">${context.occurrenceDate ? '在系统日历预览这次安排' : '在系统日历预览下一次安排'} ↗</button>` : ''}${maps.some(Boolean) ? '<button class="text-btn" data-action="map-settings">更改默认地图</button><p class="field-hint">地图导航会向所选地图服务发送地点信息。</p>' : ''}</details></section>`;
  }).join('');
  openDialog(isEvent ? '日程详情' : course.code, `<div class="detail-intro" style="--h:${hueFor(term, course.code)}"><div class="detail-title">${esc(course.title)}</div><div class="detail-heading muted">${esc(term.name)}${isEvent ? '' : ` · ${esc(course.credits || '—')} 学分`} ${waitTag(waiting(course))}</div></div>${rows || '<div class="meeting-detail"><div class="detail-time">时间待定</div><p class="muted">尚未安排上课时间，编辑课程即可添加。</p></div>'}<div class="dialog-actions detail-footer"><button class="secondary-btn" data-action="export-course">导出${isEvent ? '日程' : '此课程'}</button><button class="primary-btn" data-action="edit-course">编辑${isEvent ? '日程' : '课程'}</button></div>`, context);
}
function field(label, name, value = '', type = 'text', extra = '') {
  return `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;
}
function exclusionFields(dates = []) {
  return `<div class="exclusion-editor"><span class="exclusion-label">排除日期</span><p class="field-hint">选择停课或不重复的日期。</p><input type="hidden" name="exdates" value="${esc(dates.join(', '))}"><div class="exclusion-add"><input type="date" min="1900-01-01" max="9998-12-31" data-exclusion-date aria-label="选择排除日期"><button type="button" data-action="add-exclusion">添加</button></div><div class="exclusion-chips">${exclusionChips(dates)}</div></div>`;
}
function exclusionChips(dates) {
  return dates.map((date) => `<button type="button" data-action="remove-exclusion" data-date="${esc(date)}" aria-label="移除排除日期 ${esc(date)}">${esc(date)} <span>×</span></button>`).join('');
}
function updateExclusions(editor, dates) {
  dates = [...new Set(dates)].sort();
  editor.querySelector('[name="exdates"]').value = dates.join(', ');
  editor.querySelector('.exclusion-chips').innerHTML = exclusionChips(dates);
}
function meetingFields(m = {}, index = null, expanded = false) {
  const day = m.day || isoDay(selectedDay());
  return `<details class="meeting-fields" ${index == null ? '' : `data-original-index="${index}"`} ${expanded ? 'open' : ''}><summary><span class="meeting-summary-dot"></span><span><b class="meeting-summary-title">${esc(m.section || '上课时间')} · ${WEEKDAY[day]}</b><small class="meeting-summary-meta">${esc(m.start || '09:00')}–${esc(m.end || '10:00')}${place(m) ? ` · ${esc(place(m))}` : ''}</small></span><span class="accordion-arrow">⌄</span></summary><div class="meeting-fields-body"><div class="form-grid">
    <label class="field"><span>星期</span><select name="day">${WEEKDAY.slice(1).map((d, i) => `<option value="${i + 1}" ${day === i + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>${field('班号', 'section', m.section || 'LEC0101', 'text', 'maxlength="80"')}
    ${field('开始时间', 'start', m.start || '09:00', 'time', 'required')}${field('结束时间', 'end', m.end || '10:00', 'time', 'required')}
    </div>${field('教室 / 地点', 'room', m.room || m.location || '', 'text', 'maxlength="300" placeholder="例如 BA 1160"')}${field('导航地址', 'address', m.address || '', 'text', 'maxlength="1000" placeholder="街道地址，选填"')}
    <details class="advanced-fields"><summary>日期范围、停课与状态</summary><div class="form-grid">${field('首次上课', 'from', m.from || '', 'date')}${field('最后上课', 'until', m.until || '', 'date')}</div><p class="field-hint">留空时使用学期起止日期。</p><label class="field"><span>班级状态</span><select name="meetingStatus"><option value="enrolled" ${!waiting(null, m) ? 'selected' : ''}>已选课</option><option value="waitlisted" ${waiting(null, m) ? 'selected' : ''}>候补 · Waitlisted</option></select></label>${exclusionFields(m.exdates || [])}</details>
    <button type="button" class="text-btn remove-meeting" data-action="remove-meeting">移除此时间</button></div></details>`;
}
function editCourse(context = null) {
  if (context?.course?.type === 'event') { editEvent(context); return; }
  const term = context?.term || activeTerm(), course = context?.course || {};
  const meetings = context ? term.meetings.map((m, index) => ({ m, index })).filter(({ m }) => m.code === course.code && timed(m)) : [];
  const year = selectedDay().getUTCFullYear();
  openDialog(context ? '编辑课程' : '新建课程', `<form id="course-form"><p class="editor-subtitle">${context ? '调整课程信息与每周安排' : '为你的课表添加一门课程'}</p>
    <section class="form-section"><h3>基本信息</h3>${field('课程名称', 'title', course.title || '', 'text', 'required maxlength="500" placeholder="例如 Introduction to Computer Science"')}<div class="form-grid">${field('课程代码', 'code', course.code, 'text', 'required maxlength="80" placeholder="CSC108H1"')}${field('学分', 'credits', course.credits ?? '0.50', 'text', 'maxlength="30" inputmode="decimal"')}</div>
    ${context ? `<p class="field-hint">${esc(term.name)}</p>` : `<label class="field"><span>所属学期</span><select id="course-term" name="term">${(ui.data?.terms || []).map((t) => `<option value="${esc(t.id)}" ${t === term ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}<option value="__new__" ${!term ? 'selected' : ''}>＋ 新建学期</option></select></label>`}
    <fieldset id="new-term-fields" ${term ? 'hidden disabled' : ''}><legend>学期设置</legend>${field('学期名称', 'termName', `${year} 学期`, 'text', 'required maxlength="100"')}<div class="form-grid">${field('开始日期', 'termStart', `${year}-09-01`, 'date', 'required')}${field('结束日期', 'termEnd', `${year}-12-31`, 'date', 'required')}</div>${field('时区', 'timezone', 'America/Toronto', 'text', 'required')}</fieldset>
    <details class="advanced-fields"><summary>课程状态</summary><label class="field"><span>选课状态</span><select name="status"><option value="enrolled" ${!waiting(course) ? 'selected' : ''}>已选课</option><option value="waitlisted" ${waiting(course) ? 'selected' : ''}>候补 · Waitlisted</option></select></label></details></section>
    <section class="form-section"><div class="form-section-head"><h3>上课时间</h3><span>每周重复</span></div><div id="meeting-fields">${meetings.map(({ m, index }) => meetingFields(m, index)).join('')}</div><p id="tba-hint" class="field-hint" ${meetings.length ? 'hidden' : ''}>还没有安排时间。你可以稍后添加，课程会显示为时间待定（TBA）。</p><button type="button" class="add-meeting-btn" data-action="add-meeting">＋ 添加上课时间</button></section>
    <p class="local-note">仅保存在本地，不会更改 ACORN 选课。</p><p class="form-error" id="form-error" role="alert"></p><button class="primary-btn editor-submit" type="submit">保存课程</button></form>`, context, { editor: 'course-form', push: !!context });
}
function editEvent(context = null) {
  const original = context?.meeting || context?.term.meetings.find((m) => m.code === context.course.code) || {};
  const date = original.date || original.from || ymd(selectedDay());
  const recurrence = original.recurrence || (context ? 'weekly' : 'once');
  const term = context?.term || activeTerm();
  openDialog(context ? '编辑日程' : '新建日程', `<form id="event-form"><p class="editor-subtitle">为课程之外的重要安排留出时间</p><section class="form-section"><h3>日程信息</h3>${field('标题', 'title', context?.course.title || '', 'text', 'required maxlength="500" placeholder="例如 小组讨论、考试或运动"')}<label class="field"><span>重复</span><select name="recurrence" id="event-recurrence"><option value="once" ${recurrence === 'once' ? 'selected' : ''}>仅此一次</option><option value="weekly" ${recurrence === 'weekly' ? 'selected' : ''}>每周重复</option></select></label><div id="event-once" ${recurrence === 'once' ? '' : 'hidden'}>${field('日期', 'date', date, 'date', recurrence === 'once' ? 'required' : 'disabled')}</div><fieldset class="event-weekly" id="event-weekly" ${recurrence === 'weekly' ? '' : 'hidden disabled'}><label class="field"><span>每周</span><select name="day">${WEEKDAY.slice(1).map((day, i) => `<option value="${i + 1}" ${(original.day || isoDay(selectedDay())) === i + 1 ? 'selected' : ''}>${day}</option>`).join('')}</select></label><div class="form-grid">${field('开始日期', 'from', original.from || date, 'date', 'required')}${field('结束日期', 'until', original.until || (term?.end >= date ? term.end : `${date.slice(0, 4)}-12-31`), 'date', 'required')}</div></fieldset><div class="form-grid">${field('开始时间', 'start', original.start || '09:00', 'time', 'required')}${field('结束时间', 'end', original.end || '10:00', 'time', 'required')}</div></section><section class="form-section"><h3>地点</h3>${field('地点名称', 'room', place(original), 'text', 'maxlength="300" placeholder="例如 图书馆、线上会议"')}${field('导航地址', 'address', original.address || '', 'text', 'maxlength="1000" placeholder="街道地址，选填"')}<details class="advanced-fields"><summary>更多选项</summary>${field('时区', 'timezone', term?.timezone || displayTimezone, 'text', 'required')}${exclusionFields(original.exdates || [])}</details></section><p class="local-note">个人日程保存在本地，与课程一起显示在日历中。</p><p class="form-error" id="form-error" role="alert"></p><button class="primary-btn editor-submit" type="submit">保存日程</button></form>`, context, { editor: 'event-form', push: !!context });
}
async function saveEvent(form) {
  if (form.dataset.saving) return; form.dataset.saving = 'true';
  $('.header-save').disabled = true;
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const fields = new FormData(form), get = (key) => String(fields.get(key) || '').trim();
    const data = clone(ui.data || { terms: [], transcript: null });
    const recurrence = get('recurrence'), from = recurrence === 'once' ? get('date') : get('from'), until = recurrence === 'once' ? from : get('until');
    if (!window.CourseTools.validDate(from) || !window.CourseTools.validDate(until) || from > until) throw new Error('请选择有效的日期范围。');
    if (Date.parse(until) - Date.parse(from) > 730 * 86400000) throw new Error('重复安排的日期范围最多为两年。');
    if (!get('title')) throw new Error('请填写日程标题。');
    if (!get('start') || !get('end') || get('end') <= get('start')) throw new Error('结束时间必须晚于开始时间。跨午夜的日程请分成两次安排。');
    const timezone = get('timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('请输入有效时区，例如 America/Toronto。'); }
    let term = data.terms.find((t) => t.id === (dialogContext?.term.id || activeTerm()?.id));
    if (!term || term.start > from || term.end < until || term.timezone !== timezone) {
      if (dialogContext) { const old = data.terms.find((t) => t.id === dialogContext.term.id); old.courses = old.courses.filter((c) => c.code !== dialogContext.course.code); old.meetings = old.meetings.filter((m) => m.code !== dialogContext.course.code); }
      term = data.terms.find((t) => t.id.startsWith('personal-') && t.timezone === timezone && t.start <= from && t.end >= until);
      if (!term) { term = { id: localId('personal'), name: `个人日程 · ${from.slice(0, 4)}`, start: `${from.slice(0, 4)}-01-01`, end: `${until.slice(0, 4)}-12-31`, timezone, courses: [], meetings: [] }; if (Date.parse(term.end) - Date.parse(term.start) > 730 * 86400000) { term.start = from; term.end = until; } data.terms.push(term); }
    }
    const code = dialogContext?.course.code || localId('EVT'), course = { ...(dialogContext?.course || {}), code, title: get('title'), type: 'event', credits: '' };
    const i = term.courses.findIndex((c) => c.code === code); if (i < 0) term.courses.push(course); else term.courses[i] = course;
    const original = dialogContext?.meeting || dialogContext?.term.meetings.find((m) => m.code === code) || {};
    const meeting = { ...original, code, title: course.title, section: '', kind: 'EVENT', recurrence, day: recurrence === 'once' ? isoDay(new Date(`${from}T12:00:00Z`)) : Number(get('day')), start: get('start'), end: get('end'), from, until, room: get('room'), location: original.room && original.location !== original.room ? (original.location || '') : get('room'), address: get('address'), exdates: recurrence === 'weekly' ? get('exdates').split(/[,，\s]+/).filter(Boolean) : [] };
    if (recurrence === 'once') meeting.date = from; else delete meeting.date;
    if (!window.CourseTools.occurrenceDates(term, meeting).length) throw new Error('所选日期内没有安排。请检查星期、日期范围与排除日期。');
    term.meetings = term.meetings.filter((m) => m.code !== code).concat(meeting);
    const result = window.CourseTools.validateImport(data); if (!result.ok) throw new Error(result.errors.join('\n'));
    await persist(result.data); ui.termId = term.id; selectCalendarDate(from); closeDialog(true); render(); notify('日程已保存在本地');
  } catch (error) { $('#form-error').textContent = error.message || '无法保存日程'; $('#form-error').scrollIntoView({ block: 'nearest' }); }
  finally { button.disabled = false; delete form.dataset.saving; if ($('.header-save')) $('.header-save').disabled = false; }
}
async function saveCourse(form) {
  if (form.dataset.saving) return; form.dataset.saving = 'true';
  $('.header-save').disabled = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const fields = new FormData(form);
    const data = clone(ui.data || { terms: [], transcript: null });
    let term = data.terms.find((t) => t.id === (dialogContext?.term.id || fields.get('term')));
    if (!term) {
      term = { id: localId('local'), name: String(fields.get('termName')).trim(), start: fields.get('termStart'), end: fields.get('termEnd'), timezone: String(fields.get('timezone')).trim(), courses: [], meetings: [] };
      if (!term.name || term.start > term.end) throw new Error('请填写学期名称，并确保结束日期不早于开始日期。');
      try { new Intl.DateTimeFormat('en', { timeZone: term.timezone }); } catch { throw new Error('请输入有效的 IANA 时区，例如 America/Toronto。'); }
      data.terms.push(term);
    }
    const code = String(fields.get('code')).trim();
    const title = String(fields.get('title')).trim();
    if (!code || !title) throw new Error('请填写课程代码和名称。');
    const oldCode = dialogContext?.course.code;
    if (term.courses.some((c) => c.code === code && c.code !== oldCode)) throw new Error('该学期已存在这个课程代码，请编辑现有课程。');
    const course = { ...(dialogContext?.course || {}), code, title, credits: String(fields.get('credits')).trim(), status: fields.get('status') };
    const courseIndex = term.courses.findIndex((c) => c.code === oldCode);
    if (courseIndex < 0) term.courses.push(course); else term.courses[courseIndex] = course;
    const updated = Array.from(form.querySelectorAll('.meeting-fields')).map((row) => {
      const get = (name) => row.querySelector(`[name="${name}"]`).value.trim();
      const original = row.dataset.originalIndex == null ? {} : dialogContext.term.meetings[Number(row.dataset.originalIndex)];
      const m = { ...original, code, title, section: get('section'), kind: get('section').slice(0, 3), day: Number(get('day')), start: get('start'), end: get('end'), room: get('room'), location: original.room && original.location !== original.room ? (original.location || '') : get('room'), address: get('address'), status: get('meetingStatus'), exdates: get('exdates').split(/[,，\s]+/).filter(Boolean) };
      if (!timed(m)) throw new Error('每次上课的结束时间必须晚于开始时间。');
      if (get('from')) m.from = get('from'); else delete m.from;
      if (get('until')) m.until = get('until'); else delete m.until;
      if ((m.from || term.start) > (m.until || term.end)) throw new Error('上课日期范围无效。');
      if (m.exdates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw new Error('停课日期请使用 YYYY-MM-DD 格式。');
      return m;
    });
    term.meetings = term.meetings.filter((m) => m.code !== oldCode).concat(updated);
    const result = window.CourseTools.validateImport(data);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    await persist(result.data);
    ui.termId = term.id;
    selected.clear();
    ui.tab = 'term'; store.set('tab', ui.tab);
    closeDialog(true); render(); notify('课程已保存在本地');
  } catch (error) { $('#form-error').textContent = error.message || '无法保存课程'; $('#form-error').scrollIntoView({ block: 'nearest' }); }
  finally { submit.disabled = false; delete form.dataset.saving; if ($('.header-save')) $('.header-save').disabled = false; }
}

// ---- 导入 / 导出 ----
function openImport() {
  openDialog('导入本地 JSON', `<p class="field-hint">支持本应用导出的原始课表结构（terms、courses、meetings）。先校验和预览，再确认替换当前本地数据；不会上传到服务器。</p><button class="primary-btn" data-action="choose-json">选择 JSON 文件</button><p class="form-error" id="import-error" role="alert"></p>`);
}
async function readImport(file) {
  if (!file) return;
  try {
    if (file.size > window.CourseTools.MAX_IMPORT_BYTES) throw new Error('文件过大，请选择不超过 2 MB 的 JSON 文件。');
    const result = window.CourseTools.validateImport(await file.text());
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const terms = result.data.terms;
    const count = terms.reduce((sum, t) => sum + t.courses.length, 0);
    openDialog('确认导入', `<p>已校验：${terms.length} 个学期，${count} 门课程。</p><ul class="import-summary">${terms.map((t) => `<li>${esc(t.name)} · ${t.courses.length} 门课</li>`).join('')}</ul>${result.warnings?.length ? `<p class="field-hint">${result.warnings.map(esc).join('<br>')}</p>` : ''}<p class="field-hint">导入将替换当前本地课表${ui.data?.transcript ? '和成绩数据' : ''}。如需保留，请先导出完整 JSON 备份。</p><p class="form-error" id="import-error" role="alert"></p><div class="dialog-actions"><button class="secondary-btn" data-action="close-dialog">取消</button><button class="primary-btn" data-action="confirm-import">替换并导入</button></div>`, { importData: result.data });
  } catch (error) {
    if ($('#import-error')) $('#import-error').textContent = error.message || '无法读取 JSON';
    else notify(error.message || '无法读取 JSON');
  }
}
function exportDialog(onlyCode = null, termOverride = null, backup = false) {
  const term = termOverride || activeTerm();
  if (!term) { notify('请先添加课程或导入课表'); return; }
  const codes = onlyCode ? [onlyCode] : term.courses.filter((c) => selected.has(c.code)).map((c) => c.code);
  if (!backup && !codes.length) { notify('请先在课程列表中选择要导出的课程或日程'); return; }
  openDialog(backup ? '备份全部数据' : '导出已选安排', `<form id="export-form"><p class="field-hint">${esc(term.name)} · ${codes.length ? `已选 ${codes.length} 门课程` : '整个学期'}。日历文件可导入 Apple、Google、Outlook 等日历。</p>
    <label class="field"><span>范围</span><select name="scope">${backup ? '<option value="all">所有数据（JSON，包含成绩）</option>' : '<option value="selected">仅已选课程或日程</option>'}</select></label>
    <label class="field"><span>文件格式</span><select name="format" ${backup ? 'disabled' : ''}>${backup ? '' : '<option value="ics">日历 · ICS</option>'}<option value="json">本地数据 · JSON</option></select></label>
    <label class="check-field" id="waitlist-option" ${backup ? 'hidden' : ''}><input type="checkbox" name="includeWaitlisted">日历包含候补课程（默认排除）</label><p class="field-hint" id="export-hint">TBA 课程不会生成日历事件。保留时区、上课日期范围和停课日期。请自行核对 TUT / PRA 等班级的特殊停课日，学期假期不一定完整。JSON 始终保留候补课程。</p>
    <p class="form-error" id="export-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-action="close-dialog">取消</button><button class="primary-btn" type="submit">导出文件</button></div></form>`, { term, codes }, { push: !!onlyCode });
}
async function download(filename, content, type) {
  if (bridge?.exportCalendar) {
    const result = checkedResult(await bridge.exportCalendar({ filename, content }));
    return !result?.canceled && !result?.cancelled;
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
async function submitExport(form) {
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const values = new FormData(form), { term, codes } = dialogContext;
    const scope = values.get('scope');
    const format = scope === 'all' ? 'json' : values.get('format');
    const courseCodes = scope === 'selected' ? codes : undefined;
    let content;
    if (format === 'ics') {
      content = window.CourseTools.exportICS(ui.data, { termId: term.id, courseCodes, includeWaitlisted: values.has('includeWaitlisted'), calendarName: term.name });
      if (!content.includes('BEGIN:VEVENT')) throw new Error('没有可导出的定时课程。候补课程默认排除，TBA 课程仅可通过 JSON 导出。');
    } else {
      const data = scope === 'all' ? clone(ui.data) : { ...clone(ui.data), transcript: null, terms: [{ ...clone(term), courses: term.courses.filter((c) => !courseCodes || courseCodes.includes(c.code)), meetings: term.meetings.filter((m) => !courseCodes || courseCodes.includes(m.code)) }] };
      content = JSON.stringify(data, null, 2);
    }
    const filename = `${scope === 'all' ? 'acorn-backup' : `acorn-${term.id}${scope === 'selected' ? '-selected' : ''}`}`.replace(/[^a-zA-Z0-9_.-]/g, '_') + `.${format}`;
    const saved = await download(filename, content, format === 'ics' ? 'text/calendar;charset=utf-8' : 'application/json;charset=utf-8');
    if (saved) { closeDialog(true); notify(format === 'ics' ? '日历文件已导出' : 'JSON 文件已导出'); }
  } catch (error) { $('#export-error').textContent = error.message || '导出失败'; }
  finally { button.disabled = false; }
}
async function openMap(context, provider, index = context.meetingIndex) {
  const meeting = context.term.meetings[index];
  const url = window.CourseTools.buildMapUrl(meeting, { provider });
  if (!url) { notify('请先在课程中填写地点或地址'); return; }
  if (bridge?.openExternal) checkedResult(await bridge.openExternal(url));
  else window.open(url, '_blank', 'noopener,noreferrer');
}

// ---- 可扩展的应用内右键 / 长按菜单 ----
const courseActions = new Map([
  ['detail', { label: '查看详情', run: detail }],
  ['edit', { label: '编辑安排', run: editCourse }],
  ['export', { label: '导出此安排…', run: (context) => exportDialog(context.course.code, context.term) }],
  ['google', { label: 'Google 地图 ↗', visible: (context) => store.get('map-provider', 'google') === 'google' && !!context.meeting && !!window.CourseTools.buildMapUrl(context.meeting, { provider: 'google' }), run: (context) => openMap(context, 'google') }],
  ['amap', { label: '高德地图 ↗', visible: (context) => store.get('map-provider', 'google') === 'amap' && !!context.meeting && !!window.CourseTools.buildMapUrl(context.meeting, { provider: 'amap' }), run: (context) => openMap(context, 'amap') }],
]);
// Extensions register semantic actions without replacing input handling or menu UI.
window.acornCourseActions = Object.freeze({
  register(id, action) {
    if (!id || typeof action?.label !== 'string' || typeof action?.run !== 'function') throw new TypeError('An action needs an id, label, and run function');
    courseActions.set(id, action);
    return () => courseActions.delete(id);
  },
});
let menuContext = null;
let menuOrigin = null;
function closeMenu() { $('#context-menu').hidden = true; menuContext = null; }
function showMenu(event, context) {
  const menu = $('#context-menu');
  menuContext = context;
  menuOrigin = event.target?.closest('[data-course]') || event.target;
  const actions = context ? [...courseActions].filter(([, action]) => !action.visible || action.visible(context)).map(([id, action]) => `<button role="menuitem" data-context-action="${esc(id)}">${esc(action.label)}</button>`).join('') : `<button role="menuitem" data-action="add-course">＋ 新建课程</button><button role="menuitem" data-action="add-event">＋ 新建日程</button><hr><button role="menuitem" data-action="import">导入 JSON…</button><button role="menuitem" data-action="backup">备份全部数据…</button><button role="menuitem" data-action="map-settings">默认地图…</button>${bridge?.clearData && ui.data ? '<button role="menuitem" data-action="clear-local">清除本地课表与成绩…</button>' : ''}<hr><button role="menuitem" data-action="login">登录 ACORN</button><button role="menuitem" data-action="refresh">刷新 ACORN</button>${!preview && bridge?.openMenu ? '<button role="menuitem" data-action="native-menu">窗口与 ACORN 选项…</button>' : ''}`;
  menu.innerHTML = actions; menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const x = event.clientX ?? 12, y = event.clientY ?? 70;
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, innerHeight - rect.height - 6))}px`;
  menu.querySelector('button')?.focus();
}
let longPress = null;
let suppressClickUntil = 0;
let heldContext = false;
let dismissMenuClick = false;
function cancelPress() { if (longPress) clearTimeout(longPress.timer); longPress = null; }
document.addEventListener('pointerdown', (event) => {
  if (!$('#context-menu').hidden && !event.target.closest('#context-menu')) { closeMenu(); dismissMenuClick = true; event.preventDefault(); return; }
  const target = event.target.closest('[data-course]');
  if (!target || event.button !== 0) return;
  cancelPress();
  const context = contextFromElement(target);
  if (!context) return;
  longPress = { x: event.clientX, y: event.clientY, timer: setTimeout(() => {
    heldContext = true;
    suppressClickUntil = Infinity;
    showMenu({ clientX: event.clientX, clientY: event.clientY, target }, context);
    longPress = null;
  }, 550) };
});
document.addEventListener('pointermove', (event) => {
  if (longPress && Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > 10) cancelPress();
});
document.addEventListener('pointerup', () => { if (heldContext) { suppressClickUntil = Date.now() + 750; heldContext = false; } cancelPress(); });
document.addEventListener('pointercancel', () => { heldContext = false; suppressClickUntil = 0; dismissMenuClick = false; cancelPress(); });
$('#view').addEventListener('scroll', cancelPress, { passive: true });
document.addEventListener('contextmenu', (event) => {
  const target = event.target.closest('[data-course]');
  if (!target) return;
  event.preventDefault(); cancelPress();
  const context = contextFromElement(target);
  if (context) showMenu(event, context);
});
document.addEventListener('keydown', (event) => {
  const menu = $('#context-menu');
  if (!menu.hidden) {
    const buttons = [...menu.querySelectorAll('button')];
    let index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); menuOrigin?.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[index]?.focus(); }
    if (event.key === 'Tab') closeMenu();
    return;
  }
  const target = event.target.closest('[data-course]');
  if (!target) return;
  if ((event.key === 'Enter' || event.key === ' ') && target.tagName !== 'BUTTON') { event.preventDefault(); target.click(); }
  if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
    event.preventDefault(); const r = target.getBoundingClientRect();
    showMenu({ clientX: r.left, clientY: r.bottom, target }, contextFromElement(target));
  }
});

// ---- 统一事件入口 ----
async function action(name, el, event) {
  switch (name) {
    case 'close-dialog': closeDialog(); break;
    case 'add-exclusion': {
      const editor = el.closest('.exclusion-editor'), input = editor.querySelector('[data-exclusion-date]');
      if (!window.CourseTools.validDate(input.value)) { notify('请先选择一个日期'); break; }
      updateExclusions(editor, editor.querySelector('[name="exdates"]').value.split(/[,，\s]+/).filter(Boolean).concat(input.value)); input.value = ''; break;
    }
    case 'remove-exclusion': {
      const editor = el.closest('.exclusion-editor');
      updateExclusions(editor, editor.querySelector('[name="exdates"]').value.split(/[,，\s]+/).filter((date) => date && date !== el.dataset.date)); break;
    }
    case 'map-settings': openDialog('地图偏好', `<p class="editor-subtitle">导航时使用你习惯的地图。</p><div class="map-provider-options"><button data-action="set-map-provider" data-provider="google"><b>Google 地图</b><span>${store.get('map-provider', 'google') === 'google' ? '✓ 当前默认' : '设为默认'}</span></button><button data-action="set-map-provider" data-provider="amap"><b>高德地图</b><span>${store.get('map-provider', 'google') === 'amap' ? '✓ 当前默认' : '设为默认'}</span></button></div><p class="field-hint">导航会向所选服务发送地点和地址。</p>`, null, { push: $('#app-dialog').open }); break;
    case 'set-map-provider': {
      store.set('map-provider', el.dataset.provider); const previous = dialogHistory.at(-1)?.context;
      closeDialog(); if (previous?.course) detail(previous); else render(); notify('默认地图已更新'); break;
    }
    case 'keep-editing': $('#discard-dialog').close(); break;
    case 'discard-changes': $('#discard-dialog').close(); finishDialogBack(); break;
    case 'previous-date': moveDate(ui.tab === 'term' ? -7 : -1); break;
    case 'next-date': moveDate(ui.tab === 'term' ? 7 : 1); break;
    case 'go-today': selectCalendarDate(null); render(); break;
    case 'toggle-course-list': ui.courseListOpen = !ui.courseListOpen; render(); break;
    case 'toggle-selection': ui.selecting = !ui.selecting; selected.clear(); render(); break;
    case 'add-menu': openDialog('新建', `<div class="create-options"><button data-action="add-course"><span class="create-icon">▦</span><span><b>新建课程</b><small>添加课程与每周上课时间</small></span><span>›</span></button><button data-action="add-event"><span class="create-icon">＋</span><span><b>新建日程</b><small>单次安排，或每周重复的计划</small></span><span>›</span></button></div>`); break;
    case 'add-event': editEvent(); break;
    case 'backup': exportDialog(null, null, true); break;
    case 'menu': showMenu(event, null); break;
    case 'native-menu': bridge?.openMenu?.(); break;
    case 'login':
    case 'refresh':
      if (preview) { notify('浏览器演示不连接 ACORN，请在支持登录的桌面应用中操作。'); return; }
      if (ui.status.state === 'unsupported' || bridge?.capabilities?.[name] === false) { notify(ui.status.message || '此平台暂不支持 ACORN 登录；请导入 JSON 或使用本地课表。'); return; }
      checkedResult(await bridge?.[name]?.()); break;
    case 'pin':
      if (preview || bridge?.capabilities?.pin === false) { notify('此平台不支持窗口置顶'); return; }
      await bridge?.togglePin?.(); break;
    case 'add-course': editCourse(); break;
    case 'edit-course': editCourse(dialogContext); break;
    case 'export-course': exportDialog(dialogContext.course.code, dialogContext.term); break;
    case 'add-meeting': document.querySelectorAll('.meeting-fields[open]').forEach((row) => row.open = false); $('#meeting-fields').insertAdjacentHTML('beforeend', meetingFields({}, null, true)); $('#tba-hint').hidden = true; $('#meeting-fields').lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); break;
    case 'remove-meeting': el.closest('.meeting-fields').remove(); $('#tba-hint').hidden = !!$('#meeting-fields').children.length; break;
    case 'calendar-preview': {
      const context = dialogContext;
      const event = nextCalendarEvent(context.term, context.course, context.term.meetings[Number(el.dataset.index)], context.occurrenceDate);
      if (!event) { notify('没有可预览的未来定时课程；候补课程默认排除。'); break; }
      const result = checkedResult(await bridge.addCalendarEvent(event));
      if (result?.opened) notify('已打开系统日历预览，请在日历应用中确认保存。');
      else notify('系统日历预览未打开。可以改用 ICS 导出。');
      break;
    }
    case 'map-google': await openMap(dialogContext, 'google', Number(el.dataset.index)); break;
    case 'map-amap': await openMap(dialogContext, 'amap', Number(el.dataset.index)); break;
    case 'select-all': {
      const term = activeTerm(); if (!term) return;
      const all = term.courses.every((c) => selected.has(c.code)); selected.clear();
      if (!all) term.courses.forEach((c) => selected.add(c.code)); render(); break;
    }
    case 'clear-local':
      openDialog('清除本地课表与成绩', `<p>这会删除此应用缓存的课表、课程修改和成绩数据。建议先导出完整 JSON 备份。</p><p class="field-hint">已导出的文件不会被删除。此操作不会更改 ACORN 选课，也不会退出 ACORN 账户会话。</p><p id="clear-error" class="form-error" role="alert"></p><div class="dialog-actions"><button class="secondary-btn" data-action="close-dialog" autofocus>取消</button><button class="primary-btn" data-action="confirm-clear-local">确认清除本地数据</button></div>`);
      break;
    case 'confirm-clear-local':
      if (!bridge?.clearData) throw new Error('此平台暂不支持清除本地数据');
      el.disabled = true;
      try {
        const result = checkedResult(await bridge.clearData());
        if (result?.canceled || result?.cancelled) { el.disabled = false; break; }
        if (result?.data !== null) throw new Error('未能确认本地数据已清除，请重试。');
        receiveState(result); selected.clear(); ui.termId = null; closeDialog(); render(); notify('本地课表与成绩已清除');
      } catch (error) { if ($('#clear-error')) $('#clear-error').textContent = error.message; else notify(error.message); el.disabled = false; }
      break;
    case 'import': openImport(); break;
    case 'choose-json':
      if (bridge?.platform === 'android' && bridge.importData) checkedResult(await bridge.importData());
      else { $('#json-file').value = ''; $('#json-file').click(); }
      break;
    case 'confirm-import':
      el.disabled = true;
      try { await persist(dialogContext.importData); ui.termId = null; selected.clear(); closeDialog(true); render(); notify('JSON 已导入并保存在本地'); }
      catch (error) { $('#import-error').textContent = error.message; el.disabled = false; }
      break;
    case 'export': exportDialog(); break;
  }
}
document.addEventListener('click', async (event) => {
  if (dismissMenuClick) { dismissMenuClick = false; event.preventDefault(); return; }
  const el = event.target.closest('[data-tab], [data-term], [data-action], [data-course], [data-context-action], [data-day-date]');
  if (!el) return;
  if (el.dataset.course && Date.now() < suppressClickUntil) { suppressClickUntil = 0; event.preventDefault(); return; }
  try {
    if (el.dataset.contextAction) {
      const context = menuContext, item = courseActions.get(el.dataset.contextAction); closeMenu();
      if (context) await item?.run(context);
    } else if (el.dataset.dayDate) { if (!window.CourseTools.validDate(el.dataset.dayDate)) return; selectCalendarDate(el.dataset.dayDate); ui.tab = 'today'; store.set('tab', ui.tab); render();
    } else if (el.dataset.tab) {
      if (ui.tab !== el.dataset.tab) $('#view').scrollTop = 0;
      ui.tab = el.dataset.tab; store.set('tab', ui.tab); render();
    } else if (el.dataset.term) { ui.termId = el.dataset.term; selected.clear(); ui.selecting = false; const term = activeTerm(); if (term && !inTerm(term, selectedDay())) ui.selectedDate = term.start; render(); }
    else if (el.dataset.action) { if (el.dataset.action !== 'menu') closeMenu(); await action(el.dataset.action, el, event); }
    else if (el.dataset.course) { const context = contextFromElement(el); if (context) detail(context); }
  } catch (error) { notify(error.message || '操作失败'); }
});
document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.id === 'calendar-date' && window.CourseTools.validDate(el.value)) { selectCalendarDate(el.value); render(); }
  if (el.id === 'event-recurrence') { const once = el.value === 'once'; $('#event-once').hidden = !once; $('#event-once input').disabled = !once; $('#event-once input').required = once; $('#event-weekly').hidden = $('#event-weekly').disabled = once; }
  if (el.dataset.select) { const code = el.dataset.select; if (el.checked) selected.add(code); else selected.delete(code); render(); document.querySelector(`[data-select="${CSS.escape(code)}"]`)?.focus({ preventScroll: true }); }
  if (el.id === 'course-term') { const fields = $('#new-term-fields'); fields.hidden = fields.disabled = el.value !== '__new__'; }
  if (el.id === 'json-file') readImport(el.files[0]);
  if (el.closest('#export-form')) {
    const form = $('#export-form');
    const all = form.elements.scope.value === 'all';
    if (all) form.elements.format.value = 'json';
    form.elements.format.disabled = all;
    $('#waitlist-option').hidden = form.elements.format.value !== 'ics';
  }
});
document.addEventListener('submit', (event) => {
  if (event.target.id === 'event-form') { event.preventDefault(); saveEvent(event.target); }
  if (event.target.id === 'course-form') { event.preventDefault(); saveCourse(event.target); }
  if (event.target.id === 'export-form') { event.preventDefault(); submitExport(event.target); }
});

// Keep only the meeting being edited expanded. Summary text follows its fields.
document.addEventListener('toggle', (event) => {
  if (!event.target.matches?.('.meeting-fields') || !event.target.open) return;
  document.querySelectorAll('.meeting-fields[open]').forEach((row) => { if (row !== event.target) row.open = false; });
}, true);
document.addEventListener('input', (event) => {
  const row = event.target.closest('.meeting-fields');
  if (!row) return;
  const get = (name) => row.querySelector(`[name="${name}"]`)?.value || '';
  row.querySelector('.meeting-summary-title').textContent = `${get('section') || '上课时间'} · ${WEEKDAY[Number(get('day'))]}`;
  row.querySelector('.meeting-summary-meta').textContent = `${get('start')}–${get('end')}${get('room') ? ` · ${get('room')}` : ''}`;
});
