import { redisClient } from "./redisClient";

const LINK_CACHE_TTL_SECONDS = 3600; // 1 hour

export async function getCachedLongUrl(
  code: string | string[],
): Promise<string | null> {
  try {
    return await redisClient.get(`link:${code}`);
  } catch (err) {
    console.error("Redis GET failed, falling back to DB:", err);
    return null;
  }
}

export async function setCachedLongUrl(
  code: string | string[],
  longUrl: string,
): Promise<void> {
  try {
    await redisClient.setEx(`link:${code}`, LINK_CACHE_TTL_SECONDS, longUrl);
  } catch (err) {
    console.error(
      "Redis SETEX failed, continuing without caching this entry:",
      err,
    );
  }
}

export async function incrementClickCount(
  code: string | string[],
): Promise<void> {
  try {
    await redisClient.incr(`clicks:${code}`);
  } catch (err) {
    console.error("Redis INCR failed, click not counted:", err);
  }
}
