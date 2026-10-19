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
APPS="com.android.settings com.android.chrome com.google.android.deskclock"

front() {
  echo "  resumed: $(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')"
  echo "  focus:   $(adb shell dumpsys window | grep -m1 mCurrentFocus | sed 's/^ *//')"
}

shot() { adb exec-out screencap -p > "$OUT/$1.png"; }

AM_FIRE="am start -a app.murmur.android.action.TOGGLE_DICTATION -n $TRAMPOLINE -f $SHORTCUT_FLAGS"
fire() { adb shell "$AM_FIRE" >/dev/null; }
# Two launches 150 ms apart from inside the device, the way a back tap double-fires.
double_fire() { adb shell "$AM_FIRE >/dev/null & sleep 0.15; $AM_FIRE >/dev/null; wait"; }

# Whether a dictation is running: the microphone foreground service is up.
listening() { adb shell dumpsys activity services $PKG | grep -q 'RecordingService' && echo yes || echo no; }
expect_listening() {
  local now; now=$(listening)
  if [ "$now" = "$1" ]; then echo "  dictation running: $now (as expected)"; else echo "  dictation running: $now (EXPECTED $1)"; fi
}
ensure_idle() { if [ "$(listening)" = yes ]; then fire; sleep 4; fi; }

open_their_app() {
  local cmp
  cmp=$(adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "$1" | tail -1 | tr -d '\r')
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n "$cmp" >/dev/null
  sleep 5
}

pass_or_fail() {
  if adb shell dumpsys window | grep -m1 mCurrentFocus | grep -q "$1"; then echo "  RESULT: PASS ($1 still in front)"; else echo "  RESULT: FAIL ($1 is no longer in front)"; fi
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
  adb shell settings delete secure enabled_accessibility_services >/dev/null
  sleep 2
  adb shell settings put secure enabled_accessibility_services $PKG/$PKG.service.MurmurAccessibilityService
  adb shell settings put secure accessibility_enabled 1
  for _ in $(seq 1 20); do adb shell pidof $PKG >/dev/null && break; sleep 1; done
  sleep 3
  echo "accessibility bound: $(adb shell dumpsys accessibility | grep -c 'app.murmur.android') mentions, murmur pid $(adb shell pidof $PKG)"

  adb logcat -c
  # Chrome's first run shows a welcome screen; get it out of the way once.
  adb shell am set-debug-app --persistent com.android.chrome >/dev/null 2>&1
  adb shell 'echo "chrome --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
  for app in $APPS; do
    adb shell pm path "$app" >/dev/null 2>&1 || { echo "--- $app not on this image, skipped"; continue; }
    short=${app##*.}
    echo "--- $app: one app action (start)"
    ensure_idle
    open_their_app "$app"
    echo " before:"; front; expect_listening no; shot "$label-$short-1-before"
    fire; sleep 4
    echo " after start:"; front; pass_or_fail "$app"; expect_listening yes; shot "$label-$short-2-after-start"
    fire; sleep 4
    echo " after stop:"; front; pass_or_fail "$app"; expect_listening no; shot "$label-$short-3-after-stop"
    echo "--- $app: double-firing back tap (two launches 150 ms apart)"
    ensure_idle
    open_their_app "$app"
    double_fire; sleep 4
    echo " after:"; front; pass_or_fail "$app"; expect_listening yes; shot "$label-$short-4-after-double"
    ensure_idle
  done
  adb logcat -d | grep -E 'Background activity|ActivityTaskManager: START|Start proc .*murmur|WINDOW_STATE|AndroidRuntime' > "$OUT/$label-logcat.txt"
  echo " logcat: $(wc -l < "$OUT/$label-logcat.txt") lines kept"
}

for pair in "$@"; do
  run_build "${pair%%=*}" "${pair#*=}"
done 2>&1 | tee "$OUT/summary.txt"
