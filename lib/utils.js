/**
 * Спільні утиліти: детермінований PRNG (mulberry32), рандом-хелпери,
 * час у місяці, генерація ID.
 */

export function createRng(seed) {
  if (seed == null || seed === "") return Math.random;
  let s = typeof seed === "number" ? seed >>> 0 : hashStringToSeed(String(seed));
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randInt(rng, min, max) {
  if (max < min) [min, max] = [max, min];
  return min + Math.floor(rng() * (max - min + 1));
}

export function randFloat(rng, min, max) {
  return min + rng() * (max - min);
}

export function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function pickSubset(rng, arr, count) {
  const copy = [...arr];
  const out = [];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    out.push(copy[i]);
  }
  return out;
}

export function pickWeighted(rng, items) {
  let total = 0;
  for (const it of items) total += it.weight;
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it.value;
  }
  return items[items.length - 1].value;
}

/**
 * Вибірка індексу зі списку ваг, з заміною. Для великих обсягів
 * використовуємо alias-метод (O(1) на вибірку) коли списків > 1000.
 */
export function buildWeightedSampler(weights) {
  const n = weights.length;
  if (n === 0) throw new Error("weights порожній");

  let sum = 0;
  for (let i = 0; i < n; i++) sum += weights[i];
  if (sum <= 0) {
    const uniform = 1 / n;
    return (rng) => Math.floor(rng() * n);
  }

  // Кумулятивний масив (двійковий пошук, O(log n))
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i] / sum;
    cdf[i] = acc;
  }
  cdf[n - 1] = 1;

  return (rng) => {
    const r = rng();
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (r < cdf[mid]) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Межі календарного місяця YYYY-MM в UTC.
 */
export function monthBounds(year, monthNumber) {
  const start = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59, 999));
  return {
    year,
    month: monthNumber,
    key: `${year}-${String(monthNumber).padStart(2, "0")}`,
    startMs: start.getTime(),
    endMs: end.getTime(),
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

export function parseYearMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || "").trim());
  if (!m) throw new Error("Очікується YYYY-MM, наприклад 2026-03");
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error("Некоректний місяць");
  return { year, month };
}

/**
 * Повертає послідовність `count` місяців, починаючи з заданого.
 */
export function monthsSequence(startYm, count) {
  const { year, month } = parseYearMonth(startYm);
  const out = [];
  for (let i = 0; i < count; i++) {
    const total = (year * 12 + (month - 1)) + i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    out.push(monthBounds(y, m));
  }
  return out;
}

export function randomMsInRange(rng, startMs, endMs) {
  return startMs + Math.floor(rng() * (endMs - startMs + 1));
}

/**
 * Псевдо-UUID-v4-подібний рядок, детермінований через rng.
 */
export function uuid(rng) {
  const bytes = new Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(rng() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function padId(prefix, i, width = 6) {
  return `${prefix}_${String(i).padStart(width, "0")}`;
}

/**
 * Експоненціальний час (у мілісекундах) до події з заданою медіаною (у днях)
 * і верхньою межею (у днях). Використовується для часу до першої транзакції.
 */
export function exponentialDelayMs(rng, medianDays, maxDays) {
  const lambda = Math.LN2 / medianDays;
  let days;
  let guard = 0;
  do {
    const u = Math.max(1e-9, rng());
    days = -Math.log(u) / lambda;
    guard++;
  } while (days > maxDays && guard < 20);
  days = Math.min(days, maxDays);
  return Math.max(1, Math.round(days * 86400000));
}

/**
 * Округлення грн до сотих.
 */
export function roundMoney(x) {
  return Math.round(x * 100) / 100;
}
