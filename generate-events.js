#!/usr/bin/env node
/**
 * Генерує JSON-файли подій у папку <base>/<YYYY-MM>/
 *
 *   node generate-events.js --month 2026-03
 *   node generate-events.js --month 2026-03 --dir ./events
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildEvents,
  EVENT_FILES,
} from "./lib/generate-cashback-events.js";

function parseArgs(argv) {
  const out = { month: null, dir: "events" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--month" || a === "--period") && argv[i + 1]) {
      out.month = argv[++i];
    } else if (a === "--dir" && argv[i + 1]) {
      out.dir = argv[++i];
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.month) {
    console.error("Потрібно: --month YYYY-MM (або --period YYYY-MM)");
    process.exit(1);
  }

  const data = buildEvents(args.month);
  const folderName = data.meta.month;
  const outDir = join(args.dir, folderName);

  await mkdir(outDir, { recursive: true });

  const meta = {
    ...data.meta,
    generated_at: new Date().toISOString(),
    files: {
      views: EVENT_FILES.views,
      selections: EVENT_FILES.selections,
      transactions: EVENT_FILES.transactions,
    },
    counts: {
      views: data.views.length,
      selections: data.selections.length,
      transactions: data.transactions.length,
    },
  };

  await writeFile(join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  await writeFile(
    join(outDir, EVENT_FILES.views),
    JSON.stringify(data.views, null, 2),
    "utf8"
  );
  await writeFile(
    join(outDir, EVENT_FILES.selections),
    JSON.stringify(data.selections, null, 2),
    "utf8"
  );
  await writeFile(
    join(outDir, EVENT_FILES.transactions),
    JSON.stringify(data.transactions, null, 2),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        written: outDir,
        meta,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
