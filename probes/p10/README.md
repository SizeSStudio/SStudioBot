# P10 换模型时有未完的工具调用（IC-11）

结论在 `docs/tech/08-probes.md` P10「结果」。

## 怎么重跑

在本机仓库根目录。服务器名读 `~/.config/sbot/deploy.env` 的 `SBOT_HOST`，那边要能 `sudo -n`。

```bash
bash probes/p10/run.sh "" list                # 经代理列端点上的模型名
bash probes/p10/run.sh <跨家模型名> smoke     # 每格 1 次
bash probes/p10/run.sh <跨家模型名> 10        # 正式：A、B ×（同家、跨家）各 10 次
bash probes/p10/run.sh "" replay <测试 home>  # 对照：重放 3 个 A 跨家换回后的请求，原样和改 id 各一次
```

正式跑要几分钟到十几分钟，ssh 别断。上游请求数超过 `P10_MAX_CALLS`（默认 110）后记录器直接拒。

## 做了什么

- 每次新开测试 home（`/srv/data/sbot/testhomes/p10-<时间>`，不删），代码经 `~/sbot-dev/p10/` 中转；`node_modules` 链到线上版本的（pi 版本同 `core/package-lock.json`）。代理占 7829–7831 里第一个空的端口。
- `proxy-main.ts`：旧 `core/src/proxy.ts` 单独一个进程，只有它拿 `SBOT_SECRETS`；探针进程只读两个 run 令牌。
- `setup.ts`：只改测试 home 里那份 `models.yaml`，把 `expert` 档指到同一端点上的另一家模型。同家 = `light`↔`work`，跨家 = `light`↔`expert`，两个方向各一半。
- `probe.ts`：pi 嵌入照旧 `PiRunner`。pi → 进程内记录器（记请求体和响应，不记请求头）→ 代理 → 上游。单数号试验要求模型一轮里并行调两次（一个立刻返回，一个挂住）。挂住的工具不理 abort，和旧 `piTools` 一样。
  - A：挂住时 `setModel`，放行工具，本轮自己接着跑。
  - B：挂住时 `abort()`，工具回一条「已取消」错误结果，`setModel`，放行原来的活，再发一句「接着做」。换完模型又调 `lookup` 记一次重调。
- `replay.ts`：A 跨家换回后新模型重调工具的对照，只看是不是调用 id 的形状引起的。

## 产物

测试 home 里：`p10-results.json`（汇总、代理 `usage` 表、逐次结果）、`p10-requests.jsonl`（请求体和响应）、`logs/proxy.log`。

## 结果里各列

| 列 | 意思 |
|---|---|
| `historyOk` | 无 400、无错误事件；下一次请求到了新模型；每个 `tool_use` 紧跟恰好一条结果；已返回的结果原样在；没返回的按做法是真结果（A）或「已取消」（B）；没有 pi 自己补的 `No result provided` |
| `openFinished` / `openRealDelivered` | 挂住的调用里实际跑完的 / 真结果进过上游请求的 |
| `recalls`、`trialsRecalled` | 换完模型后又调工具的次数、出现过的试验数 |
| `replyHasCodes` | 最后一条回复带上了应有的代码 |
| `thinkingBefore` / `thinkingSentAfter` | 换之前带 thinking 的响应数 / 换之后请求里带的 thinking 块数 |
