/**
 * Пресети сценаріїв для генерації подій активації.
 *
 * Кожен сценарій повністю визначає поведінку когорти:
 *   - розподіл архетипів (впливає на воронку L1→L4)
 *   - per-client інтенсивність кожного типу подій на місяць
 *   - розміри контрольних груп і кампаній
 *
 * Дефолтні числа взято з `activation_research.md`:
 *   - п.1.2: базовий (3000→1200→300→150) vs цільовий (3000→1800→720→504)
 *   - п.4.2: 10% exclusion_holdout
 *   - п.4.3: 5% tier_downgrade control_group, 12 міс
 */

export const SCENARIOS = {
  /**
   * Базовий сценарій п.1.2: «як є» без модуля винагород.
   *   L1→L2 40%, L2→L3 25%, L3→L4 50% (сумарно L1→L4 = 5%)
   */
  baseline: {
    label: "baseline",
    description:
      "Базовий сценарій (п.1.2): банк без модуля винагород — 3000→1200→300→150",
    archetypeWeights: {
      dormant: 0.6,
      occasional: 0.3,
      habitual: 0.05,
      revolver: 0.05,
    },
    perClientPerMonth: {
      tx: 5,
      views: 1.5,
      selections: 0.35,
      comms: 3,
    },
    snapshots: { perClientMin: 26, perClientMax: 31 },
    experiments: {
      exclusionCampaignsPerMonth: [3, 6],
      exclusionHoldoutShare: 0.1,
      tierDowngradeShare: 0.05,
      tierDurationMonths: 12,
    },
    jitter: 0.2,
  },

  /**
   * Цільовий сценарій п.1.2: з модулем винагород після 3-6 міс впровадження.
   *   L1→L2 60%, L2→L3 40%, L3→L4 70% (сумарно L1→L4 = 17%)
   */
  target: {
    label: "target",
    description:
      "Цільовий сценарій (п.1.2): з модулем винагород — 3000→1800→720→504",
    archetypeWeights: {
      dormant: 0.4,
      occasional: 0.392,
      habitual: 0.048,
      revolver: 0.168,
    },
    perClientPerMonth: {
      tx: 8,
      views: 2.5,
      selections: 0.6,
      comms: 4.5,
    },
    snapshots: { perClientMin: 28, perClientMax: 31 },
    experiments: {
      exclusionCampaignsPerMonth: [5, 10],
      exclusionHoldoutShare: 0.1,
      tierDowngradeShare: 0.05,
      tierDurationMonths: 12,
    },
    jitter: 0.2,
  },

  /**
   * Консервативний: невеликий регіональний цифровий банк,
   * нижча активність клієнтів і менше кампаній.
   *   L1→L2 30%, L2→L3 20%, L3→L4 40%
   */
  conservative: {
    label: "conservative",
    description:
      "Консервативний: невеликий регіональний банк, нижча активність",
    archetypeWeights: {
      dormant: 0.7,
      occasional: 0.24,
      habitual: 0.03,
      revolver: 0.03,
    },
    perClientPerMonth: {
      tx: 3.5,
      views: 0.9,
      selections: 0.2,
      comms: 2,
    },
    snapshots: { perClientMin: 20, perClientMax: 31 },
    experiments: {
      exclusionCampaignsPerMonth: [2, 4],
      exclusionHoldoutShare: 0.1,
      tierDowngradeShare: 0.05,
      tierDurationMonths: 12,
    },
    jitter: 0.25,
  },

  /**
   * Агресивний: банк з інтенсивним маркетингом і множиною тестів.
   *   L1→L2 70%, L2→L3 50%, L3→L4 80%
   */
  aggressive: {
    label: "aggressive",
    description:
      "Агресивний: інтенсивний маркетинг, багато кампаній і контрольних груп",
    archetypeWeights: {
      dormant: 0.3,
      occasional: 0.35,
      habitual: 0.15,
      revolver: 0.2,
    },
    perClientPerMonth: {
      tx: 11,
      views: 3.5,
      selections: 0.8,
      comms: 6,
    },
    snapshots: { perClientMin: 29, perClientMax: 31 },
    experiments: {
      exclusionCampaignsPerMonth: [8, 14],
      exclusionHoldoutShare: 0.12,
      tierDowngradeShare: 0.07,
      tierDurationMonths: 9,
    },
    jitter: 0.15,
  },
};

export const DEFAULT_SCENARIO = "baseline";

export function getScenario(name) {
  const key = (name || DEFAULT_SCENARIO).trim();
  const s = SCENARIOS[key];
  if (!s) {
    throw new Error(
      `Невідомий сценарій "${key}". Доступні: ${Object.keys(SCENARIOS).join(", ")}`
    );
  }
  return s;
}

export function listScenarios() {
  return Object.values(SCENARIOS).map((s) => ({
    name: s.label,
    description: s.description,
  }));
}
