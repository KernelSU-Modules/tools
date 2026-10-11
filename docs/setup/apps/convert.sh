#!/usr/bin/env bash
# Step 3 of the GitHub App Manifest flow: exchange the one-time code for the App credentials.
# Writes app.json (id, slug, client_id, client_secret, webhook_secret) and private-key.pem (PKCS#1,
# use as-is) into <out-dir> with 0600 permissions. Store them in the org password manager, then
# delete the directory.
set -euo pipefail
code=${1:?usage: convert.sh <code> <out-dir>}
dir=${2:?usage: convert.sh <code> <out-dir>}
umask 077
mkdir -p "$dir"
gh api -X POST "/app-manifests/$code/conversions" > "$dir/conversion.json"
python3 - "$dir" <<'PY'
import json, os, sys
d = sys.argv[1]
c = json.load(open(os.path.join(d, "conversion.json")))
open(os.path.join(d, "private-key.pem"), "w").write(c["pem"])
keep = {k: c.get(k) for k in ("id", "slug", "name", "client_id", "client_secret", "webhook_secret", "html_url")}
json.dump(keep, open(os.path.join(d, "app.json"), "w"), indent=2)
os.remove(os.path.join(d, "conversion.json"))
print(f"App {keep['slug']} id={keep['id']} client_id={keep['client_id']} -> {d}/app.json, {d}/private-key.pem")
PY
