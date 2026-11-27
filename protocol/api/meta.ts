// GET /api/v1/meta (docs/tech/02). The first /api/v1 schema; the rest are added per wave, only ever growing.
import { z } from "zod";

export const MetaRes = z.object({
  protocol: z.object({ current: z.number().int(), min: z.number().int() }),
  hub_sha: z.string(),
});
export type MetaRes = z.infer<typeof MetaRes>;
