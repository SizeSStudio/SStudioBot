// GET /api/v1/status (docs/tech/03 「cli」: `sbot status`). Fields are added as the waves bring them; the hub's
// public key fingerprint is null until the hub has a static key (W2, 06).
import { z } from "zod";

export const StatusRes = z.object({
  version: z.string(),
  hub_sha: z.string(),
  protocol: z.object({ current: z.number().int(), min: z.number().int() }),
  /** hex sha256 of the hub's static Noise public key; null = no key yet */
  hub_key_fingerprint: z.string().nullable(),
  started_at: z.number().int(),
  db_version: z.number().int(),
});
export type StatusRes = z.infer<typeof StatusRes>;
