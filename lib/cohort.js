/**
 * Генератор M0-когорти: N клієнтів, випущені у заданому місяці.
 * Кожному клієнту призначаються:
 *  - поведінковий архетип (dormant/occasional/habitual/revolver) за цільовою воронкою
 *  - кредитний ліміт, OS, канал, KYC-сегмент, risk_score
 *  - cashback_tier (standard | control_group) згідно з tier_downgrade_holdout
 */

import {
  randInt,
  randFloat,
  randomMsInRange,
  pickWeighted,
  roundMoney,
  padId,
} from "./utils.js";

export const ARCHETYPES = ["dormant", "occasional", "habitual", "revolver"];

/**
 * Дефолтний розподіл архетипів — базовий сценарій п.1.2 документа:
 * 3000 → 1200 (L2) → 300 (L3) → 150 (L4)
 *  - dormant        = 60% (не зробили L2)
 *  - occasional     = 30% (L2 без L3)
 *  - habitual_only  =  5% (L3 без L4)
 *  - revolver       =  5% (L4)
 */
export const DEFAULT_ARCHETYPE_WEIGHTS = {
  dormant: 0.6,
  occasional: 0.3,
  habitual: 0.05,
  revolver: 0.05,
};

const OS_WEIGHTS = [
  { value: "iOS", weight: 55 },
  { value: "Android", weight: 42 },
  { value: "Web", weight: 3 },
];

const ACQUISITION_WEIGHTS = [
  { value: "organic", weight: 30 },
  { value: "paid", weight: 35 },
  { value: "referral", weight: 15 },
  { value: "preapproved", weight: 20 },
];

const KYC_SEGMENTS = [
  { value: "mass", weight: 65 },
  { value: "mass_affluent", weight: 25 },
  { value: "premium", weight: 10 },
];

const PRODUCT_TYPES = [
  { value: "credit_light", weight: 40 },
  { value: "credit_standard", weight: 45 },
  { value: "credit_premium", weight: 15 },
];

const CREDIT_LIMITS_BY_PRODUCT = {
  credit_light: { min: 3000, max: 15000 },
  credit_standard: { min: 10000, max: 50000 },
  credit_premium: { min: 30000, max: 150000 },
};

/**
 * Повертає функцію вибору архетипу згідно з ваговою мапою.
 */
function makeArchetypePicker(weights) {
  const items = ARCHETYPES.map((a) => ({
    value: a,
    weight: Math.max(0, Number(weights[a] ?? 0)),
  }));
  const total = items.reduce((s, it) => s + it.weight, 0);
  if (total <= 0) {
    throw new Error("Сума ваг архетипів має бути > 0");
  }
  return (rng) => pickWeighted(rng, items);
}

function generateIp(rng) {
  return `${randInt(rng, 10, 250)}.${randInt(rng, 0, 255)}.${randInt(
    rng,
    0,
    255
  )}.${randInt(rng, 1, 254)}`;
}

/**
 * Основна функція побудови когорти.
 *
 * @param {object} params
 * @param {number} params.size - кількість карток, що відкриваються у M0
 * @param {{startMs:number,endMs:number}} params.m0 - межі M0 у мс
 * @param {object} [params.archetypeWeights]
 * @param {number} [params.tierDowngradeShare] - частка клієнтів у control_group
 * @param {number} [params.tierDurationMonths] - тривалість перебування у control_group
 * @param {Function} params.rng
 * @returns {{clients: object[]}}
 */
export function buildCohort({
  size,
  m0,
  archetypeWeights = DEFAULT_ARCHETYPE_WEIGHTS,
  tierDowngradeShare = 0.05,
  tierDurationMonths = 12,
  rng,
}) {
  const pickArchetype = makeArchetypePicker(archetypeWeights);
  const clients = new Array(size);

  for (let i = 0; i < size; i++) {
    const clientNumber = i + 1;
    const client_id = padId("client", clientNumber);
    const card_id = padId("card", clientNumber);

    const product_type = pickWeighted(rng, PRODUCT_TYPES);
    const limitCfg = CREDIT_LIMITS_BY_PRODUCT[product_type];
    const credit_limit = roundMoney(
      randInt(rng, Math.round(limitCfg.min / 500), Math.round(limitCfg.max / 500)) *
        500
    );

    const opened_at_ms = randomMsInRange(rng, m0.startMs, m0.endMs);
    const archetype = pickArchetype(rng);

    const cashback_tier = rng() < tierDowngradeShare ? "control_group" : "standard";
    const tier_assigned_at_ms = opened_at_ms;
    const tier_reassignment_after_ms =
      cashback_tier === "control_group"
        ? opened_at_ms + tierDurationMonths * 30 * 86400000
        : null;

    clients[i] = {
      client_id,
      card_id,
      opened_at_ms,
      ip_address: generateIp(rng),
      os: pickWeighted(rng, OS_WEIGHTS),
      product_type,
      credit_limit,
      acquisition_channel: pickWeighted(rng, ACQUISITION_WEIGHTS),
      kyc_segment: pickWeighted(rng, KYC_SEGMENTS),
      risk_score: randInt(rng, 250, 900),
      archetype,
      cashback_tier,
      tier_assigned_at_ms,
      tier_reassignment_after_ms,
    };
  }

  return { clients };
}
