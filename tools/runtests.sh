#!/bin/bash
# Run the JVM golden parity tests locally (JUnit 4 console runner).
set -e
cd "$(dirname "$0")/.."
CLS=/tmp/kout:/tmp/junit-4.13.2.jar:/tmp/hamcrest-core-1.3.jar:/home/z/tools/kotlinc/lib/kotlin-stdlib.jar
if [ $# -gt 0 ]; then
  TESTS="$@"
else
  TESTS=$(cd android/app/src/test/java && find . -name "*Test.kt" | sed 's|^\./||; s|\.kt$||; s|/|.|g')
fi
PASS=0; FAIL=0
for T in $TESTS; do
  if OUT=$(timeout 600 java -cp "$CLS" org.junit.runner.JUnitCore "$T" 2>&1); then
    N=$(echo "$OUT" | grep -oP 'OK \(\K[0-9]+(?= tests)' || echo 1)
    PASS=$((PASS+N))
    echo "PASS $T ($N)"
  else
    echo "$OUT" | grep -E "^[0-9]+\)|AssertionError|Exception" | head -4
    FAIL=$((FAIL+1))
    echo "FAIL $T"
  fi
done
echo "== local suite: $PASS passed, $FAIL failed classes =="
