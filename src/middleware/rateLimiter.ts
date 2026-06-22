import { Request, Response, NextFunction } from "express";
import { redisClient } from "../db/redisClient";

export function rateLimiter(limit: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip;
    const key = `ratelimit:${ip}:${req.path}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    try {
      // 1. Remove entries older than the window
      await redisClient.zRemRangeByScore(key, 0, now - windowMs);

      // 2. Count what's left (all remaining entries are valid)
      const count = await redisClient.zCard(key);

      if (count >= limit) {
        return res
          .status(429)
          .json({ error: "Too many requests. Please try again later." });
      }

      // 3. Record this request
      await redisClient.zAdd(key, {
        score: now,
        value: `${now}-${Math.random()}`,
      });

      // 4. Refresh TTL to match the window, so inactive IPs get cleaned up
      await redisClient.expire(key, windowSeconds);

      next();
    } catch (err) {
      console.error("Rate limiter error, allowing request through:", err);
      next(); // fail open
    }
  };
}
