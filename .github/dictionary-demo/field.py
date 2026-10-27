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
            sys.exit(0)
    sys.exit(1)
fields = [n for n in nodes if n.get("class") == "android.widget.EditText"]
if not fields:
    sys.exit(1)
# The page's text box, not Chrome's address bar: the biggest field that isn't the URL bar.
def area(n):
    a, b, c, d = map(int, re.findall(r"\d+", n.get("bounds")))
    return (c - a) * (d - b)
page = [n for n in fields if "url_bar" not in (n.get("resource-id") or "")] or fields
f = max(page, key=area)
print(f.get("text") or "" if sys.argv[1] == "text" else center(f))
