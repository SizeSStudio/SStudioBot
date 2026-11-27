`cipher-state.ts`、`symmetric-state.ts`、`handshake.ts` 改自 Paseo（https://github.com/getpaseo/paseo ，`packages/relay/src/noise/`，提交 bec6311），
Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0（http://www.apache.org/licenses/LICENSE-2.0）。

改动：import 换成 `.ts`；CipherState 解密失败后整个作废（02：解密失败一次就断开），清掉的状态再调用一律抛错，不再原样返回明文；
AEAD 和 X25519 抽成接口（`crypto.ts` 的 `Aead`、`Dh`、`useCrypto`），默认 noble，`node-crypto.ts` 是 node:crypto 版（P1：Hermes 上要换原生）；去掉 vitest。
`channel.ts` 是我们自己的（P1 写、W1b 改成用 `protocol/fragment.ts` 分片），不来自 Paseo。

`fixtures/cacophony-nk-25519-chachapoly-sha256.json` 摘自 cacophony 的 `vectors/cacophony.txt`（https://github.com/haskell-cryptography/cacophony ，公有领域测试数据）。
