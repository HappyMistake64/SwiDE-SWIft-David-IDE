#!/usr/bin/env bash
# Capture one frame of the generated PocketApp on an isolated iPhone simulator.
set -euo pipefail
: "${REQUEST_ID:?}" "${BUNDLE_ID:?}"
mkdir -p artifacts/preview

device=""
cleanup() {
  if [[ -n "$device" ]]; then
    xcrun simctl shutdown "$device" >/dev/null 2>&1 || true
    xcrun simctl delete "$device" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Share runtime/device compatibility selection with original-project previews.
selection=$(python3 - <<'PY'
import json
import sys
sys.path.insert(0, 'native-build/original-xcode')
from run_simulator import choose, command
runtime, device_type = choose(json.loads(command(['xcrun', 'simctl', 'list', '--json']).stdout))
print(runtime, device_type)
PY
)
read -r runtime device_type <<< "$selection"
device=$(xcrun simctl create "Pocket-preview-$REQUEST_ID" "$device_type" "$runtime")
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b

xcodebuild -project build-project/PocketApp.xcodeproj -scheme PocketApp \
  -configuration Debug -sdk iphonesimulator -destination "id=$device" \
  -derivedDataPath build-preview -disableAutomaticPackageResolution -skipPackageUpdates \
  CODE_SIGNING_ALLOWED=NO build
app=build-preview/Build/Products/Debug-iphonesimulator/PocketApp.app
actual_bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
[[ "$actual_bundle" == "$BUNDLE_ID" ]]
xcrun simctl install "$device" "$app"
launch=$(xcrun simctl launch "$device" "$BUNDLE_ID")
echo "$launch"
pid=${launch##*: }
[[ "${launch%: *}" == "$BUNDLE_ID" && "$pid" =~ ^[1-9][0-9]*$ ]]
sleep 3
# Simulator processes run on the host. Reject a screenshot if the app exited.
kill -0 "$pid"
xcrun simctl io "$device" screenshot artifacts/preview/screenshot.png
kill -0 "$pid"
python3 - <<'PY'
from pathlib import Path
import struct
image = Path('artifacts/preview/screenshot.png').read_bytes()
if (len(image) < 33 or image[:8] != b'\x89PNG\r\n\x1a\n' or image[12:16] != b'IHDR'
        or min(struct.unpack('>II', image[16:24])) < 1):
    raise SystemExit('Simulator did not produce a valid PNG screenshot.')
PY
