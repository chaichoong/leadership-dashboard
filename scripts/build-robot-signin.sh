#!/bin/bash
# Build "Robot sign-in.app" on Kevin's Desktop from scripts/robot-signin.applescript and
# register the robotsignin:// URL scheme, so a link on the approval card or in the morning
# message opens it (robotsignin://all, robotsignin://site/<host>). Run after any edit to the
# AppleScript. Idempotent.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$HOME/Desktop/Robot sign-in.app}"
osacompile -o "$APP" "$REPO/scripts/robot-signin.applescript"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string com.kevinbrittain.robot-signin" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string robotsignin" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.kevinbrittain.robot-signin" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.kevinbrittain.robot-signin" "$PLIST"
# Seal the bundle again (28 Sep 2026). osacompile signs the app ad hoc and the plist edits above
# break that seal, so macOS refused every notification from the app ("Failed to validate
# application ... -67030" in the Mac's log): "Checking…" and "Signed in" never showed, and a
# frozen app gave Kevin no sign it was working. A seal that does not verify stops the build.
# The Desktop copy carries Finder and iCloud attributes, which codesign refuses ("resource fork,
# Finder information, or similar detritus not allowed"): clear them first (found in review).
xattr -cr "$APP"
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"
# Tell Launch Services about the scheme (the registration is what makes the link work).
# ROBOT_SIGNIN_NO_REGISTER=1 builds a copy that never claims the link (the test's build).
if [ -z "${ROBOT_SIGNIN_NO_REGISTER:-}" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
fi
echo "built $APP with URL scheme robotsignin://"
