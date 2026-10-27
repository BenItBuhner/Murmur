"""Reads a uiautomator dump: `field.py text` prints the focused EditText's text, `field.py
center` its centre, `field.py button LABEL` the centre of the first node whose text is LABEL."""
import re
import sys
import xml.etree.ElementTree as ET

root = ET.parse("/tmp/ui.xml").getroot()


def center(node):
    a, b, c, d = map(int, re.findall(r"\d+", node.get("bounds")))
    return f"{(a + c) // 2} {(b + d) // 2}"


nodes = list(root.iter("node"))
if sys.argv[1] == "button":
    label = sys.argv[2]
    for n in nodes:
        if (n.get("text") or "").strip().lower() == label.lower() or (n.get("content-desc") or "").lower() == label.lower():
            print(center(n))
            break
    sys.exit(0)
fields = [n for n in nodes if n.get("class") == "android.widget.EditText"]
if not fields:
    sys.exit(1)
f = next((n for n in fields if n.get("focused") == "true"), fields[0])
print(f.get("text") or "" if sys.argv[1] == "text" else center(f))
