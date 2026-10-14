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
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoDay = (d) => ((d.getDay() + 6) % 7) + 1;
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
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

const ui = { data: null, status: { state: 'idle' }, pinned: false, tab: store.get('tab', 'today'), termId: null };
let bridge;

// ---- 今天 ----

// 这一天是否真的上课：星期对得上、在起止日期内、不是停课日（Reading Week、假期）
const occursOn = (m, d) =>
  m.day === isoDay(d) && (!m.from || ymd(d) >= m.from) && (!m.until || ymd(d) <= m.until) && !(m.exdates || []).includes(ymd(d));

function classesOn(terms, d) {
  const seen = new Set();
  return terms
    .filter((t) => inTerm(t, d))
    .flatMap((t) => t.meetings.filter((m) => occursOn(m, d)).map((m) => ({ ...m, s: toMin(m.start), e: toMin(m.end), h: hueFor(t, m.code) })))
    .filter((m) => {
      // 全年课会同时出现在秋、冬两个学期里
      const key = `${m.code}${m.section}${m.start}`;
      return !seen.has(key) && seen.add(key);
    })
    .sort((a, b) => a.s - b.s);
}

function nextClassHint(terms, now) {
  for (let offset = 1; offset <= 14; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const [first] = classesOn(terms, d);
    if (first) {
      const weeksAhead = Math.floor((offset + isoDay(now) - 1) / 7);
      const when =
        offset === 1 ? '明天'
        : weeksAhead === 0 ? WEEKDAY[isoDay(d)]
        : weeksAhead === 1 ? `下${WEEKDAY[isoDay(d)]}`
        : `${d.getMonth() + 1}月${d.getDate()}日`;
      return `下一节：${when} ${clock(first.s)} ${first.code}`;
    }
  }
  return '';
}

function heroCard(m, label, when, progress) {
  return `<div class="hero" style="--h:${m.h}">
    <div class="hero-top"><span class="hero-label">${label}</span><span class="hero-when">${when}</span></div>
    <div class="hero-code">${esc(m.code)}<span class="tag">${esc(m.section)}</span></div>
    <div class="hero-title">${esc(m.title)}</div>
    <div class="hero-meta"><span>${clock(m.s)}–${clock(m.e)}</span>${m.location ? `<span>${esc(m.location)}</span>` : ''}</div>
    ${progress == null ? '' : `<div class="progress"><i style="width:${progress}%"></i></div>`}
  </div>`;
}

function slot(m, nowMin) {
  const state = m.e <= nowMin ? 'past' : m.s <= nowMin ? 'now' : '';
  return `<li class="slot ${state}" style="--h:${m.h}">
    <div class="slot-time"><span>${clock(m.s)}</span><span>${clock(m.e)}</span></div>
    <div class="slot-bar"></div>
    <div>
      <div class="slot-title">${esc(m.code)}<span class="tag">${esc(m.section)}</span></div>
      <div class="slot-sub">${esc([m.location, m.title].filter(Boolean).join(' · '))}</div>
    </div>
  </li>`;
}

function viewToday(data, now) {
  const active = data.terms.filter((t) => inTerm(t, now));
  if (!active.length) {
    const next = data.terms.find((t) => t.start && t.start > ymd(now));
    return empty('现在不在上课期间', next ? `${next.name} 将于 ${fmtDate(next.start)} 开课` : '');
  }
  const items = classesOn(active, now);
  if (!items.length) return empty('今天没有课', nextClassHint(data.terms, now));

  const nowMin = now.getHours() * 60 + now.getMinutes();
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
  const meetings = term.meetings.map((m) => ({ ...m, s: toMin(m.start), e: toMin(m.end), h: hueFor(term, m.code) }));
  if (!meetings.length) return empty('这个学期还没有排课时间');

  const days = [1, 2, 3, 4, 5, ...[6, 7].filter((d) => meetings.some((m) => m.day === d))];
  const startH = Math.min(9, Math.floor(Math.min(...meetings.map((m) => m.s)) / 60));
  const endH = Math.max(17, Math.ceil(Math.max(...meetings.map((m) => m.e)) / 60));
  const span = (endH - startH) * 60;
  const pct = (min) => ((min - startH * 60) / span) * 100;
  const todayCol = inTerm(term, now) ? isoDay(now) : 0;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const head = days.map((d) => `<span class="${d === todayCol ? 'is-today' : ''}">${WEEKDAY[d].slice(1)}</span>`).join('');
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => `<span style="top:${(i / (endH - startH)) * 100}%">${startH + i}</span>`).join('');
  const columns = days
    .map((d) => {
      const blocks = layoutLanes(meetings.filter((m) => m.day === d))
        .map((m) => {
          const tip = `${m.code} ${m.section}\n${m.title}\n${WEEKDAY[m.day]} ${clock(m.s)}–${clock(m.e)} ${m.location}`;
          const room = m.e - m.s >= 90 && m.location ? `<span>${esc(m.location)}</span>` : '';
          return `<div class="block" title="${esc(tip)}" style="--h:${m.h};--lane:${m.lane};--lanes:${m.lanes};top:${pct(m.s)}%;height:${((m.e - m.s) / span) * 100}%">
            <b>${esc(m.code.replace(/[HY]\d$/, ''))}</b><span>${esc(m.kind)}</span>${room}</div>`;
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
  const courses = term.courses
    .map((c) => `<li style="--h:${hueFor(term, c.code)}"><span class="dot"></span><b>${esc(c.code)}</b><span class="course-title">${esc(c.title)}</span><span class="credits">${esc(c.credits)}</span></li>`)
    .join('');
  return `<div class="chips">${chips}</div>${week(term, now)}<ul class="course-list">${courses}</ul>`;
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
  if (state === 'error') return `${empty('加载失败', message)}<div class="empty"><button class="primary-btn" data-action="refresh">重试</button></div>`;
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
    const d = new Date(ui.data.fetchedAt);
    when = ymd(d) === ymd(new Date()) ? `今天 ${clock(d.getHours() * 60 + d.getMinutes())}` : `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  if (state === 'loading') return '<span>正在刷新…</span>';
  if (!ui.data) return '';
  if (state === 'login') return `<span>登录已过期 · 数据更新于${when}</span><button class="link" data-action="login">重新登录</button>`;
  if (state === 'error') return `<span title="${esc(message)}">刷新失败 · 数据更新于${when}</span><button class="link" data-action="refresh">重试</button>`;
  return `<span>更新于${when}</span>`;
}

function render() {
  const now = new Date();
  $('#date').textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAY[isoDay(now)]}`;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
  $('#btn-pin').setAttribute('aria-pressed', String(ui.pinned));
  $('#btn-refresh').classList.toggle('spinning', ui.status.state === 'loading');

  const view = $('#view');
  const scroll = view.scrollTop;
  if (!ui.data) view.innerHTML = viewNoData();
  else if (ui.tab === 'term') view.innerHTML = viewTerm(ui.data, now);
  else if (ui.tab === 'grades') view.innerHTML = viewGrades(ui.data);
  else view.innerHTML = viewToday(ui.data, now);
  view.scrollTop = scroll;
  $('#footer').innerHTML = footer();
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-tab], [data-term], [data-action]');
  if (!el) return;
  if (el.dataset.tab) {
    if (ui.tab !== el.dataset.tab) $('#view').scrollTop = 0;
    ui.tab = el.dataset.tab;
    store.set('tab', ui.tab);
  } else if (el.dataset.term) {
    ui.termId = el.dataset.term;
  } else {
    const action = { login: bridge.login, refresh: bridge.refresh, pin: bridge.togglePin, menu: bridge.openMenu }[el.dataset.action];
    action?.();
  }
  render();
});

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

(async function init() {
  bridge = window.acorn ?? (await loadMock());
  bridge.onUpdate((payload) => {
    if ('data' in payload) ui.data = payload.data;
    if (payload.status) ui.status = payload.status;
    render();
  });
  bridge.onPinned((pinned) => {
    ui.pinned = pinned;
    render();
  });
  Object.assign(ui, await bridge.getState());
  render();
  setInterval(render, 30_000);
})();
