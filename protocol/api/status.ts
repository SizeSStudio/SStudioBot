// GET /api/v1/status (docs/tech/03 「cli」: `sbot status`). Fields are added as the waves bring them; the hub's
// public key fingerprint is null until the hub has a static key (W2, 06); since W2a it always has one.
import { z } from "zod";

export const StatusRes = z.object({
  version: z.string(),
  hub_sha: z.string(),
  protocol: z.object({ current: z.number().int(), min: z.number().int() }),
  /** hex sha256 of the hub's static Noise public key; null = no key yet */
  hub_key_fingerprint: z.string().nullable(),
  /** W2a: the public key itself, base64url — relay.yaml's hub_pk; not a secret (every pairing code carries it) */
  hub_pk: z.string().optional(),
  started_at: z.number().int(),
  /** W2a: is the link to the relay on (console.yaml relay.enabled) and up right now */
  relay: z.object({ enabled: z.boolean(), connected: z.boolean() }).optional(),
  db_version: z.number().int(),
});
export type StatusRes = z.infer<typeof StatusRes>;
