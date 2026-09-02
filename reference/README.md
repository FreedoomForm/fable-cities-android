# Reference frames (not included)

The critic agents in this project score every module against real *Cities: Skylines II*
screenshots on a written 0–10 scale. Those twelve reference images are **deliberately not
committed**: they are official Colossal Order / Paradox Interactive press screenshots and
are their copyright. They were used locally for comparison only, which is critique, not
redistribution.

## Reproducing them

The images came from the official Steam store listing, base game appid `949230`:

```bash
curl -s "https://store.steampowered.com/api/appdetails?appids=949230" \
  | python3 -c "import json,sys;[print(s['path_full']) for s in json.load(sys.stdin)['949230']['data']['screenshots']]"
```

Save twelve of them here as `cs2_01.jpg` … `cs2_12.jpg`, picking a spread of daytime
aerial, street level, night downtown, suburbs, waterfront, highway and industrial. The
critic and judge prompts reference these filenames.

Any set of comparable city-builder frames works — the method does not depend on this
particular game, only on having a fixed, high-quality bar to score against.
