/**
 * Симуляція воронки L1→L2→L3→L4 для M0-когорти на M0..M3.
 *
 * Кожному не-dormant клієнту призначається:
 *   - firstTxAtMs: час першої транзакції, медіана ~5 днів після випуску,
 *     максимум 60 днів (dormant мають null)
 *   - monthlyTxBaseline[0..3]: базова кількість транзакцій на кожен з 4 місяців
 *     (відображає архетип)
 *   - monthlyRevolverTx[0..3]: з них скільки револьверних
 *   - viewsAffinity / selectionAffinity: схильність переглядати/обирати MCC
 *
 * Ці числа далі використовуються для:
 *   - масштабування до цільового діапазону подій (--tx-min/--max і т.д.)
 *   - правильного розподілу подій по клієнтах і по місяцях
 */

import { exponentialDelayMs, randInt, randFloat } from "./utils.js";

/**
 * Налаштування архетипів: базова кількість tx на місяць (M0..M3),
 * частка револьверних tx у місяцях M2/M3, схильність до переглядів/вибору MCC.
 *
 * M0: тільки кінець місяця, активність мінімальна.
 * M1: перші покупки, welcome-бонус, boost.
 * M2: habitual поведінка, milestone.
 * M3: пікова активність, можливий перехід у револьвера.
 */
const ARCHETYPE_PROFILES = {
  dormant: {
    baseline: [0, 0, 0, 0],
    revolverShare: [0, 0, 0, 0],
    viewsAffinity: 0.2,
    selectionAffinity: 0.05,
    firstTxMedianDays: null,
  },
  occasional: {
    baseline: [0.2, 1.6, 1.4, 1.1],
    revolverShare: [0, 0, 0, 0],
    viewsAffinity: 0.9,
    selectionAffinity: 0.45,
    firstTxMedianDays: 9,
  },
  habitual: {
    baseline: [0.3, 3.5, 6.0, 6.5],
    revolverShare: [0, 0, 0, 0],
    viewsAffinity: 1.6,
    selectionAffinity: 1.2,
    firstTxMedianDays: 5,
  },
  revolver: {
    baseline: [0.4, 4.0, 7.5, 9.0],
    revolverShare: [0, 0, 0.18, 0.38],
    viewsAffinity: 1.8,
    selectionAffinity: 1.5,
    firstTxMedianDays: 4,
  },
};

function monthIndexForMs(ms, months) {
  for (let i = 0; i < months.length; i++) {
    if (ms >= months[i].startMs && ms <= months[i].endMs) return i;
  }
  return -1;
}

/**
 * Розгортає траєкторію кожного клієнта.
 * @param {object[]} clients
 * @param {{startMs:number,endMs:number}[]} months  - 4 місяці M0..M3
 * @param {Function} rng
 * @returns {object[]} trajectories (aligned by index with clients)
 */
export function buildTrajectories(clients, months, rng) {
  const trajectories = new Array(clients.length);

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const profile = ARCHETYPE_PROFILES[c.archetype];

    let firstTxAtMs = null;
    let firstTxMonth = -1;
    if (profile.firstTxMedianDays) {
      const delay = exponentialDelayMs(rng, profile.firstTxMedianDays, 60);
      const candidate = c.opened_at_ms + delay;
      const maxMs = months[months.length - 1].endMs;
      if (candidate <= maxMs) {
        firstTxAtMs = candidate;
        firstTxMonth = monthIndexForMs(firstTxAtMs, months);
      } else {
        firstTxAtMs = null;
      }
    }

    const baseline = profile.baseline.map((b) =>
      Math.max(0, b * randFloat(rng, 0.7, 1.3))
    );

    if (firstTxMonth > 0) {
      for (let m = 0; m < firstTxMonth; m++) baseline[m] = 0;
    }

    const revolverShare = profile.revolverShare;

    trajectories[i] = {
      client_id: c.client_id,
      card_id: c.card_id,
      archetype: c.archetype,
      opened_at_ms: c.opened_at_ms,
      firstTxAtMs,
      firstTxMonth,
      monthlyTxBaseline: baseline,
      monthlyRevolverShare: revolverShare,
      viewsAffinity: profile.viewsAffinity,
      selectionAffinity: profile.selectionAffinity,
    };
  }

  return trajectories;
}

/**
 * Масштабування per-client baseline до цільового N на кожен місяць.
 *
 * target[m] = random у [min, max] з CLI.
 * Пропорційно до baseline, з випадковим шумом, округленням до integer
 * через ймовірнісне округлення (stochastic rounding).
 *
 * Якщо natural-сума по місяцю = 0 (наприклад, усі dormant у M0), target = 0.
 *
 * @param {object[]} trajectories
 * @param {'monthlyTxBaseline'|'viewsAffinity'|'selectionAffinity'} key
 * @param {number[]} targets - цільова кількість на кожен місяць
 * @param {Function} rng
 * @returns {number[][]} перелік [client][month] з кількостями подій
 */
export function allocateMonthlyCounts(trajectories, key, targets, rng) {
  const monthsCount = targets.length;
  const clientCount = trajectories.length;

  const perClient = new Array(clientCount);
  for (let i = 0; i < clientCount; i++) {
    perClient[i] = new Array(monthsCount).fill(0);
  }

  for (let m = 0; m < monthsCount; m++) {
    let natural = 0;
    const weights = new Array(clientCount);
    for (let i = 0; i < clientCount; i++) {
      let w;
      if (key === "monthlyTxBaseline") {
        w = trajectories[i].monthlyTxBaseline[m];
      } else if (key === "viewsAffinity") {
        w = trajectories[i].viewsAffinity * (m === 0 ? 0.6 : 1);
      } else if (key === "selectionAffinity") {
        w = trajectories[i].selectionAffinity * (m === 0 ? 0.4 : 1);
      } else {
        w = 0;
      }
      weights[i] = Math.max(0, w);
      natural += weights[i];
    }

    if (natural <= 0 || targets[m] <= 0) continue;

    const scale = targets[m] / natural;

    let assigned = 0;
    for (let i = 0; i < clientCount; i++) {
      const expected = weights[i] * scale;
      const floor = Math.floor(expected);
      const frac = expected - floor;
      const extra = rng() < frac ? 1 : 0;
      perClient[i][m] = floor + extra;
      assigned += perClient[i][m];
    }

    // Корекція до точного target (±кілька одиниць через округлення)
    let diff = targets[m] - assigned;
    let guard = 0;
    while (diff !== 0 && guard++ < 10000) {
      const idx = Math.floor(rng() * clientCount);
      if (diff > 0 && weights[idx] > 0) {
        perClient[idx][m] += 1;
        diff -= 1;
      } else if (diff < 0 && perClient[idx][m] > 0) {
        perClient[idx][m] -= 1;
        diff += 1;
      }
    }
  }

  return perClient;
}

/**
 * Для конкретного клієнта і місяця повертає перелік револьверних tx
 * (як частку від загальної кількості tx у цьому місяці).
 */
export function revolverCountForClientMonth(trajectory, totalTxThisMonth, rng) {
  const share = trajectory.monthlyRevolverShare[0]; // placeholder, used per month below
  return Math.floor(totalTxThisMonth * share);
}

export function revolverCountByMonth(trajectory, counts) {
  const out = new Array(counts.length);
  for (let m = 0; m < counts.length; m++) {
    const share = trajectory.monthlyRevolverShare[m] || 0;
    out[m] = Math.min(counts[m], Math.round(counts[m] * share));
  }
  return out;
}
