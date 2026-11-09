import { providerGet } from "../provider/client";
import { redis } from "../redis";
import { log } from "../logger";

interface Competition {
  cid: number;
  title: string;
  status: string;
  game_format: string;
  season: string;
}
interface CompetitionList {
  items?: Competition[];
  total_items?: string | number;
}
interface Match {
  match_id: number;
  title: string;
  status: number;
  status_str: string;
  game_state: number;
  game_state_str: string;
  format_str: string;
  commentary: number;
}
interface MatchList {
  items?: Match[];
  total_items?: string | number;
}

async function main() {
  log.info("1/6 Checking Redis...");
  log.info("    Redis replied:", await redis.ping());

  log.info("2/6 Fetching 5 competitions...");
  const first = await providerGet<CompetitionList>("competitions", { per_page: 5, paged: 1 });
  log.info(`    OK. Total competitions visible to this token: ${first.body.response.total_items}`);
  for (const c of first.body.response.items ?? []) {
    log.info(`    - [${c.cid}] ${c.title} (${c.status}, ${c.game_format}, ${c.season})`);
  }

  log.info("3/6 Repeating the same call to test ETag support...");
  const second = await providerGet<CompetitionList>("competitions", { per_page: 5, paged: 1 });
  log.info(
    second.notModified
      ? "    Provider answered 'not modified'. ETag shortcut works."
      : "    Provider sent full data again. ETag shortcut NOT confirmed (not a problem).",
  );

  log.info("4/6 Looking for live competitions...");
  const live = await providerGet<CompetitionList>("competitions", { status: "live", per_page: 10 });
  const liveComps = live.body.response.items ?? [];
  log.info(`    Live competitions: ${liveComps.length}`);
  for (const c of liveComps) log.info(`    - [${c.cid}] ${c.title}`);

  log.info("5/6 Matches of the first live competition...");
  if (liveComps.length === 0) {
    log.info("    No live competition right now. Skipping.");
  } else {
    const cid = liveComps[0].cid;
    const matches = await providerGet<MatchList>(`competitions/${cid}/matches`, { per_page: 50 });
    const items = matches.body.response.items ?? [];
    log.info(`    ${items.length} match(es) returned for competition ${cid}`);
    for (const m of items.slice(0, 10)) {
      log.info(
        `    - [${m.match_id}] ${m.title} | status ${m.status}=${m.status_str} | game_state ${m.game_state}=${m.game_state_str} | commentary=${m.commentary}`,
      );
    }
  }

  log.info("6/6 Discovering match status codes (trying 1 to 4)...");
  for (const code of [1, 2, 3, 4]) {
    try {
      const r = await providerGet<MatchList>("matches", { status: code, per_page: 3 });
      const sample = (r.body.response.items ?? [])[0];
      log.info(
        sample
          ? `    status=${code} -> "${sample.status_str}" (example: ${sample.title})`
          : `    status=${code} -> no matches returned`,
      );
    } catch (err) {
      log.warn(`    status=${code} failed: ${(err as Error).message}`);
    }
  }

  log.info("Done");
}

main()
  .catch((err) => {
    log.error("Test failed:", err);
    process.exitCode = 1;
  })
  .finally(() => redis.quit());