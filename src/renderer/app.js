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

const ui = { data: null, dataError: null, status: { state: 'idle' }, pinned: false, tab: store.get('tab', 'today'), termId: null };
let bridge;
let preview = false;
const selected = new Set();
const timed = (m) => Number.isInteger(m.day) && m.day >= 1 && m.day <= 7 && /^([01]\d|2[0-3]):[0-5]\d$/.test(m.start || '') && /^([01]\d|2[0-3]):[0-5]\d$/.test(m.end || '') && toMin(m.end) > toMin(m.start);
const waiting = (course, meeting) => window.CourseTools.isWaitlisted(course) || window.CourseTools.isWaitlisted(meeting);
const waitTag = (yes) => yes ? '<span class="status-tag">候补</span>' : '';
const place = (m) => m.room || m.location || '';
const itemAttrs = (term, code, index) => `data-course="${esc(code)}" data-course-term="${esc(term)}"${index == null ? '' : ` data-meeting="${index}"`} role="button" tabindex="0"`;
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
  m.day === isoDay(d) && (!m.from || ymd(d) >= m.from) && (!m.until || ymd(d) <= m.until) && !(m.exdates || []).includes(ymd(d));

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
        if (!timed(m) || !occursOn(m, sourceDate)) return;
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
        matches.push({ ...m, termId: term.id, index, s, e, h: hueFor(term, m.code), waitlisted: waiting(term.courses.find((c) => c.code === m.code), m) });
      });
    }
    return matches;
  });
  return items.filter((m) => {
    const key = JSON.stringify([m.code, m.section, m.s, m.e]);
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
  return `<div class="hero ${m.waitlisted ? 'waitlisted' : ''}" ${itemAttrs(m.termId, m.code, m.index)} style="--h:${m.h}">
    <div class="hero-top"><span class="hero-label">${label}</span><span class="hero-when">${when}</span></div>
    <div class="hero-code">${esc(m.code)}<span class="tag">${esc(m.section)}</span>${waitTag(m.waitlisted)}</div>
    <div class="hero-title">${esc(m.title)}</div>
    <div class="hero-meta"><span>${clock(m.s)}–${clock(m.e)}</span>${place(m) ? `<span>${esc(place(m))}</span>` : ''}</div>
    ${progress == null ? '' : `<div class="progress"><i style="width:${progress}%"></i></div>`}
  </div>`;
}

function slot(m, nowMin) {
  const state = m.e <= nowMin ? 'past' : m.s <= nowMin ? 'now' : '';
  return `<li class="slot ${state} ${m.waitlisted ? 'waitlisted' : ''}" ${itemAttrs(m.termId, m.code, m.index)} style="--h:${m.h}">
    <div class="slot-time"><span>${clock(m.s)}</span><span>${clock(m.e)}</span></div>
    <div class="slot-bar"></div>
    <div>
      <div class="slot-title">${esc(m.code)}<span class="tag">${esc(m.section)}</span>${waitTag(m.waitlisted)}</div>
      <div class="slot-sub">${esc([place(m), m.title].filter(Boolean).join(' · '))}</div>
    </div>
  </li>`;
}

function viewToday(data, now, instant) {
  const active = data.terms.filter((t) => inTerm(t, wallClock(instant, t.timezone || 'America/Toronto')));
  const items = classesOn(data.terms, now);
  if (!active.length && !items.length) {
    const next = data.terms.find((t) => t.start && t.start > ymd(now));
    return empty('现在不在上课期间', next ? `${next.name} 将于 ${fmtDate(next.start)} 开课` : '');
  }
  if (!items.length) return empty('今天没有课', nextClassHint(data.terms, now));

  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const current = items.find((m) => m.s <= nowMin && nowMin < m.e);
  const next = items.find((m) => m.s > nowMin);
  let hero;
  if (current) {
    const progress = Math.round(((nowMin - current.s) / (current.e - current.s)) * 100);
    hero = heroCard(current, '正在上课', `还剩 ${fmtSpan(current.e - nowMin)}`, progress);
  } else if (next) {
    hero = heroCard(next, '下一节', `${fmtSpan(next.s - nowMin)}后`);
  } else {
    const hint = nextClassHint(data.terms, now);
    hero = `<div class="hero done"><div class="hero-label">今天的课都上完了</div>${hint ? `<div class="hero-sub">${esc(hint)}</div>` : ''}</div>`;
  }
  return `${hero}
    <div class="section-label"><span>今天 ${items.length} 节课</span><span>${clock(items[0].s)}–${clock(items.at(-1).e)}</span></div>
    <ol class="agenda">${items.map((m) => slot(m, nowMin)).join('')}</ol>`;
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
  now = wallClock(new Date(), term.timezone || 'America/Toronto');
  const meetings = term.meetings.map((m, index) => ({ ...m, index, waitlisted: waiting(term.courses.find((c) => c.code === m.code), m) })).filter(timed).map((m) => ({ ...m, s: toMin(m.start), e: toMin(m.end), h: hueFor(term, m.code) }));
  if (!meetings.length) return empty('这个学期还没有排课时间');

  const days = [1, 2, 3, 4, 5, ...[6, 7].filter((d) => meetings.some((m) => m.day === d))];
  const startH = Math.min(9, Math.floor(Math.min(...meetings.map((m) => m.s)) / 60));
  const endH = Math.max(17, Math.ceil(Math.max(...meetings.map((m) => m.e)) / 60));
  const span = (endH - startH) * 60;
  const pct = (min) => ((min - startH * 60) / span) * 100;
  const todayCol = inTerm(term, now) ? isoDay(now) : 0;
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();

  const head = days.map((d) => `<span class="${d === todayCol ? 'is-today' : ''}">${WEEKDAY[d].slice(1)}</span>`).join('');
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => `<span style="top:${(i / (endH - startH)) * 100}%">${startH + i}</span>`).join('');
  const columns = days
    .map((d) => {
      const blocks = layoutLanes(meetings.filter((m) => m.day === d))
        .map((m) => {
          const tip = `${m.code} ${m.section}\n${m.title}\n${WEEKDAY[m.day]} ${clock(m.s)}–${clock(m.e)} ${place(m)}`;
          const room = m.e - m.s >= 90 && place(m) ? `<span>${esc(place(m))}</span>` : '';
          return `<div class="block ${m.waitlisted ? 'waitlisted' : ''}" ${itemAttrs(term.id, m.code, m.index)} title="${esc(tip)}" style="--h:${m.h};--lane:${m.lane};--lanes:${m.lanes};top:${pct(m.s)}%;height:${((m.e - m.s) / span) * 100}%">
            <b>${esc(m.code.replace(/[HY]\d$/, ''))}</b><span>${esc(m.kind)}</span>${waitTag(m.waitlisted)}${room}</div>`;
        })
        .join('');
      const line = d === todayCol && nowMin > startH * 60 && nowMin < endH * 60 ? `<div class="now-line" style="top:${pct(nowMin)}%"></div>` : '';
      return `<div class="day ${d === todayCol ? 'is-today' : ''}">${blocks}${line}</div>`;
    })
    .join('');

  return `<div class="week" style="--days:${days.length};--hours:${endH - startH}">
    <div class="week-head"><span></span>${head}</div>
    <div class="week-body"><div class="hours">${hours}</div>${columns}</div>
  </div>`;
}

function viewTerm(data, now) {
  if (!data.terms.length) return empty('ACORN 里还没有课表');
  const today = ymd(now);
  const term =
    data.terms.find((t) => t.id === ui.termId) ??
    data.terms.find((t) => inTerm(t, now)) ??
    data.terms.find((t) => t.start && t.start > today) ??
    data.terms.at(-1);
  const chips = data.terms
    .map((t) => `<button class="chip" data-term="${esc(t.id)}" aria-pressed="${t === term}">${esc(t.name)}</button>`)
    .join('');
  ui.termId = term.id;
  for (const code of selected) if (!term.courses.some((c) => c.code === code)) selected.delete(code);
  const courses = term.courses.map((c) => {
    const waitlisted = waiting(c) || term.meetings.some((m) => m.code === c.code && waiting(null, m));
    const tba = !term.meetings.some((m) => m.code === c.code && timed(m));
    return `<li class="${waitlisted ? 'waitlisted' : ''}" style="--h:${hueFor(term, c.code)}">
      <input class="course-select" type="checkbox" data-select="${esc(c.code)}" aria-label="选择 ${esc(c.code)}" ${selected.has(c.code) ? 'checked' : ''}>
      <button class="course-open" ${itemAttrs(term.id, c.code)}><span class="dot"></span><b>${esc(c.code)}</b><span class="course-title">${esc(c.title)}</span><span class="credits">${esc(c.credits)}</span>${waitTag(waitlisted)}${tba ? '<span class="status-tag">时间待定 · TBA</span>' : ''}</button></li>`;
  }).join('');
  return `<div class="chips">${chips}</div><div class="course-toolbar"><button data-action="add-course">＋ 添加课程</button><span class="toolbar-spacer"></span><button data-action="select-all">${term.courses.length && term.courses.every((c) => selected.has(c.code)) ? '取消全选' : '全选'}</button><button data-action="export">导出${selected.size ? ` (${selected.size})` : ''}</button></div>${week(term, now)}<ul class="course-list">${courses}</ul><div class="term-note">${esc(term.timezone || 'America/Toronto')} · 长按或右键课程查看更多操作</div>`;
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
  displayTimezone = activeTerm(instant)?.timezone || 'America/Toronto';
  const now = wallClock(instant);
  $('#date').textContent = `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 ${WEEKDAY[isoDay(now)]}`;
  $('#date').title = `课表时区：${displayTimezone}`;
  $('#timezone').textContent = displayTimezone;
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
    setInterval(() => { if (!document.hidden && !$('#app-dialog').open && $('#context-menu').hidden) render(); }, 30_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app-dialog').open) render(); });
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
function openDialog(title, body, context = null) {
  closeMenu();
  const dialog = $('#app-dialog');
  if (!dialog.open) lastFocus = document.activeElement;
  dialogContext = context;
  $('#dialog-content').innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-btn" data-action="close-dialog" aria-label="关闭">✕</button></div>${body}`;
  if (!dialog.open) dialog.showModal();
}
function closeDialog() { $('#app-dialog').close(); }
$('#app-dialog').addEventListener('close', () => {
  dialogContext = null;
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
  return { term, course, meetingIndex, meeting: meetingIndex == null ? null : term.meetings[meetingIndex] };
}
function nextCalendarEvent(term, course, meeting) {
  if (!bridge?.addCalendarEvent || !timed(meeting) || waiting(course, meeting)) return null;
  const timezone = term.timezone || 'America/Toronto';
  for (const date of window.CourseTools.occurrenceDates(term, meeting)) {
    let start, end;
    try {
      start = window.CourseTools.localToUtc(date, meeting.start, timezone);
      end = window.CourseTools.localToUtc(date, meeting.end, timezone);
    } catch { continue; }
    if (+start <= Date.now()) continue;
    return { title: [course.code, meeting.section, course.title].filter(Boolean).join(' · '), location: [...new Set([meeting.location, meeting.room, meeting.address].filter(Boolean))].join(', '), description: `单次课程；时区 ${timezone}。完整学期请使用 ICS 导出。`, startMillis: +start, endMillis: +end };
  }
  return null;
}
function detail(context) {
  const { term, course, meeting } = context;
  const all = meeting ? [meeting] : term.meetings.filter((m) => m.code === course.code);
  const rows = all.map((m) => {
    const index = term.meetings.indexOf(m);
    const calendar = nextCalendarEvent(term, course, m);
    const maps = ['google', 'amap'].map((provider) => window.CourseTools.buildMapUrl(m, { provider }));
    return `<section class="meeting-detail"><div class="detail-heading"><b>${esc(m.section || m.kind || '课程时间')}</b>${waitTag(waiting(course, m))}</div>
      <p>${timed(m) ? `${WEEKDAY[m.day]} ${esc(m.start)}–${esc(m.end)}` : '时间待定 · TBA'}</p>
      ${m.from || m.until ? `<p class="muted">${esc(m.from || term.start)} → ${esc(m.until || term.end)}</p>` : ''}
      <dl><dt>教室</dt><dd>${esc(place(m) || '待定')}</dd>${m.location && m.location !== m.room ? `<dt>楼宇 / 地点</dt><dd>${esc(m.location)}</dd>` : ''}<dt>地址</dt><dd>${esc(m.address || '未填写')}</dd>${m.delivery ? `<dt>授课方式</dt><dd>${esc(m.delivery)}</dd>` : ''}</dl>
      ${m.exdates?.length ? `<p class="muted">停课日期：${m.exdates.map(esc).join('、')}</p>` : ''}
      <div class="detail-actions">${maps[0] ? `<button class="text-btn" data-action="map-google" data-index="${index}">Google 地图 ↗</button>` : ''}${maps[1] ? `<button class="text-btn" data-action="map-amap" data-index="${index}">高德地图 ↗</button>` : ''}</div>
      ${calendar ? `<button class="text-btn" data-action="calendar-preview" data-index="${index}">在系统日历中预览下一次上课（单次）</button>` : ''}
      ${maps.some(Boolean) ? '<p class="field-hint">打开地图会向地图服务发送上方地点信息。</p>' : ''}</section>`;
  }).join('');
  openDialog(course.code, `<div class="detail-title">${esc(course.title)}</div><div class="detail-heading muted">${esc(term.name)} · ${esc(course.credits || '—')} 学分 ${waitTag(waiting(course))}</div><p class="field-hint">课表时区：${esc(term.timezone || 'America/Toronto')}</p>${rows || '<div class="meeting-detail">时间待定 · TBA<br><span class="muted">这门课程尚未安排上课时间。</span></div>'}<div class="dialog-actions"><button class="secondary-btn" data-action="edit-course">编辑课程</button><button class="primary-btn" data-action="export-course">导出此课程</button></div>`, context);
}
function field(label, name, value = '', type = 'text', extra = '') {
  return `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;
}
function meetingFields(m = {}, index = null) {
  return `<fieldset class="meeting-fields" ${index == null ? '' : `data-original-index="${index}"`}><legend>上课时间</legend><div class="form-grid">
    <label class="field"><span>星期</span><select name="day">${WEEKDAY.slice(1).map((d, i) => `<option value="${i + 1}" ${m.day === i + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
    ${field('班号', 'section', m.section || 'LEC0101', 'text', 'maxlength="80"')}
    ${field('开始', 'start', m.start || '09:00', 'time', 'required')}${field('结束', 'end', m.end || '10:00', 'time', 'required')}
    ${field('教室 / Room', 'room', m.room || m.location || '', 'text', 'maxlength="300" placeholder="例如 BA 1160"')}${field('地址 / Address', 'address', m.address || '', 'text', 'maxlength="1000" placeholder="用于地图导航的完整地址"')}
    ${field('首次上课（可选）', 'from', m.from || '', 'date')}${field('最后上课（可选）', 'until', m.until || '', 'date')}
    <label class="field"><span>班级状态</span><select name="meetingStatus"><option value="enrolled" ${!waiting(null, m) ? 'selected' : ''}>已选课</option><option value="waitlisted" ${waiting(null, m) ? 'selected' : ''}>候补 · Waitlisted</option></select></label>
    <label class="field"><span>停课日期（逗号分隔）</span><input name="exdates" value="${esc((m.exdates || []).join(', '))}" placeholder="2026-10-26, 2026-10-27"></label>
    </div><button type="button" class="text-btn remove-meeting" data-action="remove-meeting">移除此上课时间</button></fieldset>`;
}
function editCourse(context = null) {
  const term = context?.term || activeTerm();
  const course = context?.course || {};
  const meetings = context ? term.meetings.map((m, index) => ({ m, index })).filter(({ m }) => m.code === course.code && timed(m)) : [];
  const year = wallClock(new Date()).getUTCFullYear();
  openDialog(context ? `编辑 ${course.code}` : '添加课程', `<form id="course-form"><p class="field-hint">修改只保存在本地，不会更改 ACORN 选课。无上课时间的课程显示为 TBA。</p>
    ${context ? `<p class="muted">${esc(term.name)}</p>` : `<label class="field"><span>学期</span><select id="course-term" name="term">${(ui.data?.terms || []).map((t) => `<option value="${esc(t.id)}" ${t === term ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}<option value="__new__" ${!term ? 'selected' : ''}>＋ 新建学期</option></select></label>`}
    <fieldset id="new-term-fields" ${term ? 'hidden disabled' : ''}><legend>新学期</legend><div class="form-grid">${field('学期名称', 'termName', `${year} 学期`, 'text', 'required maxlength="100"')}${field('时区', 'timezone', 'America/Toronto', 'text', 'required')}${field('开始日期', 'termStart', `${year}-09-01`, 'date', 'required')}${field('结束日期', 'termEnd', `${year}-12-31`, 'date', 'required')}</div></fieldset>
    <div class="form-grid">${field('课程代码', 'code', course.code, 'text', 'required maxlength="80" placeholder="CSC373H1"')}${field('学分', 'credits', course.credits ?? '0.50', 'text', 'maxlength="30"')}<label class="field full-width"><span>课程名称</span><input name="title" value="${esc(course.title || '')}" required maxlength="500"></label><label class="field"><span>课程状态</span><select name="status"><option value="enrolled" ${!waiting(course) ? 'selected' : ''}>已选课</option><option value="waitlisted" ${waiting(course) ? 'selected' : ''}>候补 · Waitlisted</option></select></label></div>
    <div id="meeting-fields">${meetings.map(({ m, index }) => meetingFields(m, index)).join('')}</div><p id="tba-hint" class="field-hint" ${meetings.length ? 'hidden' : ''}>时间待定 · TBA：此课程没有定时事件。</p><button type="button" class="secondary-btn" data-action="add-meeting">＋ 添加上课时间</button>
    <p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-action="close-dialog">取消</button><button class="primary-btn" type="submit">保存课程</button></div></form>`, context);
}
async function saveCourse(form) {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const fields = new FormData(form);
    const data = clone(ui.data || { terms: [], transcript: null });
    let term = data.terms.find((t) => t.id === (dialogContext?.term.id || fields.get('term')));
    if (!term) {
      term = { id: `local-${Date.now()}`, name: String(fields.get('termName')).trim(), start: fields.get('termStart'), end: fields.get('termEnd'), timezone: String(fields.get('timezone')).trim(), courses: [], meetings: [] };
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
    closeDialog(); render(); notify('课程已保存在本地');
  } catch (error) { $('#form-error').textContent = error.message || '无法保存课程'; }
  finally { submit.disabled = false; }
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
function exportDialog(onlyCode = null, termOverride = null) {
  const term = termOverride || activeTerm();
  if (!term) { notify('请先添加课程或导入课表'); return; }
  const codes = onlyCode ? [onlyCode] : term.courses.filter((c) => selected.has(c.code)).map((c) => c.code);
  openDialog('导出课表', `<form id="export-form"><p class="field-hint">${esc(term.name)} · ${codes.length ? `已选 ${codes.length} 门课程` : '整个学期'}。日历文件可导入 Apple、Google、Outlook 等日历。</p>
    <label class="field"><span>范围</span><select name="scope">${codes.length ? '<option value="selected">已选课程</option>' : ''}<option value="term">整个学期</option><option value="all">所有数据（JSON，包含成绩）</option></select></label>
    <label class="field"><span>文件格式</span><select name="format"><option value="ics">日历 · ICS</option><option value="json">本地数据 · JSON</option></select></label>
    <label class="check-field" id="waitlist-option"><input type="checkbox" name="includeWaitlisted">日历包含候补课程（默认排除）</label><p class="field-hint" id="export-hint">TBA 课程不会生成日历事件。保留时区、上课日期范围和停课日期。请自行核对 TUT / PRA 等班级的特殊停课日，学期假期不一定完整。JSON 始终保留候补课程。</p>
    <p class="form-error" id="export-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-action="close-dialog">取消</button><button class="primary-btn" type="submit">导出文件</button></div></form>`, { term, codes });
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
    if (saved) { closeDialog(); notify(format === 'ics' ? '日历文件已导出' : 'JSON 文件已导出'); }
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
  ['detail', { label: '查看课程详情', run: detail }],
  ['edit', { label: '编辑课程', run: editCourse }],
  ['export', { label: '导出此课程…', run: (context) => exportDialog(context.course.code, context.term) }],
  ['google', { label: 'Google 地图 ↗', visible: (context) => !!context.meeting && !!window.CourseTools.buildMapUrl(context.meeting, { provider: 'google' }), run: (context) => openMap(context, 'google') }],
  ['amap', { label: '高德地图 ↗', visible: (context) => !!context.meeting && !!window.CourseTools.buildMapUrl(context.meeting, { provider: 'amap' }), run: (context) => openMap(context, 'amap') }],
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
  const actions = context ? [...courseActions].filter(([, action]) => !action.visible || action.visible(context)).map(([id, action]) => `<button role="menuitem" data-context-action="${esc(id)}">${esc(action.label)}</button>`).join('') : `<button role="menuitem" data-action="add-course">＋ 添加课程</button><button role="menuitem" data-action="import">导入 JSON…</button><button role="menuitem" data-action="export">导出课表…</button>${bridge?.clearData && ui.data ? '<button role="menuitem" data-action="clear-local">清除本地课表与成绩…</button>' : ''}<hr><button role="menuitem" data-action="login">登录 ACORN</button><button role="menuitem" data-action="refresh">刷新 ACORN</button>${!preview && bridge?.openMenu ? '<button role="menuitem" data-action="native-menu">窗口与 ACORN 选项…</button>' : ''}`;
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
function cancelPress() { if (longPress) clearTimeout(longPress.timer); longPress = null; }
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#context-menu')) closeMenu();
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
document.addEventListener('pointercancel', () => { heldContext = false; suppressClickUntil = 0; cancelPress(); });
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
    case 'add-meeting': $('#meeting-fields').insertAdjacentHTML('beforeend', meetingFields()); $('#tba-hint').hidden = true; break;
    case 'remove-meeting': el.closest('.meeting-fields').remove(); $('#tba-hint').hidden = !!$('#meeting-fields').children.length; break;
    case 'calendar-preview': {
      const context = dialogContext;
      const event = nextCalendarEvent(context.term, context.course, context.term.meetings[Number(el.dataset.index)]);
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
      try { await persist(dialogContext.importData); ui.termId = null; selected.clear(); closeDialog(); render(); notify('JSON 已导入并保存在本地'); }
      catch (error) { $('#import-error').textContent = error.message; el.disabled = false; }
      break;
    case 'export': exportDialog(); break;
  }
}
document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-tab], [data-term], [data-action], [data-course], [data-context-action]');
  if (!el) return;
  if (el.dataset.course && Date.now() < suppressClickUntil) { suppressClickUntil = 0; event.preventDefault(); return; }
  try {
    if (el.dataset.contextAction) {
      const context = menuContext, item = courseActions.get(el.dataset.contextAction); closeMenu();
      if (context) await item?.run(context);
    } else if (el.dataset.tab) {
      if (ui.tab !== el.dataset.tab) $('#view').scrollTop = 0;
      ui.tab = el.dataset.tab; store.set('tab', ui.tab); render();
    } else if (el.dataset.term) { ui.termId = el.dataset.term; selected.clear(); render(); }
    else if (el.dataset.action) { if (el.dataset.action !== 'menu') closeMenu(); await action(el.dataset.action, el, event); }
    else if (el.dataset.course) { const context = contextFromElement(el); if (context) detail(context); }
  } catch (error) { notify(error.message || '操作失败'); }
});
document.addEventListener('change', (event) => {
  const el = event.target;
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
  if (event.target.id === 'course-form') { event.preventDefault(); saveCourse(event.target); }
  if (event.target.id === 'export-form') { event.preventDefault(); submitExport(event.target); }
});
