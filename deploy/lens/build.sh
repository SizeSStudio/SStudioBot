#!/bin/bash
# Build the read-only lens plugin (DESIGN §15 lenses, §13 "镜头 skill") from the Mac sources.
# Output: a staging dir + tarball; install on the VPS with install.sh (root) into /opt/sbot/plugins/sbot-lens.
#
#   SRC_SKILLS=<skills checkout> SRC_KB=<紫微 kb dir> bash deploy/lens/build.sh   # → deploy/lens/out/sbot-lens.tgz
#
# Both paths can also live in ~/.config/sbot/lens.env (outside the repo), which is sourced if present.
# Only what the skills need at runtime is copied: SKILL.md + templates, ziwei-chart's compiled dist + assets
# (no node_modules: the CLI only uses node:fs/path/crypto), and the 紫微 kb the SKILL.md files point at.
# Absolute source paths in SKILL.md are rewritten to the install path.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/sbot/lens.env"
[ -f "$cfg" ] && . "$cfg"
SRC_SKILLS="${SRC_SKILLS:?set SRC_SKILLS to the skills checkout (ziwei-chart, ziwei-natal, ziwei-zhanbu, liuyao-guanxiang)}"
SRC_KB="${SRC_KB:?set SRC_KB to the 紫微 kb directory the SKILL.md files point at}"
DEST=/opt/sbot/plugins/sbot-lens
out="$here/out"; stage="$out/sbot-lens"
rm -rf "$out"; mkdir -p "$stage/.claude-plugin" "$stage/skills" "$stage/kb/紫微"

ver=$(cd "$SRC_SKILLS" && git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d)
cat > "$stage/.claude-plugin/plugin.json" <<EOF
{ "name": "sbot-lens", "version": "0.2.0", "description": "SStudioBot lenses (ziwei, liuyao). Built from skills@$ver, read-only." }
EOF

c=ziwei-chart
mkdir -p "$stage/skills/$c/references"
cp "$SRC_SKILLS/$c/SKILL.md" "$SRC_SKILLS/$c/package.json" "$stage/skills/$c/"
rsync -a --exclude '*.map' --exclude '*.d.ts' "$SRC_SKILLS/$c/dist/src" "$stage/skills/$c/dist/"
rsync -a "$SRC_SKILLS/$c/assets" "$stage/skills/$c/"
cp "$SRC_SKILLS/$c/references/natal_output_contract.md" "$SRC_SKILLS/$c/references/source_strategy.md" "$stage/skills/$c/references/"
for s in ziwei-natal ziwei-zhanbu; do rsync -a "$SRC_SKILLS/$s/SKILL.md" "$SRC_SKILLS/$s/templates" "$stage/skills/$s/"; done
# 六爻·观象系辞 (M6): script + 64-gua data + the method text; runtime imports are node:fs/crypto/url/path only
l=liuyao-guanxiang
mkdir -p "$stage/skills/$l/scripts" "$stage/skills/$l/data" "$stage/skills/$l/references"
cp "$SRC_SKILLS/$l/SKILL.md" "$stage/skills/$l/"
cp "$SRC_SKILLS/$l/scripts/qigua.mjs" "$stage/skills/$l/scripts/"
cp "$SRC_SKILLS/$l/data/gua.json" "$stage/skills/$l/data/"
cp "$SRC_SKILLS/$l/references/"*.md "$stage/skills/$l/references/"
# its archive step writes to a Mac path; in a lens run the core keeps the record (readings table), so drop it
sed -i '' -e "s#\$SKILL_DIR/scripts/qigua.mjs#$DEST/skills/$l/scripts/qigua.mjs#g" \
  -e "s#^默认不写任何文件。用户明确要求存档时.*#不写存档文件：在 SStudioBot 里，结果用 submit_reading 交回，核心记进解读账本。#" "$stage/skills/$l/SKILL.md"
# whole kb except _reference (~800K): natal readings look up 星曜/宫位/四化 pages, not only the method dirs
rsync -a --exclude _reference --exclude '.*' "$SRC_KB/" "$stage/kb/紫微/"

# path rewrites (macOS sed)
# ziwei-chart: the plugin dir is read-only and prebuilt → no `cd` into it, no `npm run build`; call the CLI by
# absolute path so --out-dir ./x lands in the worker's task dir.
find "$stage/skills" -name SKILL.md -print0 | xargs -0 sed -i '' \
  -e "/^cd .*\/skills\/ziwei-chart$/d" \
  -e "/^npm run build$/d" \
  -e "s#node dist/src/cli/ziwei-chart.js#node $DEST/skills/ziwei-chart/dist/src/cli/ziwei-chart.js#g" \
  -e "s#${SRC_KB%/}#$DEST/kb/紫微#g" \
  -e "s#--out-dir /tmp/#--out-dir ./#g"
if grep -rn "/Users/" "$stage/skills" --include=SKILL.md; then
  echo "build.sh: unrewritten Mac paths left (dev-only lines are OK if listed above)" >&2
fi

COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$out" -czf "$out/sbot-lens.tgz" sbot-lens
du -sh "$stage" "$out/sbot-lens.tgz"
