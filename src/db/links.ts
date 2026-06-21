import { pool } from "./pool";
import { encodeBase62 } from "../utils/base62";

export async function createLink(
  longUrl: string,
): Promise<{ id: number; code: string }> {
  const insertResult = await pool.query<{ id: number }>(
    "INSERT INTO links (long_url) VALUES ($1) RETURNING id",
    [longUrl],
  );

  const id = insertResult.rows[0].id;
  const code = encodeBase62(id);

  await pool.query("UPDATE links SET code = $1 WHERE id = $2", [code, id]);

  return { id, code };
}

export async function getLinkByCode(
  code: string | string[],
): Promise<{ id: number; long_url: string } | null> {
  const result = await pool.query<{ id: number; long_url: string }>(
    "SELECT id, long_url FROM links WHERE code = $1",
    [code],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}
