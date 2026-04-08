#!/usr/bin/env node
/**
 * Читає згенеровані JSON з папки <base>/<YYYY-MM>/ і відправляє в PostHog.
 *
 *   POSTHOG_API_KEY=phc_... node send-events.js --month 2026-03
 *   node send-events.js --period 2026-03 --only views
 *   node send-events.js --month 2026-03 --dir ./events --dry-run
 *   node send-events.js --month 2026-03 --no-progress   # без рядка прогресу
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  monthRange,
  EVENT_FILES,
  filterEvents,
} from "./lib/generate-cashback-events.js";

const POSTHOG_HOST = "https://eu.i.posthog.com/capture/";
const BATCH_SIZE = 100;

function parseArgs(argv) {
  const out = {
    month: null,
    dir: "events",
    only: "all",
    dryRun: false,
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
    } else if (a === "--no-progress") {
      out.showProgress = false;
    } else if (a === "--batch-size" && argv[i + 1]) {
      out.batchSize = Math.max(1, parseInt(argv[++i], 10) || BATCH_SIZE);
    }
  }
  return out;
}

async function pathExists(p) {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadEventsFromDir(absDir, only) {
  const metaPath = join(absDir, "meta.json");
  if (!(await pathExists(metaPath))) {
    throw new Error(`Немає meta.json у ${absDir}. Спочатку: node generate-events.js --month ...`);
  }

  const metaRaw = await readFile(metaPath, "utf8");
  const meta = JSON.parse(metaRaw);

  const data = {
    meta,
    views: [],
    selections: [],
    transactions: [],
  };

  async function loadArr(file) {
    const p = join(absDir, file);
    if (!(await pathExists(p))) {
      throw new Error(`Немає файлу ${p}`);
    }
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  }

  data.views = await loadArr(EVENT_FILES.views);
  data.selections = await loadArr(EVENT_FILES.selections);
  data.transactions = await loadArr(EVENT_FILES.transactions);

  return { data, events: filterEvents(data, only) };
}

async function postBatch(apiKey, items, dryRun) {
  if (dryRun) {
    return { ok: true, dryRun: true, count: items.length };
  }
  const body = JSON.stringify({ api_key: apiKey, batch: items });
  const res = await fetch(POSTHOG_HOST, {
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

/**
 * У терміналі (TTY) — один рядок з \\r; у пайпі/файлі — рядок кожні ~5% + фінал.
 */
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

async function sendEvents(apiKey, events, { dryRun, batchSize, showProgress }) {
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
    await postBatch(apiKey, chunk, dryRun);
    sent += chunk.length;
    if (report) {
      report(sent, batchNum);
    }
    if (!dryRun && i + batchSize < events.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (report && process.stdout.isTTY && total > 0) {
    process.stdout.write("\n");
  }

  return sent;
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.POSTHOG_API_KEY?.trim();
  if (!args.dryRun && !apiKey) {
    console.error("Задайте POSTHOG_API_KEY або використайте --dry-run");
    process.exit(1);
  }
  if (!args.month) {
    console.error("Потрібно: --month YYYY-MM або --period YYYY-MM (папка з даними)");
    process.exit(1);
  }

  monthRange(args.month);
  const absDir = join(args.dir, args.month.trim());

  const { data, events } = await loadEventsFromDir(absDir, args.only);

  console.log(
    JSON.stringify(
      {
        source: absDir,
        only: args.only,
        meta_from_file: data.meta,
        sending: events.length,
      },
      null,
      2
    )
  );

  const sent = await sendEvents(apiKey || "dry", events, {
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    showProgress: args.showProgress,
  });
  console.log(
    args.dryRun ? `[dry-run] підготовлено до відправки ${sent} подій` : `Відправлено ${sent} подій`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
