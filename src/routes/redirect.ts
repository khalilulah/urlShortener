import { Router, Request, Response } from "express";
import { getLinkByCode } from "../db/links";
import {
  getCachedLongUrl,
  incrementClickCount,
  setCachedLongUrl,
} from "../db/cache";

const router = Router();

router.get("/:code", async (req: Request, res: Response) => {
  const { code } = req.params;

  try {
    const cachedUrl = await getCachedLongUrl(code);

    if (cachedUrl) {
      incrementClickCount(code); // fire-and-forget, not awaited
      return res.redirect(302, cachedUrl);
    }

    const link = await getLinkByCode(code);

    if (!link) {
      return res.status(404).json({ error: "Link not found" });
    }
    await setCachedLongUrl(code, link.long_url);
    incrementClickCount(code); // fire-and-forget, not awaited

    res.redirect(302, link.long_url);
  } catch (err) {
    console.error("Error fetching link:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

export default router;
