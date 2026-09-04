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
# Tell Launch Services about the scheme (the registration is what makes the link work).
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "built $APP with URL scheme robotsignin://"
