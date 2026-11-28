// Stands in (metro.config.js) for @pierre/diffs' `highlights` backend and shiki's oniguruma engine / wasm: both
// compile WebAssembly, which the desktop CSP doesn't allow (no wasm-unsafe-eval), and DiffView.web asks for
// 'shiki-js' only. Leaving them out also keeps ~1 MB of wasm out of the build. If anything still reaches here, it
// fails loudly and DiffView falls back to the plain text block.
const no = () => { throw new Error('wasm highlighters are not in this build (07 「diff」)') }
export class HighlightsHighlighter { constructor() { no() } }
export const createOnigurumaEngine = no
export const loadWasm = no
export default no
