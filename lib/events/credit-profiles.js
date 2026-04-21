/**
 * Денні снепшоти кредитного профілю (таблиця 6.6 `credit_profiles`).
 * Один снепшот на клієнта на добу після активації картки.
 *
 * Поля: current_balance, revolver_flag, minimum_payment_due, payment_due_date,
 * overdue_days, interest_accrued_mtd.
 *
 * Модель балансу:
 *   - Акумулюємо транзакції клієнта за місяць.
 *   - На day_of_cycle=25 нараховується grace-платіж.
 *   - Якщо клієнт revolver-архетипу — у M2/M3 залишається залишок ≥ X%.
 */

import { iso, randInt, randFloat, roundMoney, padId } from "../utils.js";

/**
 * @param {object} params
 * @param {object[]} params.clients
 * @param {object[]} params.trajectories
 * @param {object[]} params.months  - 4 місяці M0..M3
 * @param {Map<string, object[]>} params.transactionsByClientMonth  // key = client|month => [{amount, ts, is_revolver_tx}]
 * @param {number} params.snapshotsPerClientMin
 * @param {number} params.snapshotsPerClientMax
 * @param {Function} params.rng
 * @returns {object[]} події
 */
export function buildCreditProfileSnapshots({
  clients,
  trajectories,
  months,
  transactionsByClientMonth,
  snapshotsPerClientMin,
  snapshotsPerClientMax,
  rng,
}) {
  const events = [];
  let counter = 0;

  const clientById = new Map(clients.map((c) => [c.client_id, c]));

  for (const traj of trajectories) {
    const client = clientById.get(traj.client_id);
    // Агрегація балансу по днях
    const balanceByDay = computeDailyBalance(
      client,
      traj,
      months,
      transactionsByClientMonth
    );

    for (let m = 0; m < months.length; m++) {
      const month = months[m];
      const daysInMonth =
        Math.round((month.endMs - month.startMs) / 86400000) + 1;

      // Кількість снепшотів на цей місяць — у діапазоні
      const target = Math.min(
        daysInMonth,
        Math.max(
          0,
          randInt(rng, snapshotsPerClientMin, snapshotsPerClientMax)
        )
      );

      // Якщо картка не активна на початок місяця — зменшуємо
      const activeFromDayInMonth =
        m === 0
          ? Math.floor((client.opened_at_ms - month.startMs) / 86400000)
          : 0;
      const availableDays = Math.max(0, daysInMonth - activeFromDayInMonth);
      const snapshotCount = Math.min(target, availableDays);
      if (snapshotCount === 0) continue;

      for (let d = 0; d < snapshotCount; d++) {
        counter++;
        const dayOffset = activeFromDayInMonth + d;
        const tsMs = month.startMs + dayOffset * 86400000 + 4 * 3600_000;
        const dayKey = dateKey(tsMs);
        const balance = balanceByDay.get(dayKey) || 0;
        const revolver_flag = balance > 0 && isPostGrace(client, tsMs);
        const minimum_payment_due = revolver_flag
          ? roundMoney(Math.max(50, balance * 0.05))
          : null;
        const overdue_days = revolver_flag && rng() < 0.07 ? randInt(rng, 1, 30) : 0;
        const interest_accrued_mtd = revolver_flag
          ? roundMoney(balance * 0.035 * ((dayOffset % 30) + 1) / 30)
          : 0;

        events.push({
          event: "credit_profile_snapshot",
          properties: {
            distinct_id: client.client_id,
            client_id: client.client_id,
            card_id: client.card_id,
            snapshot_id: padId("snap", counter, 9),
            snapshot_date: dayKey,
            credit_limit: client.credit_limit,
            current_balance: roundMoney(balance),
            revolver_flag,
            minimum_payment_due,
            payment_due_date: computePaymentDueDate(tsMs),
            overdue_days,
            interest_accrued_mtd,
            cashback_tier: client.cashback_tier,
            month_index: m,
          },
          timestamp: iso(tsMs),
        });
      }
    }
  }

  return events;
}

function dateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function isPostGrace(client, tsMs) {
  // Груба модель: грейс-період 55 днів з моменту першої транзакції у місяці;
  // для спрощення вважаємо, що після 25-го числа борг або погашений, або стає револьверним.
  const d = new Date(tsMs);
  return d.getUTCDate() >= 20;
}

function computePaymentDueDate(tsMs) {
  const d = new Date(tsMs);
  const nextMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 10)
  );
  return nextMonth.toISOString().slice(0, 10);
}

function computeDailyBalance(client, traj, months, transactionsByClientMonth) {
  // Сумуємо транзакції по днях; для не-револьверного архетипу наприкінці
  // місяця баланс обнуляється (погашено у grace), для револьверного —
  // залишається 30-70% на наступний місяць.
  const result = new Map();

  const isRevolver = traj.archetype === "revolver";

  for (let m = 0; m < months.length; m++) {
    const key = `${client.client_id}|${m}`;
    const txs = transactionsByClientMonth.get(key) || [];
    const month = months[m];

    // Накопичуємо впродовж місяця
    let mtdBalance = 0;
    // Якщо револьвер — переносимо 30-70% попереднього місяця
    if (isRevolver && m > 0) {
      const prevEnd = dateKey(months[m - 1].endMs);
      const prev = result.get(prevEnd) || 0;
      mtdBalance = prev * 0.5;
    }

    // День за днем
    const daysInMonth =
      Math.round((month.endMs - month.startMs) / 86400000) + 1;
    let txIdx = 0;
    for (let d = 0; d < daysInMonth; d++) {
      const dayMs = month.startMs + d * 86400000;
      const dayEnd = dayMs + 86400000 - 1;
      while (txIdx < txs.length && txs[txIdx].ts <= dayEnd) {
        mtdBalance += txs[txIdx].amount;
        txIdx++;
      }
      result.set(dateKey(dayMs), mtdBalance);
    }

    // Наприкінці місяця (після grace) погашаємо
    if (!isRevolver) {
      // Обнуляємо стан у наступному місяці (через початковий reset)
    }
  }

  return result;
}
