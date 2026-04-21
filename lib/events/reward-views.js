/**
 * Події `reward_section_viewed` (таблиця 6.3) і `reward_type_selected` (таблиця 6.4).
 *
 * Перегляди — довільно у межах місяця.
 * Вибір — зазвичай у перші 1-3 дні місяця, або невдовзі після перегляду.
 */

import {
  iso,
  randInt,
  randFloat,
  pickSubset,
  randomMsInRange,
  uuid,
  padId,
} from "../utils.js";
import { SELECTABLE_REWARD_TYPES } from "./transactions.js";

export function buildRewardViewEvents({
  clients,
  trajectories,
  viewsPerClientMonth,
  months,
  rng,
}) {
  const events = [];
  let counter = 0;
  const clientById = new Map(clients.map((c) => [c.client_id, c]));

  for (let ci = 0; ci < trajectories.length; ci++) {
    const traj = trajectories[ci];
    const client = clientById.get(traj.client_id);
    for (let m = 0; m < months.length; m++) {
      const count = viewsPerClientMonth[ci][m] || 0;
      if (count === 0) continue;
      const windowStart = Math.max(months[m].startMs, client.opened_at_ms);
      const windowEnd = months[m].endMs;
      if (windowEnd <= windowStart) continue;

      for (let k = 0; k < count; k++) {
        counter++;
        const ts = randomMsInRange(rng, windowStart, windowEnd);
        const availableCount = randInt(rng, 3, 6);
        const available = pickSubset(rng, SELECTABLE_REWARD_TYPES, availableCount);
        const clickedCount = Math.min(available.length, randInt(rng, 0, 3));
        const clicked = pickSubset(rng, available, clickedCount);

        events.push({
          event: "reward_section_viewed",
          properties: {
            distinct_id: client.client_id,
            client_id: client.client_id,
            view_id: padId("view", counter, 8),
            session_duration_sec: randInt(rng, 5, 180),
            available_cashback_type_ids: available,
            offers_clicked: clicked,
            app_platform: client.os === "Web" ? "web" : "mobile",
            month_index: m,
          },
          timestamp: iso(ts),
        });
      }
    }
  }

  return events;
}

/**
 * Повертає події вибору + структуру selections для використання генератором tx
 * (щоб нараховувати підвищений кешбек на обрані MCC).
 */
export function buildRewardSelectionEvents({
  clients,
  trajectories,
  selectionsPerClientMonth,
  months,
  rng,
}) {
  const events = [];
  const selections = [];
  let counter = 0;
  const clientById = new Map(clients.map((c) => [c.client_id, c]));

  for (let ci = 0; ci < trajectories.length; ci++) {
    const traj = trajectories[ci];
    const client = clientById.get(traj.client_id);
    for (let m = 0; m < months.length; m++) {
      const count = selectionsPerClientMonth[ci][m] || 0;
      if (count === 0) continue;

      const month = months[m];
      const windowStart = Math.max(month.startMs, client.opened_at_ms);
      const selectionWindowEnd = Math.min(
        month.endMs,
        windowStart + 3 * 86400000
      );
      if (selectionWindowEnd <= windowStart) continue;

      // У cashback_tier='control_group' — вибір не має ефекту (плоский 0.5%),
      // але подія все одно може відбутися (клієнт бачить розділ).
      for (let k = 0; k < count; k++) {
        counter++;
        const ts = randomMsInRange(rng, windowStart, selectionWindowEnd);
        const pickCount = randInt(rng, 1, 3);
        const picked = pickSubset(rng, SELECTABLE_REWARD_TYPES, pickCount);

        const validFromMs = month.startMs;
        const validToMs = month.endMs;
        const rate = client.cashback_tier === "control_group" ? 0.005 : 0.02;

        const config = {
          reward_type_ids: picked,
          rate,
          max_cashback_month_uah: 500,
        };

        events.push({
          event: "reward_type_selected",
          properties: {
            distinct_id: client.client_id,
            client_id: client.client_id,
            selection_id: padId("sel", counter, 8),
            reward_type_ids: picked,
            valid_from: toDate(validFromMs),
            valid_to: toDate(validToMs),
            config,
            cashback_tier: client.cashback_tier,
            month_index: m,
          },
          timestamp: iso(ts),
        });

        selections.push({
          client_id: client.client_id,
          month_index: m,
          reward_type_ids: picked,
          valid_from_ms: validFromMs,
          valid_to_ms: validToMs,
          rate,
        });
      }
    }
  }

  return { events, selections };
}

function toDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
