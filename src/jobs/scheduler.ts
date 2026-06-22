import { flushClickCounts } from "./flushClickCounts";

const FLUSH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

export function startClickFlushJob(): void {
  setInterval(async () => {
    try {
      await flushClickCounts();
      console.log("Click counts flushed to Postgres");
    } catch (err) {
      console.error("Click flush job failed:", err);
    }
  }, FLUSH_INTERVAL_MS);
}
