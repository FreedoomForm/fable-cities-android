package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Baked celestial textures — a Kotlin port of the web game's environment/StarField.js:
 *
 *  - `buildStarCubeTexture(seed)` — a 6-face cube map holding the Milky Way band (dust lanes,
 *    warm galactic bulge) in the celestial frame (+Y = celestial pole, tilt 62.9°, seeded roll).
 *    rgb = chroma, a = intensity / STAR_ALPHA_SCALE; individual stars are procedural in the shader.
 *  - `buildMoonTexture(seed)` — a 512×256 equirect moon albedo map (highlands, maria, 180 craters
 *    with floors, rims and ejecta shadows, longitude-stretched toward the poles).
 *
 * All deterministic for a seed; JVM-pure so golden tests pin it against the real web module.
 */
object Stars {
    private const val FACE_SIZE = 256

    /** Star intensity stored as alpha; radiance = rgb * alpha * STAR_ALPHA_SCALE in the shader. */
    const val STAR_ALPHA_SCALE = 0.7

    /** ATMOS.moonAngularRadius (rad) — 2.7× life size so the disc reads as a disc, not a dot. */
    const val MOON_ANGULAR_RADIUS = 0.0046 * 2.7

    /** ATMOS.sunAngularRadius (rad) — 1.15× life size. */
    const val SUN_ANGULAR_RADIUS = 0.00465 * 1.15

    const val SUN_DISC_RADIANCE = 5.0

    // --- tiny fixed-size vector helpers (double precision) ---------------------

    private class V3(var x: Double, var y: Double, var z: Double) {
        fun set(x: Double, y: Double, z: Double): V3 { this.x = x; this.y = y; this.z = z; return this }
        fun dot(o: V3) = x * o.x + y * o.y + z * o.z
        fun norm(): Double = sqrt(dot(this))
        fun normalize(): V3 { val l = norm(); if (l > 0) { x /= l; y /= l; z /= l }; return this }
        fun copy(): V3 = V3(x, y, z)
    }

    private fun cross(a: V3, b: V3): V3 = V3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)

    /** three.js applyAxisAngle (Rodrigues rotation around a normalized axis). */
    private fun applyAxisAngle(v: V3, ax: Double, ay: Double, az: Double, angle: Double): V3 {
        val c = cos(angle); val s = sin(angle); val t = 1.0 - c
        val (bx, by, bz) = listOf(ax, ay, az)
        val crossX = by * v.z - bz * v.y
        val crossY = bz * v.x - bx * v.z
        val crossZ = bx * v.y - by * v.x
        val dot = v.x * bx + v.y * by + v.z * bz
        return V3(
            v.x * c + crossX * s + bx * dot * t,
            v.y * c + crossY * s + by * dot * t,
            v.z * c + crossZ * s + bz * dot * t,
        )
    }

    private fun clamp(x: Double, lo: Double, hi: Double) = if (x < lo) lo else if (x > hi) hi else x

    /** three.MathUtils.smoothstep(x, min, max). */
    private fun smoothstep(x: Double, e0: Double, e1: Double): Double {
        val t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
        return t * t * (3.0 - 2.0 * t)
    }

    private fun lerp(a: Double, b: Double, t: Double) = a + (b - a) * t

    // ------------------------------------------------------------------ star cube

    /** Face → direction (WebGL cube map convention; s,t in [-1,1], t grows downwards in the image). */
    private fun faceDir(face: Int, s: Double, t: Double, out: V3): V3 {
        when (face) {
            0 -> out.set(1.0, -t, -s)
            1 -> out.set(-1.0, -t, s)
            2 -> out.set(s, 1.0, t)
            3 -> out.set(s, -1.0, -t)
            4 -> out.set(s, -t, 1.0)
            else -> out.set(-s, -t, -1.0)
        }
        return out
    }

    /**
     * Build the star/Milky Way cube texture (celestial frame: +Y = celestial pole).
     * Returns 6 faces of RGBA bytes, each FACE_SIZE × FACE_SIZE, in WebGL cube-face order
     * (+X, −X, +Y, −Y, +Z, −Z).
     */
    fun buildStarCubeTexture(seed: Int): Array<ByteArray> {
        val rng = Rng(seed xor 0x5741)
        val simplex = SimplexNoise(seed xor 0x9d1)
        val n = FACE_SIZE
        val faces = Array(6) { FloatArray(n * n * 3) }

        // --- galactic frame (tilt ~63° from celestial equator, seeded roll) ---
        val tilt = 62.9 * PI / 180.0
        val roll = rng.next() * PI * 2.0
        var gPole = applyAxisAngle(V3(0.0, cos(tilt), sin(tilt)), 0.0, 1.0, 0.0, roll).normalize()
        var gX = applyAxisAngle(V3(1.0, 0.0, 0.0), 0.0, 1.0, 0.0, roll)
        val dp = gX.dot(gPole)
        gX = V3(gX.x - gPole.x * dp, gX.y - gPole.y * dp, gX.z - gPole.z * dp).normalize()
        val gY = cross(gPole, gX).normalize()

        // --- Milky Way at low resolution, bilinear upsampled ---
        val m = 96
        val mw = ArrayList<FloatArray>()
        val d = V3(0.0, 0.0, 0.0)
        for (f in 0 until 6) {
            val buf = FloatArray(m * m * 3)
            for (j in 0 until m) {
                for (i in 0 until m) {
                    faceDir(f, (2.0 * (i + 0.5)) / m - 1.0, (2.0 * (j + 0.5)) / m - 1.0, d).normalize()
                    val lat = asin(clamp(d.dot(gPole), -1.0, 1.0))
                    val lon = atan2(d.dot(gY), d.dot(gX)) // 0 = galactic centre
                    val bulge = exp(-(lon * lon) / (2.0 * 0.55 * 0.55))
                    val sigma = 0.085 + 0.12 * bulge
                    val band = exp(-(lat * lat) / (2.0 * sigma * sigma))
                    val wide = exp(-(lat * lat) / (2.0 * 0.30 * 0.30)) * 0.16
                    val n1 = 0.55 + 0.45 * simplex.fbm2D(lon * 2.2 + 3.1, lat * 9.0, 4)
                    val n2 = simplex.fbm2D(lon * 5.5 - 7.0, lat * 22.0 + 2.0, 4) // dust lanes
                    val dust = smoothstep(n2, 0.05, 0.55) * (0.6 + 0.4 * bulge) * band
                    var inten = (band * (0.6 + 1.2 * bulge) * n1 + wide) * (1.0 - 0.9 * dust)
                    inten = max(0.0, inten) * 0.3
                    val warm = bulge * 0.5 + 0.2
                    buf[(j * m + i) * 3] = (inten * (0.86 + 0.16 * warm)).toFloat()
                    buf[(j * m + i) * 3 + 1] = (inten * (0.88 + 0.06 * warm)).toFloat()
                    buf[(j * m + i) * 3 + 2] = (inten * (1.0 - 0.18 * warm)).toFloat()
                }
            }
            mw.add(buf)
        }
        for (f in 0 until 6) {
            val src = mw[f]
            val dst = faces[f]
            for (j in 0 until n) {
                val y = ((j + 0.5) / n) * m - 0.5
                val y0 = max(0.0, floor(y)).toInt()
                val y1 = min(m - 1, y0 + 1)
                val fy = clamp(y - y0, 0.0, 1.0)
                for (i in 0 until n) {
                    val x = ((i + 0.5) / n) * m - 0.5
                    val x0 = max(0.0, floor(x)).toInt()
                    val x1 = min(m - 1, x0 + 1)
                    val fx = clamp(x - x0, 0.0, 1.0)
                    val o = (j * n + i) * 3
                    for (c in 0 until 3) {
                        val a = src[(y0 * m + x0) * 3 + c] * (1 - fx) + src[(y0 * m + x1) * 3 + c] * fx
                        val b = src[(y1 * m + x0) * 3 + c] * (1 - fx) + src[(y1 * m + x1) * 3 + c] * fx
                        dst[o + c] = (a * (1 - fy) + b * fy).toFloat()
                    }
                }
            }
        }

        // --- encode: rgb = chroma, a = intensity / STAR_ALPHA_SCALE ---
        val images = Array(6) { ByteArray(n * n * 4) }
        for (f in 0 until 6) {
            val src = faces[f]
            val data = images[f]
            for (i in 0 until n * n) {
                val r = src[i * 3].toDouble(); val g = src[i * 3 + 1].toDouble(); val b = src[i * 3 + 2].toDouble()
                val mx = max(r, max(g, max(b, 1e-6)))
                val a = min(1.0, mx / STAR_ALPHA_SCALE) // decoded radiance = rgb * a * STAR_ALPHA_SCALE
                data[i * 4] = jsRound((r / mx) * 255.0).toByte()
                data[i * 4 + 1] = jsRound((g / mx) * 255.0).toByte()
                data[i * 4 + 2] = jsRound((b / mx) * 255.0).toByte()
                data[i * 4 + 3] = jsRound(a * 255.0).toByte()
            }
        }
        return images
    }

    // ------------------------------------------------------------------ moon map

    /** Equirect moon albedo (linear grey levels, stored in an RGBA texture, R = G = B = albedo). */
    fun buildMoonTexture(seed: Int): ByteArray {
        val w = 512; val h = 256
        val rng = Rng(seed xor 0x3a7e)
        val simplex = SimplexNoise(seed xor 0x77)
        val data = ByteArray(w * h * 4)
        val alb = FloatArray(w * h)
        // base: highlands with subtle variation, maria as darker blotches
        for (j in 0 until h) {
            val v = (j + 0.5) / h
            val theta = v * PI
            for (i in 0 until w) {
                val u = (i + 0.5) / w
                val phi = u * PI * 2.0
                val x = sin(theta) * cos(phi); val y = cos(theta); val z = sin(theta) * sin(phi)
                val hi = 0.5 + 0.5 * simplex.noise3D(x * 3.1, y * 3.1, z * 3.1) * 0.5 + 0.5 * simplex.noise3D(x * 9.0, y * 9.0, z * 9.0) * 0.25
                val maria = simplex.noise3D(x * 1.6 + 5.0, y * 1.6, z * 1.6 - 3.0) * 0.6 + simplex.noise3D(x * 3.5, y * 3.5 + 2.0, z * 3.5) * 0.4
                val m = smoothstep(maria, 0.12, 0.42)
                alb[j * w + i] = lerp(0.62 + 0.14 * (hi - 0.5), 0.34 + 0.05 * (hi - 0.5), m).toFloat()
            }
        }
        // craters
        val cr = 180
        for (c in 0 until cr) {
            val cu = rng.next() * w; val cv = rng.next() * h
            val rad = 2.0 + rng.next().pow(2.2) * 26.0
            val depth = 0.25 + rng.next() * 0.35
            val r2 = ceil(rad * 1.5).toInt()
            for (dy in -r2..r2) {
                val jj = round(cv + dy).toInt()
                if (jj < 0 || jj >= h) continue
                val stretch = 1.0 / max(0.25, sin(((jj + 0.5) / h) * PI))
                var dx = -r2 * stretch
                while (dx <= r2 * stretch) {
                    val ii = ((round(cu + dx).toInt() % w) + w) % w
                    val dd = hypot(dx / stretch, dy.toDouble()) / rad
                    if (dd <= 1.5) {
                        val idx = jj * w + ii
                        var f = 0.0
                        if (dd < 0.85) f = -depth * (1.0 - dd * dd * 0.5)            // floor
                        else if (dd < 1.05) f = 0.22 * (1.0 - abs(dd - 0.95) / 0.1)  // rim
                        else f = -0.04 * (1.0 - (dd - 1.05) / 0.45)                  // ejecta shadow
                        alb[idx] = clamp(alb[idx] + f * 0.5, 0.05, 1.0).toFloat()
                    }
                    dx += 1.0
                }
            }
        }
        for (i in 0 until w * h) {
            val v = jsRound(clamp(alb[i].toDouble(), 0.0, 1.0) * 255.0).toInt()
            data[i * 4] = v.toByte(); data[i * 4 + 1] = v.toByte(); data[i * 4 + 2] = v.toByte(); data[i * 4 + 3] = 255.toByte()
        }
        return data
    }

    /** JS Math.round: half away from zero toward +infinity on .5 for positives. */
    fun jsRound(x: Double): Int {
        val f = floor(x + 0.5)
        return if (f > Int.MAX_VALUE.toDouble()) Int.MAX_VALUE else f.toInt()
    }
}
