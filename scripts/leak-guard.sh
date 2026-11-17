#!/bin/bash
# Fails if a tracked file looks like it carries instance data or a credential. Runs in CI on every PR.
# The repo is public: IDs, hostnames, keys and personal data belong in /srv/sbot/config and secrets.env on the server.
#   bash scripts/leak-guard.sh
set -uo pipefail
cd "$(dirname "$0")/.."
pat='ou_[0-9a-f]{20,}|oc_[0-9a-f]{20,}|om_[0-9a-f]{20,}|on_[0-9a-f]{20,}|cli_[0-9a-f]{12,}'      # Feishu ids
pat+='|[a-z0-9-]+\.[a-z0-9-]+\.ts\.net'                                                        # tailnet hostnames
pat+='|-----BEGIN [A-Z ]*PRIVATE KEY'
pat+='|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}'                                          # model API keys
pat+='|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'                               # GitHub tokens
pat+='|AKIA[0-9A-Z]{16}'
pat+='|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'                                         # email addresses
allow='noreply@anthropic\.com|sbot@localhost|@[a-z-]+/|git@github\.com'
hits=$(git ls-files -z | grep -zv '^scripts/leak-guard\.sh$' | xargs -0 grep -nIEo "$pat" 2>/dev/null | grep -vE "$allow")
if [ -n "$hits" ]; then
  echo "leak-guard: these look like instance data or credentials; move them to config/secrets on the server:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "leak-guard: clean"
