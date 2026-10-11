#!/usr/bin/env bash
# Step 1 of the GitHub App Manifest flow: writes an auto-submitting HTML form for <manifest.json>
# and opens it. You must be signed in to github.com as an owner of the KernelSU-Modules org.
#   docs/setup/apps/create-app.sh docs/setup/apps/kernelsu-modules.manifest.json
set -euo pipefail
manifest=${1:?usage: create-app.sh <manifest.json>}
org=${ORG:-KernelSU-Modules}
state=$(openssl rand -hex 16)
out=$(mktemp -d)/create-app.html
python3 - "$manifest" "$org" "$state" "$out" <<'PY'
import html, json, sys
manifest, org, state, out = sys.argv[1:]
m = json.load(open(manifest))
action = f"https://github.com/organizations/{org}/settings/apps/new?state={state}"
open(out, "w").write(f"""<!doctype html><meta charset="utf-8"><title>Create {html.escape(m['name'])}</title>
<form id="f" method="post" action="{html.escape(action)}">
<input type="hidden" name="manifest" value="{html.escape(json.dumps(m))}">
<p>Creating <b>{html.escape(m['name'])}</b> in <b>{html.escape(org)}</b>…</p>
<button type="submit">Continue on GitHub</button></form>
<script>document.getElementById('f').submit()</script>""")
PY
echo "state=$state  (the redirect URL must carry the same state)"
echo "form: $out"
(xdg-open "$out" || open "$out") >/dev/null 2>&1 || echo "Open the file above in your browser."
echo
echo "After 'Create GitHub App', the browser goes to http://localhost:8976/created?code=...&state=..."
echo "(the page will not load — that is fine). Copy the code and run within 1 hour:"
echo "  docs/setup/apps/convert.sh <code> <secure-output-dir>"
