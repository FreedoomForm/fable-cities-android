#!/bin/bash
# Local kotlinc type-check of the whole app + tests + android stubs (no SDK needed).
# Usage: tools/localcheck.sh  (expects kotlinc at /tmp/kotlinc/bin/kotlinc)
set -e
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$SELF_DIR")"
rm -rf /tmp/kout && mkdir -p /tmp/kout
/tmp/kotlinc/bin/kotlinc -nowarn \
  $(find $SELF_DIR/kotlinc-stubs $SELF_DIR/junitstub -name '*.kt') \
  $(find $REPO/android/app/src/main/java/com/fablecities/android $REPO/android/app/src/test/java/com/fablecities/android -name '*.kt') \
  -d /tmp/kout 2>&1 | grep -E "error:" | head -50
echo "CHECK DONE"
