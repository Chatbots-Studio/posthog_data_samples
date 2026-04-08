const CASHBACK_TYPE_IDS = ["cat_food", "fuel", "groceries", "pharmacy", "coffee", "transport"];

export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym?.trim() || "");
  if (!m) {
    throw new Error("Очікується YYYY-MM, наприклад 2026-03");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error("Некоректний місяць");
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return {
    year,
    month,
    start,
    end,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickSubset(arr, count, rng = Math.random) {
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

function iso(ms) {
  return new Date(ms).toISOString();
}

function randomTimeInMonth(startMs, endMs) {
  return startMs + Math.floor(Math.random() * (endMs - startMs + 1));
}

function distinctIdClient(i) {
  return `test_client_${String(i).padStart(5, "0")}`;
}

export const EVENT_FILES = {
  views: "cashback_section_viewed.json",
  selections: "cashback_types_selected.json",
  transactions: "client_transaction.json",
};

/**
 * 1) 5000 переглядів; 2) 2000 виборів; 3) 30000 транзакцій / 8000 клієнтів
 */
export function buildEvents(monthYm) {
  const { start, end, startMs, endMs, year, month } = monthRange(monthYm);

  const periodStart = start.toISOString().slice(0, 10);
  const periodEnd = end.toISOString().slice(0, 10);

  const viewerIds = Array.from({ length: 5000 }, (_, i) => distinctIdClient(i + 1));
  const viewTimes = new Map();

  const views = [];
  for (let i = 0; i < viewerIds.length; i++) {
    const distinct_id = viewerIds[i];
    const ts = randomTimeInMonth(startMs, endMs);
    viewTimes.set(distinct_id, ts);
    views.push({
      event: "cashback_section_viewed",
      properties: {
        distinct_id,
        period_start: periodStart,
        period_end: periodEnd,
        available_cashback_type_ids: pickSubset(CASHBACK_TYPE_IDS, randomInt(3, 6)),
        app_platform: "mobile",
      },
      timestamp: iso(ts),
    });
  }

  const selectedViewers = pickSubset(viewerIds, 2000);
  const selections = [];
  for (const distinct_id of selectedViewers) {
    const base = viewTimes.get(distinct_id);
    const delayMs = randomInt(2 * 60 * 1000, 15 * 60 * 1000);
    const ts = Math.min(base + delayMs, endMs);
    const selected_cashback_type_ids = pickSubset(CASHBACK_TYPE_IDS, randomInt(1, 4));
    selections.push({
      event: "cashback_types_selected",
      properties: {
        distinct_id,
        period_start: periodStart,
        period_end: periodEnd,
        selected_cashback_type_ids,
        app_platform: "mobile",
      },
      timestamp: iso(ts),
    });
  }

  const TX_CLIENTS = 8000;
  const TX_TOTAL = 30000;
  const viewerSet = new Set(viewerIds);
  const selectedSet = new Set(selectedViewers);

  const transactions = [];
  for (let t = 0; t < TX_TOTAL; t++) {
    const clientIndex = randomInt(1, TX_CLIENTS);
    const distinct_id = distinctIdClient(clientIndex);

    const had_viewed_cashback_section = viewerSet.has(distinct_id);
    const had_selected_cashback_types = selectedSet.has(distinct_id);

    const amount = randomInt(50, 15000) + Math.random();
    const amountRounded = Math.round(amount * 100) / 100;

    let cashback_credited;
    if (had_selected_cashback_types) {
      cashback_credited = Math.random() < 0.72;
    } else if (had_viewed_cashback_section) {
      cashback_credited = Math.random() < 0.35;
    } else {
      cashback_credited = Math.random() < 0.08;
    }

    let cashback_amount = 0;
    if (cashback_credited) {
      const rate = 0.003 + Math.random() * (0.08 - 0.003);
      cashback_amount = Math.round(amountRounded * rate * 100) / 100;
      if (cashback_amount < 0.01) {
        cashback_amount = 0.01;
      }
    }

    const ts = randomTimeInMonth(startMs, endMs);
    transactions.push({
      event: "client_transaction",
      properties: {
        distinct_id,
        amount: amountRounded,
        currency: "UAH",
        cashback_credited,
        cashback_amount,
        had_viewed_cashback_section,
        had_selected_cashback_types,
        merchant_category: pickSubset(
          ["retail", "food", "services", "transport", "other"],
          1
        )[0],
      },
      timestamp: iso(ts),
    });
  }

  return {
    meta: {
      month: `${year}-${String(month).padStart(2, "0")}`,
      period_start: periodStart,
      period_end: periodEnd,
      year,
      month_number: month,
    },
    views,
    selections,
    transactions,
  };
}

export function filterEvents(data, only) {
  switch (only) {
    case "views":
      return data.views;
    case "selections":
      return data.selections;
    case "transactions":
      return data.transactions;
    case "all":
      return [...data.views, ...data.selections, ...data.transactions];
    default:
      throw new Error("--only має бути: all | views | selections | transactions");
  }
}
