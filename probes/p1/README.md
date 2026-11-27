# P1 探针：Noise + 中继

08 的 P1。不合进 `main`；W1 从这里搬 `noise/`（`cipher-state.ts`、`symmetric-state.ts`、`handshake.ts`、`channel.ts`、`aead-node.ts`）。

```
noise/        Noise_NK_25519_ChaChaPoly_SHA256（改自 Paseo，见 noise/NOTICE.md）、分片通道（02）
envelope.ts   主那条 WS 的信封（06）
relay.ts      中继：/v1/hub、/v1/peer、/healthz，白名单注册、自保限额、不缓冲
hub.ts        探针用的主：Noise 响应方、auth/pair、几个探针路由；经中继和/或直连
device.ts     探针用的设备：Noise 发起方、auth/pair、req/res
identity.ts   设备 Ed25519、签名域分隔和绑定握手 hash
bench/        各项测量
test/         node --test
```

依赖锁死版本，装的时候不跑脚本：`npm ci --ignore-scripts`（四个包都没有 install 脚本）。

## 正确性

```
npm test     # cacophony 向量 + 致命失败、重放、反射、乱序、分片、1 MiB 上限；再用 node:crypto 的 AEAD 跑一遍
```

## 起一套（本机或服务器上的临时目录）

```
H=$(mktemp -d); node bench/setup.ts $H 21 > $H/pk.json        # 主密钥、中继白名单和令牌、21 个设备身份
PK=$(node -p "JSON.parse(require('fs').readFileSync('$H/pk.json')).hub_pk")
node relay.ts --port 7830 --hubs $H/relay-hubs.json --relaxed &   # --relaxed：探针从一个 IP 开几百个会话、故意认证失败
RELAY_TOKEN=$(cat $H/relay-token) node hub.ts --key $H/hub-key.json --devices $H/devices.json \
  --relay ws://127.0.0.1:7830 --direct 7831 &
```

## 测量

| 项 | 命令 |
|---|---|
| 经中继比直连多的往返 | `node bench/rtt.ts --relay ws://H:7830 --direct ws://H:7831 --hub-pk $PK --identity $H/dev-0.json --n 300` |
| 20 连接 × 10 条/秒 | `node bench/load.ts --relay ws://H:7830 --relay-http http://H:7830 --hub-pk $PK --home $H --seconds 120` |
| 改字节、换主公钥、重放 auth（各 10 次） | `node bench/security.ts --relay ws://H:7830 --hub-pk $PK --identity $H/dev-0.json --rounds 10` |
| 加密速度（Node） | `node bench/crypto-speed.ts` |
| 加密速度（Hermes CLI） | `bash bench/hermes.sh <hermes 目录> <装了 esbuild 和 Babel 的目录>`（脚本头上写了怎么准备） |

- `load.ts` 用最后一个身份当控制会话读主的 `/probe/stats`（事件循环延迟、RSS），中继 RSS 读 `/healthz`。
- `security.ts` 里改字节经 `bench/tamper-proxy.ts`（扮演恶意中继或网络），两个方向各翻一位；重放分明文（拿 A 的 `auth` 帧在 B 通道上发）和密文（把 A 的加密 `auth` 消息注进 B 通道）两种。
- 服务器上只用 7829–7831，只绑 `127.0.0.1`，从 Mac 经 `ssh -L` 连；测完杀进程、删临时目录。
