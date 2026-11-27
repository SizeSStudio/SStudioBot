#!/bin/bash
# Exercise sbot-deploy against a throwaway repo, with systemctl/journalctl/npm/sleep stubbed. Needs root and a "sbot"
# group (CI: sudo groupadd -f sbot; sudo bash deploy/core/test/sbot-deploy.test.sh). Touches nothing outside a temp dir.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
S="$T/shims"; mkdir -p "$S" "$T/repo"
export SBOT_DEPLOY_UNIT=sbot-deploy-test-none.service SBOT_DEPLOY_APP="$T/app" SBOT_DEPLOY_REPO="$T/repo" SBOT_DEPLOY_ENV="$T/none.env" SBOT_DEPLOY_TEST_PATH="$S"
export STUB="$T/stub"; mkdir -p "$STUB"; : > "$STUB/restarts"

# restart writes a fresh journal; a release whose core/BROKEN exists never logs "core up" and ends up failed
cat > "$S/systemctl" <<'EOF'
#!/bin/bash
case "$1" in
  restart) echo x >> "$STUB/restarts"; : > "$STUB/journal"; rm -f "$STUB/failed"
           if [ -e "$SBOT_DEPLOY_APP/current/core/BROKEN" ]; then touch "$STUB/failed"; else echo "[main] core up" > "$STUB/journal"; fi ;;
  show) echo 4242 ;;
  is-active) echo active ;;
  is-failed) if [ -e "$STUB/failed" ]; then echo failed; else echo active; fi ;;
esac
EOF
printf '#!/bin/bash\ncat "$STUB/journal" 2>/dev/null || true\n' > "$S/journalctl"
printf '#!/bin/bash\nmkdir -p node_modules\n' > "$S/npm"
printf '#!/bin/bash\nexit 0\n' > "$S/sleep"
chmod +x "$S"/*

g() { git -C "$T/repo" -c user.name=t -c user.email=t@example.invalid "$@"; }
commit() { g add -A; g commit -q -m "$1"; g rev-parse HEAD; }
deploy() { bash "$here/../sbot-deploy" "$@" | tee -a "$T/out"; }
restarts() { wc -l < "$STUB/restarts" | tr -d ' '; }
live() { readlink "$T/app/current" | sed 's#^releases/##'; }
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; fail=1; fi; }

git init -q -b main "$T/repo"
mkdir -p "$T/repo/core" "$T/repo/docs"
echo '{"name":"t","version":"0.0.0"}' > "$T/repo/core/package.json"
echo '{"name":"t","lockfileVersion":3,"packages":{}}' > "$T/repo/core/package-lock.json"
echo a > "$T/repo/core/main.ts"; echo a > "$T/repo/docs/x.md"
c1=$(commit one)

deploy --if-new >/dev/null
check "first deploy switches and restarts" "$(live) $(restarts)" "$c1 1"

echo b > "$T/repo/docs/x.md"; c2=$(commit docs-only)
deploy --if-new >/dev/null
check "docs-only commit: no switch, no restart" "$(live) $(restarts)" "$c1 1"
check "docs-only commit is recorded once" "$(grep -c " $c2 unchanged" "$T/app/deploys.log")" 1
deploy --if-new >/dev/null
check "re-check doesn't log again" "$(grep -c " $c2 unchanged" "$T/app/deploys.log")" 1
check "manual run says nothing to do" "$(deploy | grep -c 'nothing to do')" 1

mkdir -p "$T/repo/hub" "$T/repo/clients"; echo x > "$T/repo/hub/a.ts"; echo x > "$T/repo/clients/b.ts"; c3=$(commit new-dirs)
deploy --if-new >/dev/null
check "hub/ and clients/ commit: no restart" "$(live) $(restarts)" "$c1 1"

echo b > "$T/repo/core/main.ts"; c4=$(commit core-change)
deploy --if-new >/dev/null
check "core change goes live" "$(live) $(restarts)" "$c4 2"

deploy --ref "$c1" >/dev/null
check "--ref rolls back to an older core" "$(live) $(restarts)" "$c1 3"
deploy --ref "$c2" >/dev/null || true
check "--ref to a commit with the live core is a no-op" "$(live) $(restarts)" "$c1 3"
deploy --ref "$c2" --force >/dev/null
check "--force redeploys anyway" "$(live) $(restarts)" "$c2 4"

# upgrade path: a live release from before this check has no tree file; it is taken from git
deploy >/dev/null; rm -f "$T/app/current.tree"; prev=$(live)
echo c > "$T/repo/docs/x.md"; c5=$(commit docs-after-upgrade)
deploy --if-new >/dev/null
check "no tree file yet: still no restart for docs" "$(live) $(restarts)" "$prev 5"

# a broken core rolls back; later docs-only commits on top of it don't try again
touch "$T/repo/core/BROKEN"; c6=$(commit broken)
deploy --if-new >/dev/null 2>&1 || true
check "broken core rolls back" "$(live) $(grep -c " $c6 FAILED, rolled back" "$T/app/deploys.log")" "$prev 1"
r=$(restarts)
echo d > "$T/repo/docs/x.md"; c7=$(commit docs-on-broken)
deploy --if-new >/dev/null 2>&1 || true
check "same broken trees are skipped, not retried" "$(live) $(restarts) $(grep -c " $c7 skipped" "$T/app/deploys.log")" "$prev $r 1"
rm "$T/repo/core/BROKEN"; echo c > "$T/repo/core/main.ts"; c8=$(commit fixed)
deploy --if-new >/dev/null
check "fixed core goes live" "$(live)" "$c8"

[ "$fail" = 0 ] || { cat "$T/out"; cat "$T/app/deploys.log"; }
exit $fail
