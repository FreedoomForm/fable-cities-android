#!/bin/bash
# Run the JVM golden parity tests locally (JUnit 4 console runner).
set -e
cd "$(dirname "$0")/.."
# the junitstub's org.junit.* classes shadow the real jar on the classpath - purge them
rm -rf /tmp/kout/org/junit /tmp/kout/org/hamcrest
CLS=/tmp/kout:/tmp/junit-4.13.2.jar:/tmp/hamcrest-core-1.3.jar:/tmp/kotlinc/lib/kotlin-stdlib.jar
if [ $# -gt 0 ]; then
  TESTS="$@"
else
  # derive FQCN from the package declaration (some files live in worldgen/ but declare the root package)
TESTS=$(for f in $(find android/app/src/test/java -name "*Test.kt"); do
  pkg=$(grep -m1 '^package' "$f" | sed 's/package //; s/[^a-zA-Z0-9_.].*//')
  echo "$pkg.$(basename "$f" .kt)"
done)
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
