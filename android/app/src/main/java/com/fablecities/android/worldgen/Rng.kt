package com.fablecities.android.worldgen

import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.sqrt

/**
 * Deterministic PRNG (mulberry32) — a bit-exact Kotlin port of the web game's
 * src/shared/random.js. World generation must produce the SAME world as the browser
 * game for the same seed, so the integer wrap-around semantics of JavaScript's
 * Math.imul / |0 / >>> 0 are reproduced with Kotlin Int arithmetic (two's-complement
 * 32-bit wrap, identical bits).
 */
class Rng(private val seed: Int) {
    private var a: Int = if (seed == 0) 1 else seed

    /** Next uniform in [0, 1). */
    fun next(): Double {
        a += 0x6d2b79f5 // Int overflow wraps exactly like JS (a + 0x6d2b79f5) | 0
        var t: Int = (a xor a.ushr(15)) * (1 or a) // Int overflow = Math.imul
        t = (t + (t xor t.ushr(7)) * (61 or t)) xor t
        return ((t xor t.ushr(14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
    }

    fun range(min: Double, max: Double): Double = min + (max - min) * next()
    fun int(min: Int, max: Int): Int = floor(range(min.toDouble(), (max + 1).toDouble())).toInt()
    fun chance(p: Double): Boolean = next() < p

    fun gaussian(): Double {
        var u = 0.0
        var v = 0.0
        while (u == 0.0) u = next()
        while (v == 0.0) v = next()
        return sqrt(-2.0 * ln(u)) * cos(2.0 * Math.PI * v)
    }

    fun fork(salt: Int): Rng = Rng(hash2Signed(seed, salt))
}

/** Bit-exact port of hash2() — returns the raw Int32 bit pattern of the JS unsigned result. */
fun hash2Signed(a: Int, b: Int): Int {
    var h = a xor 0x9e3779b9.toInt()
    h = (h xor b) * 0x85ebca6b.toInt() // Math.imul(h ^ b, 0x85ebca6b)
    h = h xor (h ushr 13)
    h *= 0xc2b2ae35.toInt() // Math.imul(h, 0xc2b2ae35)
    h = h xor (h ushr 16)
    return h
}

/** Unsigned value of hash2 as a Long (matches the JS `>>> 0` number) — for tests. */
fun hash2Unsigned(a: Int, b: Int): Long = hash2Signed(a, b).toLong() and 0xFFFFFFFFL
