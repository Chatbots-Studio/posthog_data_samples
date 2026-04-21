/**
 * Оркестратор генерації подій активації.
 *
 * Вхід: M0-місяць + діапазон карток + пресет сценарію.
 * Місячні обсяги всіх подій (транзакцій, переглядів, виборів, комунікацій,
 * снепшотів, експериментів) обчислюються автоматично:
 *     target = cohort_size × perClientPerMonth × monthActivityFactor × (1 ± jitter)
 *
 * Сценарій повністю визначає архетипи, інтенсивність і параметри експериментів.
 *
 * 10 типів подій (7 таблиць документа):
 *   card_activated, transaction_completed,
 *   reward_section_viewed, reward_type_selected,
 *   communication_sent/delivered/opened/clicked,
 *   credit_profile_snapshot, experiment_assigned
 */

import {
  createRng,
  randInt,
  randFloat,
  monthsSequence,
  parseYearMonth,
} from "./utils.js";
import { buildCohort } from "./cohort.js";
import { buildTrajectories, allocateMonthlyCounts } from "./funnel.js";
import { buildCardActivatedEvents } from "./events/card-openings.js";
import { buildTransactionEvents } from "./events/transactions.js";
import {
  buildRewardViewEvents,
  buildRewardSelectionEvents,
} from "./events/reward-views.js";
import { buildCommunicationEvents } from "./events/communications.js";
import { buildCreditProfileSnapshots } from "./events/credit-profiles.js";
import { buildExperimentAssignments } from "./events/experiments.js";
import { getScenario, DEFAULT_SCENARIO } from "./scenarios.js";

export const EVENT_FILES = {
  card_activated: "card_activated.json",
  transaction_completed: "transaction_completed.json",
  reward_section_viewed: "reward_section_viewed.json",
  reward_type_selected: "reward_type_selected.json",
  communication_sent: "communication_sent.json",
  communication_delivered: "communication_delivered.json",
  communication_opened: "communication_opened.json",
  communication_clicked: "communication_clicked.json",
  credit_profile_snapshot: "credit_profile_snapshot.json",
  experiment_assigned: "experiment_assigned.json",
};

export const EVENT_GROUPS = {
  cards: ["card_activated"],
  transactions: ["transaction_completed"],
  views: ["reward_section_viewed"],
  selections: ["reward_type_selected"],
  communications: [
    "communication_sent",
    "communication_delivered",
    "communication_opened",
    "communication_clicked",
  ],
  snapshots: ["credit_profile_snapshot"],
  experiments: ["experiment_assigned"],
};

export const DEFAULT_OPTS = {
  cardsMin: 2500,
  cardsMax: 3500,
  scenario: DEFAULT_SCENARIO,
  cohortMonths: 4,
  seed: null,
};

/**
 * Фактор активності по місяцях M0..M3.
 *   M0: клієнти тільки активуються, активність низька (10-20% від steady-state)
 *   M1: перша активність, welcome-кампанії — 80%
 *   M2: habitual — 100%
 *   M3: пік, револьверна фаза — 105%
 */
const MONTH_ACTIVITY_FACTORS = {
  tx: [0.18, 0.85, 1.1, 1.15],
  views: [0.55, 1.05, 1.0, 0.95],
  selections: [0.7, 1.2, 1.0, 0.9],
  comms: [1.4, 1.2, 0.9, 1.0],
};

function randomTarget(rng, baseValue, jitter) {
  const lo = baseValue * (1 - jitter);
  const hi = baseValue * (1 + jitter);
  return Math.max(0, Math.round(randFloat(rng, lo, hi)));
}

/**
 * @param {string} startMonthYm - YYYY-MM, задає M0
 * @param {Partial<typeof DEFAULT_OPTS>} overrides
 */
export function buildEvents(startMonthYm, overrides = {}) {
  const opts = { ...DEFAULT_OPTS, ...overrides };
  const rng = createRng(opts.seed);
  const scenario = getScenario(opts.scenario);

  const months = monthsSequence(startMonthYm, opts.cohortMonths);
  const m0 = months[0];

  const cohortSize = randInt(rng, opts.cardsMin, opts.cardsMax);

  const { clients } = buildCohort({
    size: cohortSize,
    m0,
    archetypeWeights: scenario.archetypeWeights,
    tierDowngradeShare: scenario.experiments.tierDowngradeShare,
    tierDurationMonths: scenario.experiments.tierDurationMonths,
    rng,
  });

  const trajectories = buildTrajectories(clients, months, rng);

  // Обчислюємо цільові обсяги на кожен місяць з інтенсивності сценарію
  const perClient = scenario.perClientPerMonth;
  const jitter = scenario.jitter;

  const txTargets = months.map((_, m) =>
    randomTarget(rng, cohortSize * perClient.tx * MONTH_ACTIVITY_FACTORS.tx[m], jitter)
  );
  const viewsTargets = months.map((_, m) =>
    randomTarget(
      rng,
      cohortSize * perClient.views * MONTH_ACTIVITY_FACTORS.views[m],
      jitter
    )
  );
  const selectionsTargets = months.map((_, m) =>
    randomTarget(
      rng,
      cohortSize * perClient.selections * MONTH_ACTIVITY_FACTORS.selections[m],
      jitter
    )
  );
  const commsTargets = months.map((_, m) =>
    randomTarget(
      rng,
      cohortSize * perClient.comms * MONTH_ACTIVITY_FACTORS.comms[m],
      jitter
    )
  );

  const txPerClientMonth = allocateMonthlyCounts(
    trajectories,
    "monthlyTxBaseline",
    txTargets,
    rng
  );
  const viewsPerClientMonth = allocateMonthlyCounts(
    trajectories,
    "viewsAffinity",
    viewsTargets,
    rng
  );
  const selectionsPerClientMonth = allocateMonthlyCounts(
    trajectories,
    "selectionAffinity",
    selectionsTargets,
    rng
  );

  const { events: selectionEvents, selections } = buildRewardSelectionEvents({
    clients,
    trajectories,
    selectionsPerClientMonth,
    months,
    rng,
  });

  const transactionEvents = buildTransactionEvents({
    clients,
    trajectories,
    txPerClientMonth,
    months,
    selectedRewards: selections,
    rng,
  });

  const txByClientMonth = indexTransactions(transactionEvents, months);

  const cardEvents = buildCardActivatedEvents(clients);

  const viewEvents = buildRewardViewEvents({
    clients,
    trajectories,
    viewsPerClientMonth,
    months,
    rng,
  });

  const [expCampaignsMin, expCampaignsMax] =
    scenario.experiments.exclusionCampaignsPerMonth;

  const { events: experimentEvents, campaignControlByMonth } =
    buildExperimentAssignments({
      clients,
      trajectories,
      months,
      exclusionCampaignsPerMonthMin: expCampaignsMin,
      exclusionCampaignsPerMonthMax: expCampaignsMax,
      exclusionHoldoutShare: scenario.experiments.exclusionHoldoutShare,
      tierDowngradeShare: scenario.experiments.tierDowngradeShare,
      tierDurationMonths: scenario.experiments.tierDurationMonths,
      rng,
    });

  const commEvents = [];
  for (let m = 0; m < months.length; m++) {
    const { events: monthComms } = buildCommunicationEvents({
      clients,
      trajectories,
      months,
      monthIndex: m,
      targetSent: commsTargets[m],
      campaignControl: campaignControlByMonth[m],
      transactionsByClientMonth: txByClientMonth,
      rng,
    });
    commEvents.push(...monthComms);
  }

  const creditEvents = buildCreditProfileSnapshots({
    clients,
    trajectories,
    months,
    transactionsByClientMonth: txByClientMonth,
    snapshotsPerClientMin: scenario.snapshots.perClientMin,
    snapshotsPerClientMax: scenario.snapshots.perClientMax,
    rng,
  });

  const allEvents = {
    card_activated: cardEvents,
    transaction_completed: transactionEvents,
    reward_section_viewed: viewEvents,
    reward_type_selected: selectionEvents,
    credit_profile_snapshot: creditEvents,
    experiment_assigned: experimentEvents,
    communication_sent: commEvents.filter((e) => e.event === "communication_sent"),
    communication_delivered: commEvents.filter(
      (e) => e.event === "communication_delivered"
    ),
    communication_opened: commEvents.filter(
      (e) => e.event === "communication_opened"
    ),
    communication_clicked: commEvents.filter(
      (e) => e.event === "communication_clicked"
    ),
  };

  const byMonth = months.map((month) => ({
    key: month.key,
    period_start: month.periodStart,
    period_end: month.periodEnd,
    events: Object.fromEntries(
      Object.keys(allEvents).map((k) => [k, []])
    ),
  }));

  for (const [type, arr] of Object.entries(allEvents)) {
    for (const e of arr) {
      const key = e.timestamp.slice(0, 7);
      const bucket = byMonth.find((b) => b.key === key);
      if (bucket) bucket.events[type].push(e);
    }
  }

  const meta = {
    m0_month: m0.key,
    months: months.map((m) => m.key),
    cohort_size: cohortSize,
    cards_range: [opts.cardsMin, opts.cardsMax],
    scenario: {
      name: scenario.label,
      description: scenario.description,
      archetype_weights: scenario.archetypeWeights,
      per_client_per_month: scenario.perClientPerMonth,
      snapshots: scenario.snapshots,
      experiments: scenario.experiments,
      jitter: scenario.jitter,
    },
    archetype_distribution: summarizeArchetypes(clients),
    monthly_targets: {
      tx: txTargets,
      views: viewsTargets,
      selections: selectionsTargets,
      comms: commsTargets,
    },
    seed: opts.seed,
  };

  return { meta, months: byMonth };
}

function summarizeArchetypes(clients) {
  const counts = { dormant: 0, occasional: 0, habitual: 0, revolver: 0 };
  for (const c of clients) counts[c.archetype] = (counts[c.archetype] || 0) + 1;
  return counts;
}

function indexTransactions(transactionEvents, months) {
  const idx = new Map();
  for (const e of transactionEvents) {
    const d = new Date(e.timestamp);
    const ts = d.getTime();
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
      2,
      "0"
    )}`;
    const monthIdx = months.findIndex((m) => m.key === key);
    if (monthIdx < 0) continue;
    const mapKey = `${e.properties.client_id}|${monthIdx}`;
    const list = idx.get(mapKey) || [];
    list.push({
      ts,
      amount: e.properties.amount_uah,
      is_revolver_tx: e.properties.is_revolver_tx,
    });
    idx.set(mapKey, list);
  }
  for (const v of idx.values()) v.sort((a, b) => a.ts - b.ts);
  return idx;
}

export function filterEvents(eventsByType, only) {
  if (only === "all") {
    return Object.values(eventsByType).flat();
  }
  if (EVENT_GROUPS[only]) {
    return EVENT_GROUPS[only].flatMap((t) => eventsByType[t] || []);
  }
  if (eventsByType[only]) {
    return eventsByType[only];
  }
  throw new Error(
    `--only має бути: all | ${Object.keys(EVENT_GROUPS).join(" | ")} | <event_name>`
  );
}

export { parseYearMonth };
