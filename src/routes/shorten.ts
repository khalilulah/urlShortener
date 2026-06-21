import { Router, Request, Response } from "express";
import { createLink } from "../db/links";

const router = Router();

router.post("/shorten", async (req: Request, res: Response) => {
  const { longUrl } = req.body;

  if (!longUrl || typeof longUrl !== "string") {
    return res
      .status(400)
      .json({ error: "longUrl is required and must be a string" });
  }

  try {
    new URL(longUrl); // throws if invalid
  } catch {
    return res.status(400).json({ error: "longUrl must be a valid URL" });
  }

  try {
    const { code } = await createLink(longUrl);
    const shortUrl = `${process.env.BASE_URL}/${code}`;
    res.status(201).json({ shortUrl, code });
  } catch (err) {
    console.error("Error creating link:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

export default router;
