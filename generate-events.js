#!/usr/bin/env node
/**
 * Генерує JSON-файли подій активації для M0-когорти цифрового банку.
 *
 * Мінімальний запуск:
 *   node generate-events.js --month 2026-03
 *   node generate-events.js --month 2026-03 --scenario target
 *   node generate-events.js --month 2026-03 --cards-min 2500 --cards-max 3500 --seed 42
 *
 * --month YYYY-MM задає M0. Створюються 4 папки: <dir>/<M0>, <M0+1>, <M0+2>, <M0+3>.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildEvents,
  DEFAULT_OPTS,
  EVENT_FILES,
} from "./lib/generate-activation-events.js";
import { listScenarios, DEFAULT_SCENARIO } from "./lib/scenarios.js";

function parseArgs(argv) {
  const out = {
    month: null,
    dir: "events",
    cardsMin: null,
    cardsMax: null,
    scenario: null,
    seed: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if ((a === "--month" || a === "--period") && next) {
      out.month = next;
      i++;
    } else if (a === "--dir" && next) {
      out.dir = next;
      i++;
    } else if (a === "--cards-min" && next) {
      out.cardsMin = parseInt(next, 10);
      i++;
    } else if (a === "--cards-max" && next) {
      out.cardsMax = parseInt(next, 10);
      i++;
    } else if (a === "--scenario" && next) {
      out.scenario = next;
      i++;
    } else if (a === "--seed" && next) {
      out.seed = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Невідомий аргумент: ${a}. Спробуйте --help.`);
      process.exit(1);
    }
  }
  return out;
}

function printHelp() {
  const scenarios = listScenarios();
  const scenarioLines = scenarios
    .map((s) => `    ${s.name.padEnd(14)} ${s.description}`)
    .join("\n");

  console.log(`node generate-events.js --month YYYY-MM [опції]

Обов'язково:
  --month YYYY-MM        M0-місяць (місяць випуску карток)

Опції:
  --cards-min N          мінімум карток у M0-когорті (дефолт ${DEFAULT_OPTS.cardsMin})
  --cards-max N          максимум карток у M0-когорті (дефолт ${DEFAULT_OPTS.cardsMax})
                         (випадкове ціле у [min, max])

  --scenario <name>      пресет поведінки когорти (дефолт ${DEFAULT_SCENARIO}):
${scenarioLines}

  --seed <int|str>       детермінований PRNG
  --dir <path>           базова папка для виводу (дефолт events)
  --help, -h             ця довідка

Генерується 10 типів подій за 4 місяці (M0..M3). Всі інші обсяги (транзакції,
перегляди, вибори, комунікації, снепшоти, експерименти) визначає сценарій —
тобто не треба вказувати по одному.`);
}

function validate(opts) {
  if (!opts.month) throw new Error("Потрібно: --month YYYY-MM");
  if (opts.cardsMin != null && opts.cardsMax != null && opts.cardsMin > opts.cardsMax) {
    throw new Error(`--cards-min=${opts.cardsMin} > --cards-max=${opts.cardsMax}`);
  }
  if (opts.cardsMin != null && opts.cardsMin < 1) {
    throw new Error(`--cards-min має бути ≥ 1`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  validate(args);

  const overrides = {};
  if (args.cardsMin != null) overrides.cardsMin = args.cardsMin;
  if (args.cardsMax != null) overrides.cardsMax = args.cardsMax;
  if (args.scenario != null) overrides.scenario = args.scenario;
  if (args.seed != null) overrides.seed = args.seed;

  const data = buildEvents(args.month, overrides);

  const summary = {
    base_dir: args.dir,
    m0_month: data.meta.m0_month,
    months: data.meta.months,
    cohort_size: data.meta.cohort_size,
    cards_range: data.meta.cards_range,
    scenario: data.meta.scenario.name,
    archetype_distribution: data.meta.archetype_distribution,
    monthly_targets: data.meta.monthly_targets,
    seed: data.meta.seed,
    per_month: [],
  };

  for (const bucket of data.months) {
    const outDir = join(args.dir, bucket.key);
    await mkdir(outDir, { recursive: true });

    const counts = {};
    for (const [type, arr] of Object.entries(bucket.events)) {
      counts[type] = arr.length;
      const file = EVENT_FILES[type];
      if (!file) continue;
      await writeFile(join(outDir, file), JSON.stringify(arr, null, 2), "utf8");
    }

    const meta = {
      month: bucket.key,
      period_start: bucket.period_start,
      period_end: bucket.period_end,
      m0_month: data.meta.m0_month,
      months: data.meta.months,
      generated_at: new Date().toISOString(),
      files: { ...EVENT_FILES },
      counts,
      cohort_size: data.meta.cohort_size,
      cards_range: data.meta.cards_range,
      scenario: data.meta.scenario,
      archetype_distribution: data.meta.archetype_distribution,
      monthly_targets: data.meta.monthly_targets,
      seed: data.meta.seed,
    };
    await writeFile(
      join(outDir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );

    summary.per_month.push({
      month: bucket.key,
      out_dir: outDir,
      counts,
      total: Object.values(counts).reduce((s, n) => s + n, 0),
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
