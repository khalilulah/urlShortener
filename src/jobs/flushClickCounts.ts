import { redisClient } from "../db/redisClient";
import { pool } from "../db/pool";

export async function flushClickCounts(): Promise<void> {
  const keys = await redisClient.keys("clicks:*");

  if (keys.length === 0) return;

  for (const key of keys) {
    const code = key.replace("clicks:", "");
    const countStr = await redisClient.get(key);
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count > 0) {
      await pool.query(
        "UPDATE links SET click_count = click_count + $1 WHERE code = $2",
        [count, code],
      );
      await redisClient.decrBy(key, count);
    }
  }
}
