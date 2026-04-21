/**
 * Подія `transaction_completed` (таблиця 6.2 `transactions` документа).
 *
 * Моделює:
 *   - MCC, мерчанта, суму, інтерчейндж (~1.8% від amount)
 *   - cashback_amount / cashback_credited за ставками:
 *       * welcome-бонус 100 грн (П1.2) — на першу tx ≥200 грн у перші 14 днів
 *       * boost 4% (П2.1) — на другу tx у перші 7 днів після першої
 *       * MCC-кешбек (обраний клієнтом): 2% для standard, 0.5% для control_group (п.4.3)
 *       * milestone +50 грн (П2.3) — на 5-ту tx у місяці
 *   - is_revolver_tx: true для tx, які використовують кредитний ліміт
 *   - is_online, is_recurring
 *
 * Принцип: ми маємо allocateMonthlyCounts → кількість tx на клієнт×місяць.
 * Розгортаємо кожен такий "слот" у подію з таймстампом усередині місяця.
 * Першу tx клієнта ставимо точно на firstTxAtMs; інші рандомно у межах місяця.
 */

import {
  iso,
  randInt,
  randFloat,
  pickWeighted,
  pickOne,
  randomMsInRange,
  roundMoney,
  uuid,
  padId,
} from "../utils.js";

const MCC_CATALOG = [
  { code: 5411, name: "groceries", weight: 22, amountRange: [80, 3200] },
  { code: 5812, name: "restaurants", weight: 14, amountRange: [80, 2500] },
  { code: 5814, name: "fast_food", weight: 10, amountRange: [60, 800] },
  { code: 5541, name: "fuel", weight: 9, amountRange: [200, 2500] },
  { code: 4111, name: "transport", weight: 7, amountRange: [20, 600] },
  { code: 5912, name: "pharmacy", weight: 7, amountRange: [60, 3000] },
  { code: 5399, name: "retail", weight: 6, amountRange: [150, 15000] },
  { code: 5651, name: "clothing", weight: 5, amountRange: [300, 12000] },
  { code: 5732, name: "electronics", weight: 4, amountRange: [500, 45000] },
  { code: 4814, name: "telecom", weight: 4, amountRange: [100, 600] },
  { code: 7832, name: "entertainment", weight: 3, amountRange: [150, 1500] },
  { code: 5942, name: "books", weight: 2, amountRange: [80, 1200] },
  { code: 5921, name: "alcohol", weight: 2, amountRange: [150, 2500] },
  { code: 7011, name: "travel_hotel", weight: 2, amountRange: [800, 25000] },
  { code: 4900, name: "utilities", weight: 3, amountRange: [100, 5000] },
];

const MERCHANT_SAMPLES = {
  groceries: ["ATB", "Silpo", "Novus", "Metro", "FoshQR"],
  restaurants: ["Puzata Hata", "Mafia", "Sushiya", "Il Molino", "Aroma Kava"],
  fast_food: ["McDonald's", "KFC", "Domino's", "Burger King"],
  fuel: ["WOG", "OKKO", "SOCAR", "UPG"],
  transport: ["Bolt", "Uklon", "Uber", "KyivPassTrans"],
  pharmacy: ["Apteka ANC", "Podorozhnyk", "Bazhaem Zdorovya"],
  retail: ["Rozetka", "Eva", "Prostor", "Foxtrot"],
  clothing: ["LC Waikiki", "Sinsay", "H&M", "Answear"],
  electronics: ["Allo", "Comfy", "Foxtrot", "Citrus"],
  telecom: ["Kyivstar", "Vodafone", "Lifecell"],
  entertainment: ["Planeta Kino", "Multiplex", "Spotify"],
  books: ["Ye", "Knyharnia Ye", "Book24"],
  alcohol: ["Vynomania", "WineTime", "Alcomag"],
  travel_hotel: ["Booking", "Hotels24", "Kayak"],
  utilities: ["Naftogaz", "Kyivenergo", "Vodokanal"],
};

const SELECTABLE_REWARD_TYPES = [
  "cat_food",
  "cat_fuel",
  "cat_groceries",
  "cat_pharmacy",
  "cat_coffee",
  "cat_transport",
  "cat_entertainment",
  "cat_clothing",
];

/**
 * Мапа MCC -> селектовані reward types (ті, на які може бути підвищений кешбек).
 */
const MCC_TO_REWARD_TYPE = {
  5411: "cat_groceries",
  5812: "cat_food",
  5814: "cat_food",
  5541: "cat_fuel",
  4111: "cat_transport",
  5912: "cat_pharmacy",
  5651: "cat_clothing",
  7832: "cat_entertainment",
  5942: "cat_entertainment",
};

/**
 * Генерує події транзакцій для когорти.
 *
 * @param {object} params
 * @param {object[]} params.clients
 * @param {object[]} params.trajectories
 * @param {number[][]} params.txPerClientMonth  - [clientIndex][monthIndex] = кількість tx
 * @param {object[]} params.months
 * @param {object[]} params.selectedRewards  - [{client_id, month, reward_type_ids, valid_from_ms, valid_to_ms}]
 * @param {Function} params.rng
 * @returns {object[]} події, групуємо пізніше
 */
export function buildTransactionEvents({
  clients,
  trajectories,
  txPerClientMonth,
  months,
  selectedRewards,
  rng,
}) {
  const events = [];
  const clientById = new Map(clients.map((c) => [c.client_id, c]));
  const rewardsByClientMonth = indexRewards(selectedRewards);

  let txCounter = 0;

  for (let ci = 0; ci < trajectories.length; ci++) {
    const traj = trajectories[ci];
    const client = clientById.get(traj.client_id);
    const openedAt = client.opened_at_ms;

    let clientTotalTxSoFar = 0;
    let firstTxMsActual = null;

    for (let m = 0; m < months.length; m++) {
      const monthTxCount = txPerClientMonth[ci][m] || 0;
      if (monthTxCount === 0) continue;

      const month = months[m];
      const windowStart = Math.max(month.startMs, openedAt);
      const windowEnd = month.endMs;
      if (windowEnd <= windowStart) continue;

      const revolverPlanned = Math.round(
        monthTxCount * (traj.monthlyRevolverShare[m] || 0)
      );

      const rewardSel = rewardsByClientMonth.get(`${traj.client_id}|${m}`) || null;
      const boostedMccForClient = new Set(
        rewardSel ? rewardSel.reward_type_ids : []
      );

      const tsList = [];
      for (let k = 0; k < monthTxCount; k++) {
        let ts;
        if (
          clientTotalTxSoFar === 0 &&
          k === 0 &&
          traj.firstTxAtMs &&
          traj.firstTxAtMs >= windowStart &&
          traj.firstTxAtMs <= windowEnd
        ) {
          ts = traj.firstTxAtMs;
        } else {
          ts = randomMsInRange(rng, windowStart, windowEnd);
        }
        tsList.push(ts);
      }
      tsList.sort((a, b) => a - b);

      for (let k = 0; k < tsList.length; k++) {
        const tx_ts = tsList[k];
        const mcc = pickWeighted(
          rng,
          MCC_CATALOG.map((x) => ({ value: x, weight: x.weight }))
        );
        const merchantName = pickOne(rng, MERCHANT_SAMPLES[mcc.name] || ["Unknown"]);
        const amountUah = roundMoney(
          randFloat(rng, mcc.amountRange[0], mcc.amountRange[1])
        );

        const is_online = rng() < 0.45;
        const is_recurring = rng() < (mcc.code === 4814 || mcc.code === 4900 ? 0.7 : 0.04);

        const is_revolver_tx = revolverPlanned > 0 && k >= tsList.length - revolverPlanned;

        const interchange_amount = roundMoney(amountUah * 0.018);

        const isFirstEverTx = clientTotalTxSoFar === 0;
        const txInMonthIndex = k;

        // Cashback logic
        const { reward_granted, reward_amount, reward_source, reward_type_id } =
          computeReward({
            client,
            amountUah,
            mcc,
            isFirstEverTx,
            openedAt,
            tx_ts,
            boostedMccForClient,
            txInMonthIndex,
            rng,
            prevIsFirstTx: firstTxMsActual,
          });

        if (isFirstEverTx) firstTxMsActual = tx_ts;
        clientTotalTxSoFar++;

        txCounter++;
        events.push({
          event: "transaction_completed",
          properties: {
            distinct_id: client.client_id,
            client_id: client.client_id,
            card_id: client.card_id,
            tx_id: padId("tx", txCounter, 8),
            amount: amountUah,
            amount_uah: amountUah,
            currency: "UAH",
            mcc: mcc.code,
            mcc_name: mcc.name,
            merchant_id: slugifyMerchant(merchantName),
            merchant_name: merchantName,
            is_online,
            is_recurring,
            is_revolver_tx,
            interchange_amount,
            reward_granted,
            reward_amount,
            reward_source,
            reward_type_id,
            cashback_tier: client.cashback_tier,
            funnel_level: is_revolver_tx ? "L4" : null,
            month_index: m,
            first_tx_for_client: isFirstEverTx,
          },
          timestamp: iso(tx_ts),
        });
      }
    }
  }

  return events;
}

function slugifyMerchant(name) {
  return (
    "merch_" +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  );
}

function indexRewards(selectedRewards) {
  const idx = new Map();
  for (const r of selectedRewards) {
    idx.set(`${r.client_id}|${r.month_index}`, r);
  }
  return idx;
}

function computeReward({
  client,
  amountUah,
  mcc,
  isFirstEverTx,
  openedAt,
  tx_ts,
  boostedMccForClient,
  txInMonthIndex,
  rng,
  prevIsFirstTx,
}) {
  const mccRewardType = MCC_TO_REWARD_TYPE[mcc.code] || null;
  const isBoostedByClient =
    mccRewardType && boostedMccForClient.has(mccRewardType);

  const daysSinceOpen = (tx_ts - openedAt) / 86400000;
  const daysSinceFirst = prevIsFirstTx ? (tx_ts - prevIsFirstTx) / 86400000 : null;

  // П1.2: welcome-бонус 100 грн на першу tx ≥200 грн у перші 14 днів
  if (isFirstEverTx && amountUah >= 200 && daysSinceOpen <= 14) {
    return {
      reward_granted: true,
      reward_amount: 100,
      reward_source: "bank",
      reward_type_id: "welcome_bonus",
    };
  }

  // П2.1: boost 4% на другу tx у перші 7 днів після першої
  if (
    prevIsFirstTx &&
    daysSinceFirst !== null &&
    daysSinceFirst <= 7 &&
    txInMonthIndex <= 1 &&
    amountUah >= 100
  ) {
    const rate = 0.04;
    const amt = roundMoney(amountUah * rate);
    if (amt >= 0.01) {
      return {
        reward_granted: true,
        reward_amount: amt,
        reward_source: "bank",
        reward_type_id: "boost_second_tx",
      };
    }
  }

  // П2.3: milestone +50 грн на 5-ту tx у місяці
  if (txInMonthIndex === 4) {
    return {
      reward_granted: true,
      reward_amount: 50,
      reward_source: "bank",
      reward_type_id: "milestone_5_tx",
    };
  }

  // MCC-кешбек (обраний клієнтом): 2% standard або 0.5% control_group (п.4.3)
  if (isBoostedByClient) {
    const rate = client.cashback_tier === "control_group" ? 0.005 : 0.02;
    const amt = roundMoney(amountUah * rate);
    if (amt >= 0.01) {
      return {
        reward_granted: true,
        reward_amount: amt,
        reward_source: "bank",
        reward_type_id: mccRewardType,
      };
    }
  }

  // Partner-кешбек (рідко, імітація DeepLoyalty — п.4.2 Категорія A)
  if (rng() < 0.03) {
    const rate = randFloat(rng, 0.01, 0.05);
    const amt = roundMoney(amountUah * rate);
    if (amt >= 0.01) {
      return {
        reward_granted: true,
        reward_amount: amt,
        reward_source: "partner",
        reward_type_id: `partner_${mcc.name}`,
      };
    }
  }

  // Базовий 0.5% як fallback для control_group, 0 для standard без selection
  if (client.cashback_tier === "control_group") {
    const amt = roundMoney(amountUah * 0.005);
    if (amt >= 0.01) {
      return {
        reward_granted: true,
        reward_amount: amt,
        reward_source: "bank",
        reward_type_id: "base_flat",
      };
    }
  }

  return {
    reward_granted: false,
    reward_amount: 0,
    reward_source: null,
    reward_type_id: null,
  };
}

export { MCC_CATALOG, SELECTABLE_REWARD_TYPES, MCC_TO_REWARD_TYPE };
