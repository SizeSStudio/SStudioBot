// Hermes CLI entry (bench only). The CLI has no crypto.getRandomValues, TextDecoder or performance;
// shim them here (noble and channel.ts read these at call time, so hoisted imports are fine). An app gets real ones (expo-crypto / react-native-get-random-values, RN's TextDecoder).
import { run } from "./crypto-speed.ts";

const g = globalThis as any;
let seed = 0x9e3779b9;
g.crypto ??= {
  getRandomValues(a: Uint8Array) {
    // xorshift32 — NOT random, timing only.
    for (let i = 0; i < a.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      a[i] = seed & 0xff;
    }
    return a;
  },
};
g.TextDecoder ??= class {
  decode(b: Uint8Array) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); // ASCII payloads only
    return s;
  }
};
g.print(JSON.stringify(run(() => Date.now())));
