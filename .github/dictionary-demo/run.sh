#!/usr/bin/env bash
# Emulator demo of learning dictionary words from corrections: dictate into a text area in
# Chrome (the speech model is stt_mock.py, the audio Murmur's bundled fixture clip), correct a
# mis-heard word the way a person would (select it, type over it), and record what Murmur does.
set -u
OUT=${OUT:-demo}
APK=$1
mkdir -p "$OUT"
PKG=app.murmur.android
HERE=$(cd "$(dirname "$0")" && pwd)
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$OUT/steps.txt"; }

shot() { sleep 0.5; adb exec-out screencap -p > "$OUT/$1.png"; log "screenshot $1"; }
dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb pull /sdcard/ui.xml /tmp/ui.xml >/dev/null 2>&1; }
field_text() { dump; python3 "$HERE/field.py" text; }
say() { printf '%s' "$1" > /tmp/next.txt; }
SHORTCUT_FLAGS=0x1000C000
dictate() {
  say "$1"
  log "dictating (the speech model will hear): $1"
  adb shell am start -a app.murmur.android.action.START_DICTATION -n $PKG/.entry.DictationEntryActivity -f $SHORTCUT_FLAGS >/dev/null
  sleep 3
  adb shell am start -a app.murmur.android.action.STOP_DICTATION -n $PKG/.entry.DictationEntryActivity -f $SHORTCUT_FLAGS >/dev/null
  sleep 6
  log "field now: $(field_text)"
}
key() { adb shell input keyevent "$@"; }
combo() { adb shell input keycombination "$@"; }

# Select `old` (its last occurrence in the field) with Shift+Left and type `new` over it.
correct() {
  local old=$1 new=$2 text pos len left
  text=$(field_text)
  pos=$(python3 -c 'import sys; t,o=sys.argv[1],sys.argv[2]; print(t.rfind(o))' "$text" "$old")
  if [ "$pos" -lt 0 ]; then log "!! '$old' not in the field"; return 1; fi
  len=${#text}
  left=$(( len - pos - ${#old} ))
  log "correcting '$old' -> '$new' (select it, type over it)"
  combo KEYCODE_CTRL_LEFT KEYCODE_MOVE_END
  for _ in $(seq 1 $left); do key KEYCODE_DPAD_LEFT; done
  for _ in $(seq 1 ${#old}); do combo KEYCODE_SHIFT_LEFT KEYCODE_DPAD_LEFT; done
  adb shell input text "${new// /%s}"
  sleep 1
  log "field now: $(field_text)"
}

notifications() {
  adb shell cmd statusbar expand-notifications; sleep 2
  dump
  python3 - <<'PY' | tee -a "$OUT/steps.txt"
import xml.etree.ElementTree as ET
r = ET.parse("/tmp/ui.xml").getroot()
texts = [n.get("text") for n in r.iter("node") if n.get("text")]
hits = [t for t in texts if "dictionary" in t.lower() or "heard" in t.lower() or "changed" in t.lower()]
print("   notification shade:", hits if hits else "no dictionary suggestion")
PY
}

# ---- install and configure ---------------------------------------------------------------
adb shell settings put global hide_error_dialogs 1
adb install -r -g "$APK" | tail -1
adb shell pm grant $PKG android.permission.RECORD_AUDIO
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS
adb shell "run-as $PKG sh -c 'mkdir -p shared_prefs && cat > shared_prefs/murmur_settings.xml'" <<'XML'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <boolean name="onboardingComplete" value="true" />
    <boolean name="allowExternalTriggers" value="true" />
    <boolean name="useFixtureAudio" value="true" />
    <boolean name="sounds" value="false" />
    <string name="sttSource">custom</string>
    <string name="llmSource">custom</string>
    <string name="sttKind">openai-compatible</string>
    <string name="sttBaseUrl">http://10.0.2.2:8000/v1</string>
    <string name="sttModel">whisper-1</string>
    <string name="formattingMode">light</string>
</map>
XML
adb shell settings put secure enabled_accessibility_services $PKG/$PKG.service.MurmurAccessibilityService
adb shell settings put secure accessibility_enabled 1
for _ in $(seq 1 20); do adb shell pidof $PKG >/dev/null && break; sleep 1; done
sleep 3
log "accessibility service bound: $(adb shell dumpsys accessibility | grep -c 'app.murmur.android') mentions"

adb shell am set-debug-app --persistent com.android.chrome >/dev/null 2>&1
adb shell 'echo "chrome --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
adb shell am start -a android.intent.action.VIEW -d http://10.0.2.2:8000/pad com.android.chrome >/dev/null
sleep 8
dump; xy=$(python3 "$HERE/field.py" center) && adb shell input tap $xy
sleep 2
adb logcat -c
adb shell screenrecord --bit-rate 4000000 --time-limit 170 /sdcard/demo.mp4 &
REC=$!
sleep 1

# ---- 1. a mis-heard product name, corrected: Murmur offers it --------------------------
log "=== 1. Correct a mis-heard name"
dictate "I use whisper flow every day and it saves me hours."
shot 1-dictated
correct "whisper flow" "Wispr Flow"
shot 2-corrected
sleep 6
notifications
shot 3-notification
xy=$(python3 "$HERE/field.py" button Add) && { log "tapping Add on the notification"; adb shell input tap $xy; }
sleep 2
adb shell cmd statusbar collapse; sleep 1

# ---- 2. the learned spelling is used next time ------------------------------------------
log "=== 2. Dictate the same thing again"
key KEYCODE_ENTER
dictate "Trying whisper flow again tomorrow."
shot 4-learned

# ---- 3. the user changes their mind: Murmur stays quiet ---------------------------------
log "=== 3. Change a word (not a mis-hearing)"
key KEYCODE_ENTER
dictate "Send the report on Tuesday."
correct "Tuesday" "Wednesday"
sleep 12
notifications
shot 5-changed-mind
adb shell cmd statusbar collapse; sleep 1

# ---- 4. an everyday-word fix: quiet too --------------------------------------------------
log "=== 4. Fix an everyday word"
key KEYCODE_ENTER
dictate "This will effect the timeline."
correct "effect" "affect"
sleep 12
notifications
shot 6-everyday-word
adb shell cmd statusbar collapse; sleep 1

# ---- 5. the dictionary --------------------------------------------------------------------
log "=== 5. Murmur's Dictionary screen"
adb shell am start -n $PKG/.MainActivity --es app.murmur.android.ROUTE DICTIONARY >/dev/null
sleep 4
shot 7-dictionary

kill -INT $REC 2>/dev/null; sleep 3
adb pull /sdcard/demo.mp4 "$OUT/demo.mp4" >/dev/null 2>&1
adb logcat -d | grep -iE 'murmur|suggest|inserted' | grep -v -i 'chatty' | tail -200 > "$OUT/logcat.txt"
log "done"
