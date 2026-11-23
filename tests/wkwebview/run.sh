#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
out="${WK_RESULTS:-$root/artifacts/webkit}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
device=""
cleanup() {
  if [[ -n "$device" ]]; then
    xcrun simctl shutdown "$device" >/dev/null 2>&1 || true
    xcrun simctl delete "$device" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

app="$work/PocketEditorWebKitTest.app"
mkdir "$app"
python3 pocket-editor/bundle.py web "$app/index.html"
cp tests/wkwebview/Smoke.js "$app/Smoke.js"
cp pocket-editor/Info.plist "$app/Info.plist"
display_name="$(plutil -extract CFBundleDisplayName raw "$app/Info.plist")"
release_id="$(plutil -extract CFBundleIdentifier raw "$app/Info.plist")"
executable="$(plutil -extract CFBundleExecutable raw "$app/Info.plist")"
[[ "$display_name" == "SwiDe" && "$release_id" == "cz.vozentiq.xcodepocket.editor" ]]
echo "Verified release bundle: $display_name ($release_id)"
bundle_id="$release_id.webkittest"
plutil -replace CFBundleIdentifier -string "$bundle_id" "$app/Info.plist"
plutil -replace CFBundleSupportedPlatforms.0 -string iPhoneSimulator "$app/Info.plist"
plutil -remove UIRequiredDeviceCapabilities "$app/Info.plist"
sdk_path="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="$(uname -m)"
xcrun --sdk iphonesimulator clang -target "$arch-apple-ios17.0-simulator" -isysroot "$sdk_path" \
   -fobjc-arc -fmodules -Os pocket-editor/Editor.m tests/wkwebview/SmokeObserver.m \
   -framework UIKit -framework WebKit -framework Foundation -framework UniformTypeIdentifiers -o "$app/$executable"
codesign --force --sign - --timestamp=none "$app"

selection="$(python3 - <<'PY'
import json, sys
sys.path.insert(0, "native-build/original-xcode")
from run_simulator import choose, command
print(*choose(json.loads(command(["xcrun", "simctl", "list", "--json"]).stdout)))
PY
)"
read -r runtime device_type <<< "$selection"
device="$(xcrun simctl create Pocket-webkit-regression "$device_type" "$runtime")"
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$app"
container="$(xcrun simctl get_app_container "$device" "$bundle_id" data)"
xcrun simctl launch "$device" "$bundle_id"
for ((i=0;i<120;i++)); do
  [[ ! -f "$container/Documents/webkit-smoke.json" ]] || break
  sleep 1
done
xcrun simctl io "$device" screenshot "$out/editor.png"
if [[ ! -f "$container/Documents/webkit-smoke.json" ]]; then
  echo "Timed out while waiting for the simulator test application." >&2
  exit 1
fi
cp "$container/Documents/webkit-smoke.json" "$out/result.json"
python3 - "$out/result.json" <<'PY'
import json, sys
from pathlib import Path
result = json.loads(Path(sys.argv[1]).read_text())
print(json.dumps(result, ensure_ascii=False, indent=2))
if (result.get("passed") is not True or result.get("engine") != "WKWebView" or result.get("editorName") != "SwiDe"
        or result.get("origin") != "file:" or result.get("requests") != 1
        or result.get("tokenPersisted") is not False):
    sys.exit("Native WKWebView regression failed.")
PY
