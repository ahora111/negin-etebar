/* ===================== JALALI (SHAMSI) CALENDAR UTILS ===================== */
const JalaliUtils = (() => {
  function div(a, b) { return Math.trunc(a / b); }
  function mod(a, b) { return a - Math.trunc(a / b) * b; }

  const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

  function jalCal(jy) {
    const bl = BREAKS.length;
    const gy = jy + 621;
    let leapJ = -14, jp = BREAKS[0], jump = 0;
    if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error('سال شمسی نامعتبر: ' + jy);
    for (let i = 1; i < bl; i += 1) {
      const jm = BREAKS[i];
      jump = jm - jp;
      if (jy < jm) break;
      leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
      jp = jm;
    }
    let n = jy - jp;
    leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
    if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
    const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
    const march = 20 + leapJ - leapG;
    if (jump - n < 6) n = n - jump + div(jump, 4) * 4;
    let leap = mod(mod(n + 1, 33) - 1, 4);
    if (leap === -1) leap = 4;
    return { leap, gy, march };
  }

  function g2d(gy, gm, gd) {
    let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4)
      + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
    d = d - div(div(gy + div(gm - 8, 6) + 100100, 100) * 3, 4) + 752;
    return d;
  }

  function d2g(jdn) {
    let j = 4 * jdn + 139361631;
    j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
    const i = div(mod(j, 1461), 4) * 5 + 308;
    const gd = div(mod(i, 153), 5) + 1;
    const gm = mod(div(i, 153), 12) + 1;
    const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
    return { gy, gm, gd };
  }

  function j2d(jy, jm, jd) {
    const r = jalCal(jy);
    return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
  }

  function d2j(jdn) {
    const gy = d2g(jdn).gy;
    let jy = gy - 621;
    const r = jalCal(jy);
    const jdn1f = g2d(gy, 3, r.march);
    let k = jdn - jdn1f;
    if (k >= 0) {
      if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
      k -= 186;
    } else {
      jy -= 1;
      k += 179;
      if (r.leap === 1) k += 1;
    }
    return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
  }

  function toJalali(gy, gm, gd) {
    const j = d2j(g2d(gy, gm, gd));
    return [j.jy, j.jm, j.jd];
  }
  function toGregorian(jy, jm, jd) {
    const g = d2g(j2d(jy, jm, jd));
    return [g.gy, g.gm, g.gd];
  }
  function isLeapJalaliYear(jy) { return jalCal(jy).leap === 0; }
  function jalaliMonthLength(jy, jm) {
    if (jm <= 6) return 31;
    if (jm <= 11) return 30;
    return isLeapJalaliYear(jy) ? 30 : 29;
  }

  const MONTH_NAMES = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

  function todayJalali() {
    const now = new Date();
    return toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  // Reads {gy, gm, gd} out of either a bare "YYYY-MM-DD" calendar date or a full ISO
  // timestamp. These need DIFFERENT handling: a bare date has no instant/timezone of its
  // own, so its digits must be read directly. A full timestamp IS a real instant, so it's
  // correctly resolved through Date + local getters. Mixing the two up - parsing a bare
  // date via `new Date()` (which JS treats as UTC midnight) and then reading it back with
  // LOCAL getters - shows the wrong calendar day entirely on any device whose timezone is
  // behind UTC (e.g. the Americas): not off by an hour, off by a whole day.
  function gregorianPartsFromISO(iso) {
    const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (bare) return { gy: Number(bare[1]), gm: Number(bare[2]), gd: Number(bare[3]) };
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return { gy: d.getFullYear(), gm: d.getMonth() + 1, gd: d.getDate() };
  }

  // ISO date string (YYYY-MM-DD or full ISO datetime) -> "۱۴ مهر ۱۴۰۳" style string
  function isoToJalaliStr(iso) {
    if (!iso) return '—';
    const g = gregorianPartsFromISO(iso);
    if (!g) return '—';
    const [jy, jm, jd] = toJalali(g.gy, g.gm, g.gd);
    return `${toFa(jd)} ${MONTH_NAMES[jm - 1]} ${toFa(jy)}`;
  }

  function jalaliToISODate(jy, jm, jd) {
    const [gy, gm, gd] = toGregorian(jy, jm, jd);
    const pad = n => String(n).padStart(2, '0');
    return `${gy}-${pad(gm)}-${pad(gd)}`;
  }

  function toFa(n) {
    const digits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    return String(n).replace(/[0-9]/g, d => digits[d]);
  }

  return { toJalali, toGregorian, MONTH_NAMES, jalaliMonthLength, todayJalali, isoToJalaliStr, jalaliToISODate, toFa, gregorianPartsFromISO };
})();

/* ---------- Reusable Jalali date-select widget (day/month/year dropdowns) ---------- */
// Builds three <select> elements inside `container`, initialized from `isoValue` (or today).
// Returns { getISO(): 'YYYY-MM-DD', setISO(iso) }
function buildJalaliDateSelects(container, isoValue) {
  container.classList.add('jalali-date-selects');
  const daySel = document.createElement('select');
  const monthSel = document.createElement('select');
  const yearSel = document.createElement('select');
  daySel.className = 'jd-day'; monthSel.className = 'jd-month'; yearSel.className = 'jd-year';

  const nowJ = JalaliUtils.todayJalali();
  const curYear = nowJ[0];
  for (let y = curYear + 2; y >= curYear - 15; y--) yearSel.add(new Option(JalaliUtils.toFa(y), y));
  JalaliUtils.MONTH_NAMES.forEach((m, i) => monthSel.add(new Option(m, i + 1)));

  function rebuildDays(jy, jm, selectedDay) {
    const len = JalaliUtils.jalaliMonthLength(Number(jy), Number(jm));
    const prev = selectedDay || Number(daySel.value) || 1;
    daySel.innerHTML = '';
    for (let d = 1; d <= len; d++) daySel.add(new Option(JalaliUtils.toFa(d), d));
    daySel.value = Math.min(prev, len);
  }

  let initJ;
  const initG = isoValue ? JalaliUtils.gregorianPartsFromISO(isoValue) : null;
  if (initG) {
    initJ = JalaliUtils.toJalali(initG.gy, initG.gm, initG.gd);
  } else {
    initJ = nowJ;
  }
  yearSel.value = initJ[0];
  monthSel.value = initJ[1];
  rebuildDays(initJ[0], initJ[1], initJ[2]);

  monthSel.addEventListener('change', () => rebuildDays(yearSel.value, monthSel.value));
  yearSel.addEventListener('change', () => rebuildDays(yearSel.value, monthSel.value));

  container.appendChild(yearSel);
  container.appendChild(monthSel);
  container.appendChild(daySel);

  return {
    getISO() {
      return JalaliUtils.jalaliToISODate(Number(yearSel.value), Number(monthSel.value), Number(daySel.value));
    },
    setISO(iso) {
      const g = JalaliUtils.gregorianPartsFromISO(iso);
      if (!g) return;
      const [jy, jm, jd] = JalaliUtils.toJalali(g.gy, g.gm, g.gd);
      yearSel.value = jy; monthSel.value = jm; rebuildDays(jy, jm, jd);
    }
  };
}
