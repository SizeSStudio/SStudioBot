// Feishu plugin state other modules read (timers: where my scheduled events land). Its own file so they don't
// import the plugin and its SDK.
import { kvGet } from "../../db/ambient.ts";

export const OWNER_DM_LANE = "feishu:dm:owner";
/** the bot↔me DM chat id, learned from my first DM (instance data: only in the db) */
export const OWNER_DM_KEY = "channels.feishu.owner_dm_chat";
export const ownerDmChat = (): string | undefined => kvGet(OWNER_DM_KEY);
