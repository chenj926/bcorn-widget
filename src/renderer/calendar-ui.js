/* Calendar presentation only: colors, compact labels and collision-safe geometry. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CalendarUI = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const colors = Object.freeze([
    { value: '#3976C6', name: '蓝色' }, { value: '#278767', name: '绿色' },
    { value: '#B9712C', name: '橙色' }, { value: '#B94D7A', name: '粉色' },
    { value: '#8161B4', name: '紫色' }, { value: '#288A9A', name: '青色' },
    { value: '#6B8438', name: '橄榄色' }, { value: '#BC5547', name: '红色' }
  ]);
  const validColor = (value) => /^#[0-9a-f]{6}$/i.test(value || '');
  function colorFor(term, code, meeting) {
    const course = term.courses.find((item) => item.code === code);
    return [meeting?.color, course?.color].find(validColor) || colors[Math.max(0, term.courses.indexOf(course)) % colors.length].value;
  }
  function colorStyle(term, code, meeting) { return `--event-color:${colorFor(term, code, meeting)}`; }
  function dateLabel(start, end) {
    const short = (date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    return end ? `${short(start)}–${short(end)}` : short(start);
  }
  function layoutLanes(meetings, minimumMinutes = 15) {
    const sorted = meetings.map((meeting) => ({ ...meeting })).sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [], clusterEnd = -1;
    const flush = () => {
      const lanes = [];
      for (const meeting of cluster) {
        let lane = lanes.findIndex((end) => end <= meeting.s);
        if (lane < 0) lane = lanes.push(0) - 1;
        lanes[lane] = Math.max(meeting.e, meeting.s + minimumMinutes);
        meeting.lane = lane;
      }
      for (const meeting of cluster) meeting.lanes = lanes.length;
      cluster = [];
    };
    for (const meeting of sorted) {
      if (cluster.length && meeting.s >= clusterEnd) { flush(); clusterEnd = -1; }
      cluster.push(meeting);
      clusterEnd = Math.max(clusterEnd, meeting.e, meeting.s + minimumMinutes);
    }
    flush();
    return sorted;
  }
  return Object.freeze({ colors, validColor, colorFor, colorStyle, dateLabel, layoutLanes });
}));
