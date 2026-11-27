#!/bin/bash
# Bundles bench/crypto-speed.ts for Hermes, compiles to optimized bytecode (as a release build does) and runs it.
#   bash bench/hermes.sh <dir with hermes + hermesc> <dir with node_modules/.bin/esbuild>
# Hermes CLI: github.com/facebook/hermes releases (hermes-cli-<os>.tar.gz). esbuild + Babel: npm i --ignore-scripts esbuild @babel/core @babel/cli @babel/plugin-transform-classes in a scratch dir.
set -euo pipefail
cd "$(dirname "$0")/.."
H=$1; E=$2; out=$(mktemp -d)
"$E/node_modules/.bin/esbuild" bench/hermes-entry.ts --bundle --format=iife --target=es2020 --log-level=warning --outfile="$out/b.js"
# Hermes 0.13 has no class syntax; RN's Babel preset lowers it in a real build, so do the same here.
"$E/node_modules/.bin/babel" --no-babelrc --plugins "$E/node_modules/@babel/plugin-transform-classes" "$out/b.js" -o "$out/c.js"
"$H/hermesc" -O -emit-binary -out "$out/b.hbc" "$out/c.js"
for i in 1 2 3; do "$H/hermes" "$out/b.hbc"; echo; done
