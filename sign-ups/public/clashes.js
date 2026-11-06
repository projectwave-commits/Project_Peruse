// Timetable display and clash detection, used by the student and staff screens and the tests.
(function (root) {
  const minutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  /** "14:00" -> "2:00", matching how the school's timetables show afternoon times. */
  const clock = (mins) => {
    const h = Math.floor(mins / 60);
    return `${h > 12 ? h - 12 : h}:${String(mins % 60).padStart(2, '0')}`;
  };

  const range = (start, end) => `${clock(start)}-${clock(end)}`;

  /** [{day, start, end, session}] -> "Mon & Wed 2:00-3:00", or "A: Tue 2:00-3:00, B: Tue 3:00-4:00". */
  function formatTimes(times) {
    const groups = new Map();
    for (const t of times) {
      const key = `${t.session || ''}|${t.start}|${t.end}`;
      if (!groups.has(key)) groups.set(key, { ...t, days: [] });
      groups.get(key).days.push(t.day);
    }
    return [...groups.values()].map((g) => {
      const when = `${g.days.join(' & ')} ${range(minutes(g.start), minutes(g.end))}`;
      return g.session ? `${g.session}: ${when}` : when;
    }).join(', ');
  }

  /**
   * items: [{ name, times, sessions }]. `sessions` is the student's chosen sessions, for options
   * that have them. Returns [{ a, b, when }] for each pair of choices that overlap.
   */
  function findClashes(items) {
    const active = items.map((item) => ({
      name: item.name,
      times: (item.times || []).filter((t) => !t.session || (item.sessions || []).includes(t.session)),
    }));
    const clashes = [];
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const when = [];
        for (const x of active[i].times) {
          for (const y of active[j].times) {
            if (x.day !== y.day) continue;
            const start = Math.max(minutes(x.start), minutes(y.start));
            const end = Math.min(minutes(x.end), minutes(y.end));
            if (start < end) {
              const text = `${x.day} ${range(start, end)}`;
              if (!when.includes(text)) when.push(text);
            }
          }
        }
        if (when.length) clashes.push({ a: active[i].name, b: active[j].name, when });
      }
    }
    return clashes;
  }

  const describeClash = (c) => `${c.a} and ${c.b} overlap on ${c.when.join(', ')}`;

  const api = { formatTimes, findClashes, describeClash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof window !== 'undefined' ? window : globalThis));
