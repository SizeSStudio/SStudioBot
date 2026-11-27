// 只改测试 home 里那份 models.yaml：把 expert 档指到同一个端点上的另一家模型，用来测跨家。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const file = join(process.env.SBOT_HOME!, "config", "models.yaml");
const cross = process.argv[2];
if (!process.env.SBOT_HOME?.includes("/testhomes/")) throw new Error("只在测试 home 里改配置");
const cfg = parse(readFileSync(file, "utf8"));
// 不写价格：配置里没有这家的价，账本只记 token，cost 记 0
cfg.tiers.expert = { endpoint: cfg.tiers.light.endpoint, model: cross };
writeFileSync(file, stringify(cfg));
