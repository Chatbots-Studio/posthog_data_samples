#!/usr/bin/env node
/**
 * Читає згенеровані JSON-файли з папки <dir>/<YYYY-MM>/ і відправляє у PostHog (EU).
 *
 *   POSTHOG_API_KEY=phc_... node send-events.js                     # усі місяці з events/
 *   POSTHOG_HOST=https://... node send-events.js                  # self-hosted або інший ingest
 *   POSTHOG_API_KEY=phc_... node send-events.js --month 2026-03    # тільки один місяць
 *   node send-events.js --only transactions
 *   node send-events.js --only card_activated
 *   node send-events.js --dry-run
 *   node send-events.js --dir ./my-data
 */

import { readFile, access, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import {
  EVENT_FILES,
  EVENT_GROUPS,
  filterEvents,
  parseYearMonth,
} from "./lib/generate-activation-events.js";

/** Дефолт — PostHog Cloud EU. Для self-hosted задайте POSTHOG_HOST (базовий URL інстансу або повний шлях до /capture/). */
const DEFAULT_POSTHOG_CAPTURE = "https://eu.i.posthog.com/capture/";
const BATCH_SIZE = 100;

/**
 * POSTHOG_HOST: база інстансу (https://posthog.example.com) або повний ingest URL (.../capture/).
 */
function resolveCaptureUrl(raw) {
  if (!raw?.trim()) return DEFAULT_POSTHOG_CAPTURE;
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, "");
  if (/\/capture$/i.test(u)) return `${u}/`;
  return `${u}/capture/`;
}

async function verifyPosthogIngest(captureUrl, apiKey) {
  const probe = {
    event: "probe_connection",
    properties: { $lib: "posthog_data_samples", probe: true },
    distinct_id: `probe_${process.pid}_${Date.now()}`,
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify({ api_key: apiKey, batch: [probe] });
  const res = await fetch(captureUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Перевірка прийому подій не пройшла: HTTP ${res.status} ${text.slice(0, 400)}\nIngest URL: ${captureUrl}`
    );
  }
}

function parseArgs(argv) {
  const out = {
    month: null,
    dir: "events",
    only: "all",
    dryRun: false,
    skipVerify: false,
    batchSize: BATCH_SIZE,
    showProgress: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--month" || a === "--period") && argv[i + 1]) {
      out.month = argv[++i];
    } else if (a === "--dir" && argv[i + 1]) {
      out.dir = argv[++i];
    } else if (a === "--only" && argv[i + 1]) {
      out.only = argv[++i];
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--skip-verify") {
      out.skipVerify = true;
    } else if (a === "--no-progress") {
      out.showProgress = false;
    } else if (a === "--batch-size" && argv[i + 1]) {
      out.batchSize = Math.max(1, parseInt(argv[++i], 10) || BATCH_SIZE);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log(`node send-events.js [опції]

  --month YYYY-MM        відправити тільки один місяць (папку).
                         Якщо не вказано — відправить усі місяці з --dir по черзі.
  --dir <path>           базова папка з подіями (дефолт events)
  --only <group|type>    фільтр; група: all | ${Object.keys(EVENT_GROUPS).join(
    " | "
  )}
                         або ім'я події, напр. card_activated, transaction_completed
  --dry-run              підрахунок без відправки
  --skip-verify          не перевіряти ключ і ingest перед відправкою (не рекомендовано)
  --batch-size N         розмір пакета для PostHog API (дефолт ${BATCH_SIZE})
  --no-progress          без рядка прогресу

Змінні: POSTHOG_API_KEY (крім --dry-run), POSTHOG_HOST — ingest URL (дефолт EU Cloud, див. README).`);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function findMonthDirs(baseDir) {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Не вдалося прочитати --dir ${baseDir}: ${e.message}`);
  }
  const months = entries
    .filter((d) => d.isDirectory() && MONTH_RE.test(d.name))
    .map((d) => d.name)
    .sort();
  if (months.length === 0) {
    throw new Error(
      `У ${baseDir} немає підпапок YYYY-MM. Спочатку: node generate-events.js --month ...`
    );
  }
  return months;
}

async function pathExists(p) {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadEventsFromDir(absDir) {
  const metaPath = join(absDir, "meta.json");
  if (!(await pathExists(metaPath))) {
    throw new Error(
      `Немає meta.json у ${absDir}. Спочатку: node generate-events.js --month ...`
    );
  }
  const meta = JSON.parse(await readFile(metaPath, "utf8"));

  const eventsByType = {};
  for (const [type, file] of Object.entries(EVENT_FILES)) {
    const p = join(absDir, file);
    if (!(await pathExists(p))) {
      eventsByType[type] = [];
      continue;
    }
    const raw = await readFile(p, "utf8");
    eventsByType[type] = JSON.parse(raw);
  }
  return { meta, eventsByType };
}

async function postBatch(captureUrl, apiKey, items, dryRun) {
  if (dryRun) {
    return { ok: true, dryRun: true, count: items.length };
  }
  const body = JSON.stringify({ api_key: apiKey, batch: items });
  const res = await fetch(captureUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PostHog ${res.status}: ${text.slice(0, 500)}`);
  }
  return { ok: true, count: items.length };
}

function formatProgressLine(sent, total, batchNum, batchCount) {
  const pct = total ? ((100 * sent) / total).toFixed(1) : "100.0";
  return `Відправка: ${sent}/${total} (${pct}%)  пакет ${batchNum}/${batchCount}`;
}

function createProgressReporter(total, batchCount) {
  const isTTY = process.stdout.isTTY;
  let lastBucket = -1;
  return function report(sent, batchNum) {
    const line = formatProgressLine(sent, total, batchNum, batchCount);
    if (isTTY) {
      process.stdout.write(`\r${line}  `);
      return;
    }
    const pct = total ? (100 * sent) / total : 100;
    const bucket = Math.min(100, Math.floor(pct / 5) * 5);
    if (sent === total || bucket > lastBucket) {
      console.log(line);
      lastBucket = bucket;
    }
  };
}

async function sendEvents(
  captureUrl,
  apiKey,
  events,
  { dryRun, batchSize, showProgress }
) {
  const total = events.length;
  const batchCount = total ? Math.ceil(total / batchSize) : 1;
  const report =
    showProgress && total > 0 ? createProgressReporter(total, batchCount) : null;

  let sent = 0;
  let batchNum = 0;
  for (let i = 0; i < events.length; i += batchSize) {
    batchNum += 1;
    const chunk = events.slice(i, i + batchSize).map((row) => ({
      event: row.event,
      properties: row.properties,
      timestamp: row.timestamp,
    }));
    await postBatch(captureUrl, apiKey, chunk, dryRun);
    sent += chunk.length;
    if (report) report(sent, batchNum);
    if (!dryRun && i + batchSize < events.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (report && process.stdout.isTTY && total > 0) {
    process.stdout.write("\n");
  }
  return sent;
}

async function sendMonth(month, args, apiKey, captureUrl) {
  const absDir = join(args.dir, month);
  const { meta, eventsByType } = await loadEventsFromDir(absDir);
  const events = filterEvents(eventsByType, args.only);

  console.log(
    JSON.stringify(
      {
        source: absDir,
        only: args.only,
        meta_from_file: {
          month: meta.month,
          m0_month: meta.m0_month,
          cohort_size: meta.cohort_size,
          counts: meta.counts,
        },
        sending: events.length,
      },
      null,
      2
    )
  );

  const sent = await sendEvents(captureUrl, apiKey || "dry", events, {
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    showProgress: args.showProgress,
  });
  console.log(
    args.dryRun
      ? `[dry-run] підготовлено до відправки ${sent} подій (${month})`
      : `Відправлено ${sent} подій (${month})`
  );
  return sent;
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.POSTHOG_API_KEY?.trim();
  const captureUrl = resolveCaptureUrl(process.env.POSTHOG_HOST);

  if (!args.dryRun && !apiKey) {
    console.error("Задайте POSTHOG_API_KEY або використайте --dry-run");
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`[dry-run] цільовий ingest URL був би: ${captureUrl}`);
  }

  if (!args.dryRun && apiKey && !args.skipVerify) {
    console.log(`Перевірка: ingest URL — ${captureUrl}`);
    try {
      await verifyPosthogIngest(captureUrl, apiKey);
      console.log("Перевірка: ключ прийнято, endpoint відповів успішно.");
    } catch (e) {
      console.error(e.message || e);
      console.error(
        "Підказка: переконайтесь у POSTHOG_HOST (self-hosted) і що ключ з того ж проєкту. --skip-verify щоб пропустити."
      );
      process.exit(1);
    }
  } else if (!args.dryRun && args.skipVerify) {
    console.warn(
      `Увага: --skip-verify — відправка на ${captureUrl} без перевірки ключа.`
    );
  }

  let months;
  if (args.month) {
    parseYearMonth(args.month);
    months = [args.month.trim()];
  } else {
    months = await findMonthDirs(args.dir);
    console.log(
      `Без --month: знайдено ${months.length} місяців у ${args.dir}: ${months.join(", ")}`
    );
  }

  let grandTotal = 0;
  for (const m of months) {
    if (months.length > 1) {
      console.log(`\n=== ${m} ===`);
    }
    grandTotal += await sendMonth(m, args, apiKey, captureUrl);
  }

  if (months.length > 1) {
    console.log(
      args.dryRun
        ? `\n[dry-run] усього підготовлено ${grandTotal} подій за ${months.length} міс`
        : `\nУсього відправлено ${grandTotal} подій за ${months.length} міс`
    );
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
