// The device writes (docs/tech/02 路由表, 06 「设备管理」「配对」), W2a. The list and the Device entity are W2b's
// (api/read.ts DevicesRes, api/entities.ts Device).
import { z } from "zod";

export const Role = z.enum(["client", "node"]);

export const DeviceRename = z.object({ name: z.string().trim().min(1).max(100) });

export const InviteReq = z.object({ role: Role });
export const InviteRes = z.object({
  link: z.string(),                     // sstudiobot://pair#v1.… — treat it like a password
  code: z.string(),                     // the v1.… part, for the paste box
  expires: z.number().int(),
  relay_enabled: z.boolean(),           // false: the code is valid but nothing can connect until relay.enabled
});

export type InviteRes = z.infer<typeof InviteRes>;
