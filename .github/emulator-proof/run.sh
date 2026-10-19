#!/usr/bin/env bash
# Fires Murmur's dictation app action over another app on an emulator, the way a static shortcut
# is launched (NEW_TASK | CLEAR_TASK | TASK_ON_HOME, what ShortcutParser puts on every static
# shortcut), and records which app is in front before and after. Runs once per APK given.
set -u
OUT=${OUT:-proof}
mkdir -p "$OUT"
PKG=app.murmur.android
TRAMPOLINE=$PKG/.entry.DictationEntryActivity
SHORTCUT_FLAGS=0x1000C000   # NEW_TASK | CLEAR_TASK | TASK_ON_HOME
THEIR_APP=com.android.settings
THEIR_ACTIVITY=com.android.settings/.Settings

front() {
  echo "  resumed: $(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')"
  echo "  focus:   $(adb shell dumpsys window | grep -m1 mCurrentFocus | sed 's/^ *//')"
}

shot() { adb exec-out screencap -p > "$OUT/$1.png"; }

fire() {
  adb shell am start -a app.murmur.android.action.TOGGLE_DICTATION -n $TRAMPOLINE -f $SHORTCUT_FLAGS >/dev/null
}

open_their_app() {
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n $THEIR_ACTIVITY >/dev/null
  sleep 4
}

run_build() {
  local label=$1 apk=$2
  echo "=================== $label ==================="
  adb uninstall $PKG >/dev/null 2>&1
  adb install -r -g "$apk" | tail -1
  adb shell pm grant $PKG android.permission.RECORD_AUDIO
  # Past onboarding, external triggers allowed (the debug build is debuggable, so run-as works).
  adb shell "run-as $PKG sh -c 'mkdir -p shared_prefs && cat > shared_prefs/murmur_settings.xml'" <<'XML'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <boolean name="onboardingComplete" value="true" />
    <boolean name="allowExternalTriggers" value="true" />
</map>
XML
  adb shell settings put secure enabled_accessibility_services $PKG/$PKG.service.MurmurAccessibilityService
  adb shell settings put secure accessibility_enabled 1
  sleep 5
  echo "accessibility: $(adb shell settings get secure enabled_accessibility_services)"

  adb logcat -c
  echo "--- scenario 1: one app action over $THEIR_APP"
  open_their_app
  echo " before:"; front; shot "$label-1-before"
  fire
  sleep 4
  echo " after:"; front; shot "$label-1-after"
  adb shell dumpsys activity activities | grep -E '^ *\* Task\{|^ *\* Hist|Task id' | head -20 > "$OUT/$label-1-tasks.txt"
  echo "--- scenario 1b: app action again (stops the dictation)"
  fire
  sleep 4
  echo " after stop:"; front; shot "$label-1b-after-stop"

  echo "--- scenario 2: a double-firing back tap (two launches 150 ms apart)"
  open_their_app
  echo " before:"; front
  fire; sleep 0.15; fire
  sleep 4
  echo " after:"; front; shot "$label-2-after-double"
  fire; sleep 3   # stop whatever runs

  adb logcat -d | grep -E 'Background activity|BAL|ActivityTaskManager: START|DictationEntry|Murmur' | grep -v 'chatty' | tail -60 > "$OUT/$label-logcat.txt"
  echo " logcat: $(wc -l < "$OUT/$label-logcat.txt") lines kept"
}

for pair in "$@"; do
  run_build "${pair%%=*}" "${pair#*=}"
done 2>&1 | tee "$OUT/summary.txt"
