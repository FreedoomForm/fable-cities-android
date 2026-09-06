package com.fablecities.android.worldgen

import kotlin.math.floor

/**
 * Seeded 2D/3D simplex noise + fBm helpers (Gustavson's public-domain algorithm) —
 * a bit-exact Kotlin port of the web game's src/shared/noise.js. All math is Double
 * (JS numbers), the permutation table is built with the same mulberry32 Fisher-Yates,
 * and the same GRAD3 table is used, so noise2D(x, y) returns the exact same value as
 * the browser for the same seed.
 */
class SimplexNoise(seed: Int) {

    private val perm = IntArray(512)
    private val permMod12 = IntArray(512)

    init {
        val rng = Rng(seed)
        val p = IntArray(256)
        for (i in 0 until 256) p[i] = i
        for (i in 255 downTo 1) {
            val j = floor(rng.next() * (i + 1)).toInt()
            val t = p[i]
            p[i] = p[j]
            p[j] = t
        }
        for (i in 0 until 512) {
            perm[i] = p[i and 255]
            permMod12[i] = perm[i] % 12
        }
    }

    fun noise2D(xin: Double, yin: Double): Double {
        val F2 = 0.5 * (SQRT3 - 1.0)
        val G2 = (3.0 - SQRT3) / 6.0
        var n0 = 0.0
        var n1 = 0.0
        var n2 = 0.0
        val s = (xin + yin) * F2
        val i = floor(xin + s).toInt()
        val j = floor(yin + s).toInt()
        val t = (i + j) * G2
        val x0 = xin - (i - t)
        val y0 = yin - (j - t)
        val i1: Int
        val j1: Int
        if (x0 > y0) { i1 = 1; j1 = 0 } else { i1 = 0; j1 = 1 }
        val x1 = x0 - i1 + G2
        val y1 = y0 - j1 + G2
        val x2 = x0 - 1.0 + 2.0 * G2
        val y2 = y0 - 1.0 + 2.0 * G2
        val ii = i and 255
        val jj = j and 255
        var t0 = 0.5 - x0 * x0 - y0 * y0
        if (t0 >= 0) {
            val gi0 = permMod12[ii + perm[jj]] * 3
            t0 *= t0
            n0 = t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0)
        }
        var t1 = 0.5 - x1 * x1 - y1 * y1
        if (t1 >= 0) {
            val gi1 = permMod12[ii + i1 + perm[jj + j1]] * 3
            t1 *= t1
            n1 = t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1)
        }
        var t2 = 0.5 - x2 * x2 - y2 * y2
        if (t2 >= 0) {
            val gi2 = permMod12[ii + 1 + perm[jj + 1]] * 3
            t2 *= t2
            n2 = t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2)
        }
        return 70.0 * (n0 + n1 + n2)
    }

    fun noise3D(xin: Double, yin: Double, zin: Double): Double {
        val F3 = 1.0 / 3.0
        val G3 = 1.0 / 6.0
        val s = (xin + yin + zin) * F3
        val i = floor(xin + s).toInt()
        val j = floor(yin + s).toInt()
        val k = floor(zin + s).toInt()
        val t = (i + j + k) * G3
        val x0 = xin - (i - t)
        val y0 = yin - (j - t)
        val z0 = zin - (k - t)
        val i1: Int; val j1: Int; val k1: Int
        val i2: Int; val j2: Int; val k2: Int
        if (x0 >= y0) {
            if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
            else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1 }
            else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1 }
        } else {
            if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1 }
            else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1 }
            else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
        }
        val x1 = x0 - i1 + G3; val y1 = y0 - j1 + G3; val z1 = z0 - k1 + G3
        val x2 = x0 - i2 + 2.0 * G3; val y2 = y0 - j2 + 2.0 * G3; val z2 = z0 - k2 + 2.0 * G3
        val x3 = x0 - 1.0 + 3.0 * G3; val y3 = y0 - 1.0 + 3.0 * G3; val z3 = z0 - 1.0 + 3.0 * G3
        val ii = i and 255
        val jj = j and 255
        val kk = k and 255
        var n0 = 0.0; var n1 = 0.0; var n2 = 0.0; var n3 = 0.0
        var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0
        if (t0 >= 0) {
            val g = permMod12[ii + perm[jj + perm[kk]]] * 3
            t0 *= t0
            n0 = t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0)
        }
        var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1
        if (t1 >= 0) {
            val g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3
            t1 *= t1
            n1 = t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1)
        }
        var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2
        if (t2 >= 0) {
            val g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3
            t2 *= t2
            n2 = t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2)
        }
        var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3
        if (t3 >= 0) {
            val g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3
            t3 *= t3
            n3 = t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3)
        }
        return 32.0 * (n0 + n1 + n2 + n3)
    }

    /** Fractal Brownian motion in [-1, 1]. */
    fun fbm2D(x: Double, y: Double, octaves: Int = 5, lacunarity: Double = 2.0, gain: Double = 0.5): Double {
        var amp = 0.5
        var freq = 1.0
        var sum = 0.0
        var norm = 0.0
        for (o in 0 until octaves) {
            sum += amp * noise2D(x * freq, y * freq)
            norm += amp
            amp *= gain
            freq *= lacunarity
        }
        return sum / norm
    }

    /** Ridged multifractal, good for mountains. Returns [0, 1]. */
    fun ridged2D(x: Double, y: Double, octaves: Int = 5, lacunarity: Double = 2.0, gain: Double = 0.5): Double {
        var amp = 0.5
        var freq = 1.0
        var sum = 0.0
        var norm = 0.0
        for (o in 0 until octaves) {
            var n = 1.0 - Math.abs(noise2D(x * freq, y * freq))
            n *= n
            sum += amp * n
            norm += amp
            amp *= gain
            freq *= lacunarity
        }
        return sum / norm
    }

    private companion object {
        const val SQRT3 = 1.7320508075688772 // Math.sqrt(3)
        val GRAD3 = doubleArrayOf(
            1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0,
            1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, -1.0, 0.0, -1.0,
            0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0,
        )
    }
}
