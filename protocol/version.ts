// Protocol version (docs/tech/02 「版本」). Sent in the second handshake message and by GET /api/v1/meta.
// v1 only grows: new optional fields, routes, entities, event types (scripts/protocol-check.ts guards it).
// A peer older than `min` is told to upgrade instead of guessing.
export const PROTOCOL = { current: 1, min: 1 } as const;
