// Stands in (metro.config.js) for @pierre/patches, @pierre/diffs' WebAssembly word diff: the desktop CSP has no
// wasm-unsafe-eval, so its first use would be a CSP error before diffs fell back to jsdiff anyway (diffLibs.js
// resolveDiffLib). Going straight to jsdiff (`diff`, already its dependency) also keeps the inlined wasm out of the
// entry chunk.
export { createTwoFilesPatch, diffChars, diffWordsWithSpace } from 'diff'
