#!/usr/bin/env bash
set -euo pipefail

native_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$native_dir/.." && pwd)"
out_dir="$repo_root/dist"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
app_dir="$work_dir/Payload/XcodePocketEditor.app"
mkdir -p "$app_dir" "$out_dir"

python3 "$native_dir/bundle.py" "$repo_root/web/" "$app_dir/index.html"
test -s "$app_dir/index.html"
cp "$native_dir/Info.plist" "$app_dir/Info.plist"
plutil -lint "$app_dir/Info.plist"
min_ios="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$app_dir/Info.plist")"
if [[ -n "${GITHUB_RUN_NUMBER:-}" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $GITHUB_RUN_NUMBER" "$app_dir/Info.plist"
fi

sdk_path="$(xcrun --sdk iphoneos --show-sdk-path)"
xcrun --sdk iphoneos clang -target "arm64-apple-ios$min_ios" -isysroot "$sdk_path" \
    -fobjc-arc -fmodules -Os "$native_dir/Editor.m" \
    -framework UIKit -framework WebKit -framework Foundation -o "$app_dir/XcodePocketEditor"
xcrun lipo "$app_dir/XcodePocketEditor" -verify_arch arm64

# SideStore replaces this ad hoc signature with the user's development signature.
codesign --force --sign - --timestamp=none "$app_dir"
codesign --verify --strict "$app_dir"

archive="$work_dir/SwiDe.ipa"
(cd "$work_dir" && /usr/bin/zip -qr "$archive" Payload)
/usr/bin/unzip -tq "$archive"
mv "$archive" "$out_dir/SwiDe.ipa"
# Older installation instructions link directly to this release asset.
cp "$out_dir/SwiDe.ipa" "$out_dir/Xcode-Pocket-Editor.ipa"
