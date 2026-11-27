// The same vectors and fatal-failure checks with the node:crypto AEAD swapped in: the state machine is
// unchanged when the cipher moves to native code.
import { useAead } from "../noise/cipher-state.ts";
import { nodeAead } from "../noise/aead-node.ts";

useAead(nodeAead);
await import("./noise.test.ts");
await import("./channel.test.ts");
