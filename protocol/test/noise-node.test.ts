// The same vectors and fatal-failure checks with the node:crypto backend (hub, node; also the shape of the Android
// one): the state machine is unchanged when the primitives move to native code. Each test file is its own
// process under node --test, so the backend switch stays inside this file.
import { useCrypto } from "../noise/crypto.ts";
import { nodeAead, nodeDh } from "../noise/node-crypto.ts";

useCrypto({ aead: nodeAead, dh: nodeDh });
await import("./noise.test.ts");
await import("./channel.test.ts");
