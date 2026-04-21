/**
 * Призначення експериментів (таблиця 6.7 `experiment_assignments`).
 *
 * 3 типи згідно з частиною 4 документа:
 *   A) exclusion_holdout   — 10% ЦА на кожну кампанію не отримує sent (п.4.2)
 *   B) tier_downgrade_holdout — ~5% клієнтів у control_group (плоский 0.5% замість 2%) (п.4.3)
 *   C) staggered_rollout   — 33/33/34 хвилі на нову MCC-конфігурацію на місяць (п.4.4)
 *
 * Подія: `experiment_assigned` з полями
 *   assignment_id, experiment_type, experiment_id, variant, assigned_at,
 *   reassignment_allowed_after, metadata
 */

import { iso, randInt, pickSubset, padId } from "../utils.js";
import { getCommunicationTemplates } from "./communications.js";

/**
 * Повертає події + структуру для використання у комунікаційному генераторі:
 *   campaignControlByMonth[monthIndex] = Map<campaign_id, Set<client_id>>
 */
export function buildExperimentAssignments({
  clients,
  trajectories,
  months,
  exclusionCampaignsPerMonthMin,
  exclusionCampaignsPerMonthMax,
  exclusionHoldoutShare,
  tierDowngradeShare,
  tierDurationMonths,
  rng,
}) {
  const events = [];
  const campaignControlByMonth = months.map(() => new Map());
  let counter = 0;

  const templates = getCommunicationTemplates();

  // B) tier_downgrade_holdout: один запис на клієнта в M0 для тих, хто у control_group
  for (const c of clients) {
    counter++;
    const tsMs = c.tier_assigned_at_ms;
    const expiresMs = c.tier_reassignment_after_ms;
    events.push({
      event: "experiment_assigned",
      properties: {
        distinct_id: c.client_id,
        client_id: c.client_id,
        assignment_id: padId("asg", counter, 9),
        experiment_type: "tier_downgrade_holdout",
        experiment_id: "exp_mcc_cashback_tier",
        variant: c.cashback_tier === "control_group" ? "control" : "treatment",
        reassignment_allowed_after: expiresMs
          ? new Date(expiresMs).toISOString().slice(0, 10)
          : null,
        metadata: {
          baseline_rate: 0.005,
          standard_rate: 0.02,
          holdout_share: tierDowngradeShare,
          duration_months: tierDurationMonths,
        },
      },
      timestamp: iso(tsMs),
    });
  }

  // A) exclusion_holdout: для кожної активної кампанії у місяці — 10% control
  for (let m = 0; m < months.length; m++) {
    const month = months[m];
    const campaignsThisMonth = pickSubset(
      rng,
      templates,
      randInt(rng, exclusionCampaignsPerMonthMin, exclusionCampaignsPerMonthMax)
    );

    for (const tpl of campaignsThisMonth) {
      // ЦА = усі клієнти, активні до цього місяця
      const audience = clients.filter((c) => c.opened_at_ms <= month.endMs);
      const controlSize = Math.max(
        5,
        Math.round(audience.length * exclusionHoldoutShare)
      );
      const control = pickSubset(rng, audience, controlSize);
      const controlSet = new Set(control.map((c) => c.client_id));
      campaignControlByMonth[m].set(tpl.campaign_id, controlSet);

      // Записи для всієї ЦА (control+treatment) — так простіше будувати lift
      const assignTsMs = month.startMs + randInt(rng, 0, 3 * 86400000);
      for (const cl of audience) {
        counter++;
        const variant = controlSet.has(cl.client_id) ? "control" : "treatment";
        events.push({
          event: "experiment_assigned",
          properties: {
            distinct_id: cl.client_id,
            client_id: cl.client_id,
            assignment_id: padId("asg", counter, 9),
            experiment_type: "exclusion_holdout",
            experiment_id: `${tpl.campaign_id}__${month.key}`,
            campaign_id: tpl.campaign_id,
            template_id: tpl.template_id,
            variant,
            metadata: {
              practice: tpl.practice,
              channel: tpl.channel,
              holdout_share: exclusionHoldoutShare,
              audience_size: audience.length,
              control_size: controlSet.size,
              month_key: month.key,
            },
          },
          timestamp: iso(assignTsMs),
        });
      }
    }
  }

  // C) staggered_rollout: 3 хвилі на нову MCC-конфігурацію в кожному місяці
  for (let m = 0; m < months.length; m++) {
    const month = months[m];
    const activeClients = clients.filter((c) => c.opened_at_ms <= month.endMs);
    if (activeClients.length === 0) continue;

    const shuffled = pickSubset(rng, activeClients, activeClients.length);
    const w1end = Math.floor(shuffled.length * 0.33);
    const w2end = Math.floor(shuffled.length * 0.66);
    const waves = [
      { name: "wave_1", start: 0, end: w1end, dayOffset: 0 },
      { name: "wave_2", start: w1end, end: w2end, dayOffset: 2 },
      { name: "wave_3", start: w2end, end: shuffled.length, dayOffset: 4 },
    ];

    for (const wave of waves) {
      const assignTsMs = month.startMs + wave.dayOffset * 86400000;
      for (let i = wave.start; i < wave.end; i++) {
        const cl = shuffled[i];
        counter++;
        events.push({
          event: "experiment_assigned",
          properties: {
            distinct_id: cl.client_id,
            client_id: cl.client_id,
            assignment_id: padId("asg", counter, 9),
            experiment_type: "staggered_rollout",
            experiment_id: `exp_mcc_config__${month.key}`,
            variant: wave.name,
            metadata: {
              month_key: month.key,
              rollout_day_offset: wave.dayOffset,
              wave_size: wave.end - wave.start,
            },
          },
          timestamp: iso(assignTsMs),
        });
      }
    }
  }

  return { events, campaignControlByMonth };
}
