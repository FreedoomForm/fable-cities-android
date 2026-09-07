package com.fablecities.android.worldgen

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Exact bit-level port of V8's Math.hypot fast path for two arguments
 * (src/builtins/math.tq FastMathHypot, the length == 2 branch):
 *
 *     max = max(|x|, |y|); return sqrt((|x|/max)^2 + (|y|/max)^2) * max
 *
 * java.lang.Math.hypot (fdlibm) is ~1 ulp different for ~38 % of inputs, and GroundControl /
 * PuddleField divide by this value downstream, so the native port must use the SAME arithmetic
 * as the browser to stay bit-exact. Verified 200000/200000 against Node's Math.hypot.
 */
fun v8Hypot(x: Double, y: Double): Double {
    val a = abs(x)
    val b = abs(y)
    if (a == Double.POSITIVE_INFINITY || b == Double.POSITIVE_INFINITY) return Double.POSITIVE_INFINITY
    val m = max(a, b)
    if (m.isNaN()) return Double.NaN
    if (m == 0.0) return 0.0
    return sqrt((a / m) * (a / m) + (b / m) * (b / m)) * m
}

/**
 * V8's Math.hypot fast path for three arguments (FastMathHypot length == 3 branch): the
 * Kahan-style compensation of the smallest squared term. Used by the world-normal map bake.
 */
fun v8Hypot3(x: Double, y: Double, z: Double): Double {
    val a = abs(x); val b = abs(y); val c = abs(z)
    if (a == Double.POSITIVE_INFINITY || b == Double.POSITIVE_INFINITY || c == Double.POSITIVE_INFINITY) return Double.POSITIVE_INFINITY
    val m = max(max(a, b), c)
    if (m.isNaN()) return Double.NaN
    if (m == 0.0) return 0.0
    val powerA = (a / m) * (a / m)
    val powerB = (b / m) * (b / m)
    val compensation = (powerA + powerB) - powerA - powerB
    val powerC = (c / m) * (c / m) - compensation
    return sqrt(powerA + powerB + powerC) * m
}
