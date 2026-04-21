/**
 * Комунікації (таблиця 6.5): 4 події на життєвий цикл
 *   - communication_sent
 *   - communication_delivered
 *   - communication_opened
 *   - communication_clicked
 *
 * Шаблони кампаній з документа (частина 3):
 *   - П1.1 activation_push (push, trigger: card_activated)
 *   - П1.2 welcome_cashback (push/sms, trigger: card_activated)
 *   - П1.3 lapse_day7 (push, trigger: no_tx_day_7)
 *   - П2.1 boost_second_tx (push, trigger: first_tx)
 *   - П2.3 milestone_5_tx (push/in_app, trigger: monthly)
 *   - П3.1 installment_big_tx (push, trigger: tx_over_3000)
 *   - П3.3 grace_period_comm (push, trigger: tx_over_3000)
 *   - partner_offer (email, trigger: monthly, partner)
 *
 * Категорія A (п.4.2): для кожної кампанії 10% ЦА у control — їм sent НЕ надсилається.
 * Їх assignments генеруються у lib/events/experiments.js і використовуються тут.
 *
 * Обмеження частоти (П5.1): не більше 2 push/тиждень у перші 30 днів,
 * не більше 1 push/день у будь-який період.
 */

import {
  iso,
  randInt,
  randFloat,
  pickWeighted,
  pickOne,
  randomMsInRange,
  uuid,
  padId,
} from "../utils.js";

const TEMPLATES = [
  {
    template_id: "tpl_activation_push",
    campaign_id: "cmp_p1_1_activation_push",
    practice: "P1.1",
    channel: "push",
    trigger_type: "card_activated",
    delay_minutes: [5, 30],
  },
  {
    template_id: "tpl_welcome_cashback",
    campaign_id: "cmp_p1_2_welcome_cashback",
    practice: "P1.2",
    channel: "push",
    trigger_type: "card_activated",
    delay_minutes: [60 * 24, 60 * 24 * 3],
  },
  {
    template_id: "tpl_lapse_day7",
    campaign_id: "cmp_p1_3_lapse_day7",
    practice: "P1.3",
    channel: "push",
    trigger_type: "no_tx_day_7",
    delay_minutes: null,
    onlyArchetypes: null,
  },
  {
    template_id: "tpl_boost_second_tx",
    campaign_id: "cmp_p2_1_boost_second_tx",
    practice: "P2.1",
    channel: "push",
    trigger_type: "first_tx",
    delay_minutes: [30, 60 * 24],
  },
  {
    template_id: "tpl_milestone_5_tx",
    campaign_id: "cmp_p2_3_milestone_5_tx",
    practice: "P2.3",
    channel: "in_app",
    trigger_type: "monthly_digest",
    delay_minutes: null,
  },
  {
    template_id: "tpl_installment_big_tx",
    campaign_id: "cmp_p3_1_installment_big_tx",
    practice: "P3.1",
    channel: "push",
    trigger_type: "tx_over_3000",
    delay_minutes: [1, 30],
  },
  {
    template_id: "tpl_grace_period",
    campaign_id: "cmp_p3_3_grace_period",
    practice: "P3.3",
    channel: "push",
    trigger_type: "tx_over_3000",
    delay_minutes: [5, 60],
  },
  {
    template_id: "tpl_partner_offer_email",
    campaign_id: "cmp_partner_monthly_offer",
    practice: "partner",
    channel: "email",
    trigger_type: "monthly_digest",
    delay_minutes: null,
  },
  {
    template_id: "tpl_partner_offer_sms",
    campaign_id: "cmp_partner_flash_sms",
    practice: "partner",
    channel: "sms",
    trigger_type: "monthly_digest",
    delay_minutes: null,
  },
];

export function getCommunicationTemplates() {
  return TEMPLATES;
}

/**
 * Генерує події комунікацій у межах одного місяця до цільової кількості `targetSent`.
 *
 * Стратегія:
 *   1) Визначаємо список "тригерів": деякі прив'язані до подій клієнта
 *      (card_activated у M0, first_tx, tx_over_3000), інші — monthly_digest.
 *   2) Кампанії Категорії A мають control-призначення (campaignControl): 
 *      клієнти у control не отримують sent.
 *   3) Шукаємо комбінацію (client, template, ts), яка проходить частотні правила (П5.1).
 *   4) Генеруємо sent/delivered/opened/clicked з типовими конверсіями.
 *
 * @param {object} params
 * @param {object[]} params.clients
 * @param {object[]} params.trajectories
 * @param {object[]} params.months
 * @param {number} params.monthIndex
 * @param {number} params.targetSent
 * @param {Map<string, Set<string>>} params.campaignControl - campaign_id -> Set(client_id) у control
 * @param {object[]} params.transactionsByClientMonth - Map<client|month, sorted tx[]>
 * @param {Function} params.rng
 * @returns {{events: object[]}}
 */
export function buildCommunicationEvents({
  clients,
  trajectories,
  months,
  monthIndex,
  targetSent,
  campaignControl,
  transactionsByClientMonth,
  rng,
}) {
  if (targetSent <= 0) return { events: [] };

  const events = [];
  const month = months[monthIndex];
  const windowStart = month.startMs;
  const windowEnd = month.endMs;

  const clientById = new Map(clients.map((c) => [c.client_id, c]));
  const trajectoryById = new Map(trajectories.map((t) => [t.client_id, t]));

  // Частотні лічильники: client_id -> sorted array of push ms
  const pushLog = new Map();

  const maxAttempts = targetSent * 8;
  let produced = 0;
  let counter = 0;
  let attempts = 0;

  while (produced < targetSent && attempts < maxAttempts) {
    attempts++;

    const tpl = pickWeightedTemplate(rng);
    const client = clients[Math.floor(rng() * clients.length)];
    const traj = trajectoryById.get(client.client_id);
    if (!traj) continue;

    const controlSet = campaignControl.get(tpl.campaign_id);
    const isControl = controlSet && controlSet.has(client.client_id);

    const ts = pickTimestampForTrigger(
      tpl,
      client,
      traj,
      monthIndex,
      windowStart,
      windowEnd,
      transactionsByClientMonth,
      rng
    );
    if (ts === null) continue;

    // Частотне обмеження (П5.1): до 2 push/тиждень у перші 30 днів,
    // до 1 push/день у будь-який період (для channel=push).
    if (tpl.channel === "push") {
      const log = pushLog.get(client.client_id) || [];
      const within24h = log.filter((t) => Math.abs(t - ts) < 86400000).length;
      const within7d = log.filter((t) => Math.abs(t - ts) < 7 * 86400000).length;
      const daysSinceOpen = (ts - client.opened_at_ms) / 86400000;

      if (within24h >= 1) continue;
      if (daysSinceOpen <= 30 && within7d >= 2) continue;

      log.push(ts);
      log.sort((a, b) => a - b);
      pushLog.set(client.client_id, log);
    }

    counter++;
    const communication_id = padId("comm", counter, 8);

    const baseProps = {
      distinct_id: client.client_id,
      client_id: client.client_id,
      communication_id,
      campaign_id: tpl.campaign_id,
      template_id: tpl.template_id,
      practice: tpl.practice,
      channel: tpl.channel,
      trigger_type: tpl.trigger_type,
      experiment_type: "exclusion_holdout",
      variant: isControl ? "control" : "treatment",
    };

    if (isControl) {
      // Для control: жодна подія не генерується (клієнт не отримує комунікацію).
      // Але ми все одно рахуємо "target", щоб ніжно не підвищувати обсяг —
      // тому збільшуємо produced (це "квазі-відправка" для цілей обліку обсягу).
      produced++;
      continue;
    }

    events.push({
      event: "communication_sent",
      properties: baseProps,
      timestamp: iso(ts),
    });

    // delivered (95-98%)
    const deliveredRate = {
      push: 0.96,
      sms: 0.98,
      email: 0.94,
      in_app: 0.99,
      call: 0.7,
    }[tpl.channel];
    const deliveredMs =
      ts + randInt(rng, 1000, tpl.channel === "email" ? 120000 : 15000);
    const delivered = rng() < deliveredRate && deliveredMs <= windowEnd;

    if (delivered) {
      events.push({
        event: "communication_delivered",
        properties: baseProps,
        timestamp: iso(deliveredMs),
      });

      // opened (push ~35%, email ~25%, sms ~50%, in_app ~60%)
      const openRate = {
        push: 0.35,
        sms: 0.5,
        email: 0.25,
        in_app: 0.6,
        call: 0.8,
      }[tpl.channel];
      const openedMs = deliveredMs + randInt(rng, 30_000, 8 * 3600_000);
      const opened = rng() < openRate && openedMs <= windowEnd;

      if (opened) {
        events.push({
          event: "communication_opened",
          properties: baseProps,
          timestamp: iso(openedMs),
        });

        // clicked (15-40% серед opened)
        const clickRate = {
          push: 0.25,
          sms: 0.15,
          email: 0.1,
          in_app: 0.4,
          call: 0.5,
        }[tpl.channel];
        const clickedMs = openedMs + randInt(rng, 2000, 5 * 60_000);
        if (rng() < clickRate && clickedMs <= windowEnd) {
          events.push({
            event: "communication_clicked",
            properties: baseProps,
            timestamp: iso(clickedMs),
          });
        }
      }
    }

    produced++;
  }

  return { events };
}

function pickWeightedTemplate(rng) {
  const weights = TEMPLATES.map((t) => {
    // monthly_digest та partner — найчастіші
    if (t.trigger_type === "monthly_digest") return { value: t, weight: 6 };
    if (t.trigger_type === "card_activated") return { value: t, weight: 3 };
    if (t.trigger_type === "no_tx_day_7") return { value: t, weight: 3 };
    if (t.trigger_type === "first_tx") return { value: t, weight: 3 };
    if (t.trigger_type === "tx_over_3000") return { value: t, weight: 2 };
    return { value: t, weight: 1 };
  });
  return pickWeighted(rng, weights);
}

function pickTimestampForTrigger(
  tpl,
  client,
  traj,
  monthIndex,
  windowStart,
  windowEnd,
  transactionsByClientMonth,
  rng
) {
  if (tpl.trigger_type === "card_activated") {
    if (monthIndex !== 0) return null;
    const base = client.opened_at_ms;
    const [minD, maxD] = tpl.delay_minutes;
    const delayMs = randInt(rng, minD, maxD) * 60_000;
    const ts = base + delayMs;
    if (ts < windowStart || ts > windowEnd) return null;
    return ts;
  }

  if (tpl.trigger_type === "no_tx_day_7") {
    if (!traj.firstTxAtMs || traj.firstTxAtMs > client.opened_at_ms + 7 * 86400000) {
      const ts = client.opened_at_ms + 7 * 86400000 + randInt(rng, 0, 12 * 3600_000);
      if (ts < windowStart || ts > windowEnd) return null;
      return ts;
    }
    return null;
  }

  if (tpl.trigger_type === "first_tx") {
    if (!traj.firstTxAtMs) return null;
    const [minD, maxD] = tpl.delay_minutes;
    const ts = traj.firstTxAtMs + randInt(rng, minD, maxD) * 60_000;
    if (ts < windowStart || ts > windowEnd) return null;
    return ts;
  }

  if (tpl.trigger_type === "tx_over_3000") {
    const txs = transactionsByClientMonth.get(`${client.client_id}|${monthIndex}`);
    if (!txs || txs.length === 0) return null;
    const candidates = txs.filter((t) => t.amount >= 3000);
    if (candidates.length === 0) return null;
    const tx = candidates[Math.floor(rng() * candidates.length)];
    const [minD, maxD] = tpl.delay_minutes;
    const ts = tx.ts + randInt(rng, minD, maxD) * 60_000;
    if (ts < windowStart || ts > windowEnd) return null;
    return ts;
  }

  if (tpl.trigger_type === "monthly_digest") {
    return randomMsInRange(rng, windowStart, windowEnd);
  }

  return null;
}
