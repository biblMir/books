#!/usr/bin/env python3
"""Pin GitHub SSH host keys only when they match GitHub's HTTPS metadata."""

import json
import subprocess
import urllib.request

KNOWN_HOSTS = "/var/lib/books/.ssh/known_hosts"

with urllib.request.urlopen("https://api.github.com/meta", timeout=10) as response:
    official = json.load(response)
expected = {tuple(key.split()[:2]) for key in official["ssh_keys"]}
scan = subprocess.run(
    ["ssh-keyscan", "-T", "8", "-t", "rsa,ecdsa,ed25519", "github.com"],
    check=True,
    capture_output=True,
    text=True,
    timeout=12,
)
matches = []
for line in scan.stdout.splitlines():
    parts = line.split()
    if len(parts) >= 3 and tuple(parts[1:3]) in expected:
        matches.append(f"github.com {parts[1]} {parts[2]}\n")
if not matches:
    raise SystemExit("Could not verify a GitHub SSH host key against HTTPS metadata.")
with open(KNOWN_HOSTS, "w", encoding="ascii") as output:
    output.writelines(matches)
print("GitHub SSH host key verified against HTTPS metadata.")
