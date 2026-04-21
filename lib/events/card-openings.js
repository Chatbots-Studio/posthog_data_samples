/**
 * Подія `card_activated` (таблиця 6.1 `card_openings` документа).
 * Генерується лише у M0 для кожного клієнта когорти.
 */

import { iso } from "../utils.js";

export function buildCardActivatedEvents(clients) {
  const out = new Array(clients.length);
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    out[i] = {
      event: "card_activated",
      properties: {
        distinct_id: c.client_id,
        client_id: c.client_id,
        card_id: c.card_id,
        ip_address: c.ip_address,
        os: c.os,
        product_type: c.product_type,
        credit_limit: c.credit_limit,
        acquisition_channel: c.acquisition_channel,
        kyc_segment: c.kyc_segment,
        risk_score: c.risk_score,
        funnel_level: "L1",
      },
      timestamp: iso(c.opened_at_ms),
    };
  }
  return out;
}

/**
 * Групує події card_activated по місячному ключу (YYYY-MM).
 * Оскільки всі вони в M0 — усі потраплять в один місяць.
 */
export function groupEventsByMonth(events, months) {
  const index = new Map();
  for (const m of months) index.set(m.key, []);
  for (const e of events) {
    const d = new Date(e.timestamp);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
      2,
      "0"
    )}`;
    const arr = index.get(key);
    if (arr) arr.push(e);
  }
  return index;
}
