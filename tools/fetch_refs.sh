#!/usr/bin/env bash
# Re-fetch the 12 CS2 reference screenshots (cs2_01..cs2_12) into reference/
# See reference/README.md — Steam store appid 949230.
set -e
cd /home/z/fable-cities-android
mkdir -p reference
curl -s "https://store.steampowered.com/api/appdetails?appids=949230&l=english" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)['949230']['data']
for i,s in enumerate(d['screenshots'][:12],1):
    print(i, s['path_full'])
" > /tmp/cs2_urls.txt
cat /tmp/cs2_urls.txt
i=1
while read -r n url; do
  out="reference/cs2_$(printf '%02d' "$n").jpg"
  [ -s "$out" ] || curl -sL "$url" -o "$out"
  i=$((i+1))
done < /tmp/cs2_urls.txt
ls -la reference/
