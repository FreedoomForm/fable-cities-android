package com.fablecities.android.worldgen

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.round
import kotlin.math.sign
import kotlin.math.sqrt

/**
 * Water-surface support for the native track — a Kotlin port of the web game's water stack:
 *
 *  - `Heightmap.js computeShoreDistance` — signed distance to the shoreline as a Uint8 payload
 *    (128 + 4·sd, ±32 m at 0.25 m), with the exact Euclidean distance transform
 *    (Felzenszwalb & Huttenlocher) and the first-order h/|∇h| estimate near the waterline.
 *  - `terrain/textures.js makeNoiseTexture` — tileable RGBA fBm (R large blotches, G mid, B fine,
 *    A cellular-ish) used for foam lace, whitecaps and the waterline dither grain.
 *  - `terrain/textures.js makeWaterNormalTexture` — tileable tangent-space normal map from 18
 *    deterministic directional waves plus two fBm detail bands (strength 0.035).
 *  - `Water.js _buildGeometry` — the water quads (every 128 m chunk whose lowest sample dips below
 *    waterLevel + 0.8) plus the 4 horizon-ring quads out to `extent`.
 *
 * All of it is JVM-pure so the golden tests can pin it against the real web modules in Node.
 */
object WaterMath {

    // --------------------------------------------------------------------------------------------
    // exact Euclidean distance transform (Heightmap.js edt2d)
    // --------------------------------------------------------------------------------------------

    /** In-place exact EDT (squared distances) of an N×N grid — bit-faithful to the web helper. */
    fun edt2d(f: DoubleArray, n: Int) {
        val g = DoubleArray(n)
        val d = DoubleArray(n)
        val v = IntArray(n)
        val z = DoubleArray(n + 1)
        val inf = 1e20
        val edt1d = { get: (Int) -> Double, set: (Int, Double) -> Unit ->
            for (q in 0 until n) g[q] = get(q)
            var k = 0
            v[0] = 0
            z[0] = -inf
            z[1] = inf
            for (q in 1 until n) {
                var s = ((g[q] + q.toDouble() * q) - (g[v[k]] + v[k].toDouble() * v[k])) / (2.0 * q - 2.0 * v[k])
                while (s <= z[k]) {
                    k--
                    s = ((g[q] + q.toDouble() * q) - (g[v[k]] + v[k].toDouble() * v[k])) / (2.0 * q - 2.0 * v[k])
                }
                k++
                v[k] = q
                z[k] = s
                z[k + 1] = inf
            }
            k = 0
            for (q in 0 until n) {
                while (z[k + 1] < q) k++
                d[q] = (q - v[k]).toDouble() * (q - v[k]) + g[v[k]]
            }
            for (q in 0 until n) set(q, d[q])
        }
        for (j in 0 until n) {
            val row = j * n
            edt1d({ i -> f[row + i] }, { i, value -> f[row + i] = value })
        }
        for (i in 0 until n) {
            edt1d({ j -> f[j * n + i] }, { j, value -> f[j * n + i] = value })
        }
    }

    private fun clamp01(x: Double): Double = if (x < 0.0) 0.0 else if (x > 1.0) 1.0 else x

    private fun smoothstep(e0: Double, e1: Double, x: Double): Double {
        val t = clamp01((x - e0) / (e1 - e0))
        return t * t * (3.0 - 2.0 * t)
    }

    /**
     * Signed distance to the shoreline in metres (+ on land, − under water) for every grid sample,
     * packed as `128 + 4·sd` in [0, 255] — identical encoding to the web's shore texture payload.
     */
    fun computeShoreDistance(hm: Heightmap, out: ByteArray? = null): ByteArray {
        val n = hm.N
        val data = hm.data
        val wl = hm.waterLevel
        val spacing = hm.spacing.toDouble()
        val total = n * n
        val result = out ?: ByteArray(total)
        val inf = 1e12
        val dWater = DoubleArray(total)
        val dLand = DoubleArray(total)
        for (k in 0 until total) {
            val w = data[k] < wl
            dWater[k] = if (w) 0.0 else inf
            dLand[k] = if (w) inf else 0.0
        }
        edt2d(dWater, n)
        edt2d(dLand, n)
        for (j in 0 until n) for (i in 0 until n) {
            val k = j * n + i
            val h = data[k] - wl
            val far = if (h >= 0) sqrt(dWater[k]) * spacing else -sqrt(dLand[k]) * spacing
            // first-order shoreline distance from the local gradient
            val il = if (i > 0) k - 1 else k
            val ir = if (i < n - 1) k + 1 else k
            val ju = if (j > 0) k - n else k
            val jd = if (j < n - 1) k + n else k
            val gx = (data[ir] - data[il]) / (((ir - il) * spacing).takeIf { it != 0.0 } ?: spacing)
            val gz = (data[jd] - data[ju]) / (((jd - ju).toDouble() / n * spacing).takeIf { it != 0.0 } ?: spacing)
            val grad = max(hypot(gx, gz), 0.02)
            val near = (h / grad).coerceIn(-8.0, 8.0)
            val aFar = abs(far)
            val w = smoothstep(1.5, 6.0, aFar)
            val sd = near + (far - near) * w
            // JS Math.round: half away from zero, then Uint8 clamp
            val r = 128.0 + 4.0 * sd
            val rounded = if (r >= 0) floor(r + 0.5) else -floor(-r + 0.5)
            result[k] = rounded.toInt().coerceIn(0, 255).toByte()
        }
        return result
    }

    // --------------------------------------------------------------------------------------------
    // seamless fBm + procedural textures (terrain/textures.js)
    // --------------------------------------------------------------------------------------------

    /** Seamless fBm in [0,1] using the 4-corner blend trick (tile period = 1 in uv). */
    fun seamlessFbm(noise: SimplexNoise, u: Double, v: Double, freq: Double, oct: Int): Double {
        val s = { x: Double, y: Double -> 0.5 + 0.5 * noise.fbm2D(x * freq, y * freq, oct) }
        val a = s(u, v)
        val b = s(u - 1, v)
        val c = s(u, v - 1)
        val d = s(u - 1, v - 1)
        val wu = u * u * (3 - 2 * u)
        val wv = v * v * (3 - 2 * v)
        val top = a * (1 - wu) + b * wu
        val bot = c * (1 - wu) + d * wu
        return top * (1 - wv) + bot * wv
    }

    /**
     * Tileable RGBA noise: R = large blotches, G = mid, B = fine, A = cellular-ish
     * (for foam / variation). Byte payload, row-major, 4 bytes per texel — the web texture's
     * exact image data (Uint8Array stores ToInt32 & 0xFF).
     */
    fun makeNoiseTexture(size: Int, seed: Int): ByteArray {
        val n1 = SimplexNoise(seed + 11)
        val n2 = SimplexNoise(seed + 12)
        val n3 = SimplexNoise(seed + 13)
        val n4 = SimplexNoise(seed + 14)
        val data = ByteArray(size * size * 4)
        for (y in 0 until size) {
            val v = y.toDouble() / size
            for (x in 0 until size) {
                val u = x.toDouble() / size
                val k = (y * size + x) * 4
                data[k] = toByte255(seamlessFbm(n1, u, v, 2.0, 3))
                data[k + 1] = toByte255(seamlessFbm(n2, u, v, 5.0, 4))
                data[k + 2] = toByte255(seamlessFbm(n3, u, v, 13.0, 4))
                val w = seamlessFbm(n4, u, v, 7.0, 2)
                data[k + 3] = toByte255(abs(w * 2 - 1).pow(0.6))
            }
        }
        return data
    }

    /**
     * Tileable water normal map from a sum of directional waves with integer wave counts —
     * the web texture's exact image data (18 waves, Rng(3), SimplexNoise(seed+99) detail).
     */
    fun makeWaterNormalTexture(size: Int, seed: Int): ByteArray {
        val rng = Rng(seed)
        val waves = ArrayList<DoubleArray>() // kx, ky, amp, phase, sharp
        for (i in 0 until 18) {
            val kx = rng.int(-7, 7)
            val ky = rng.int(-7, 7)
            if (kx == 0 && ky == 0) continue
            val len = hypot(kx.toDouble(), ky.toDouble())
            waves.add(doubleArrayOf(
                kx.toDouble(), ky.toDouble(),
                (0.55 / len) * rng.range(0.4, 1.0),
                rng.range(0.0, Math.PI * 2),
                rng.range(1.0, 2.2),
            ))
        }
        val noise = SimplexNoise(seed + 99)
        val data = ByteArray(size * size * 4)
        val height = { u: Double, v: Double ->
            var h = 0.0
            for (w in waves) {
                val s = kotlin.math.sin(2 * Math.PI * (w[0] * u + w[1] * v) + w[3])
                h += w[2] * sign(s) * abs(s).pow(w[4])
            }
            h += 2.4 * (seamlessFbm(noise, u, v, 5.0, 4) - 0.5) + 0.9 * (seamlessFbm(noise, u + 0.37, v + 0.61, 11.0, 3) - 0.5)
            h
        }
        val e = 1.0 / size
        val strength = 0.035
        for (y in 0 until size) {
            val v = y.toDouble() / size
            for (x in 0 until size) {
                val u = x.toDouble() / size
                val dx = (height(u + e, v) - height(u - e, v)) / (2 * e) * strength
                val dy = (height(u, v + e) - height(u, v - e)) / (2 * e) * strength
                val l = hypot(hypot(dx, dy), 1.0)
                val k = (y * size + x) * 4
                data[k] = toByte255(0.5 - 0.5 * dx / l)
                data[k + 1] = toByte255(0.5 - 0.5 * dy / l)
                data[k + 2] = toByte255(0.5 + 0.5 / l)
                data[k + 3] = 255.toByte()
            }
        }
        return data
    }

    /** JS `255 * x` then Uint8Array store: ToInt32 (truncate toward zero) & 0xFF. */
    private fun toByte255(x: Double): Byte {
        val i = (255.0 * x).toInt() // truncate toward zero, like JS ToInt32 for in-range values
        return (i and 0xFF).toByte()
    }

    // --------------------------------------------------------------------------------------------
    // water geometry (Water.js _buildGeometry)
    // --------------------------------------------------------------------------------------------

    /**
     * The water quad list as flat [x0, z0, x1, z1] × quads: every 128 m chunk whose lowest
     * heightmap sample dips below waterLevel + 0.8, plus the 4 horizon-ring quads.
     */
    fun buildWaterQuads(hm: Heightmap, chunkSize: Int, extent: Double): DoubleArray {
        val count = round(hm.half * 2.0 / chunkSize).toInt()
        val quads = ArrayList<DoubleArray>()
        val wl = hm.waterLevel
        for (cz in 0 until count) for (cx in 0 until count) {
            val x0 = -hm.half + cx * chunkSize
            val z0 = -hm.half + cz * chunkSize
            val i0 = ((x0 + hm.half) / hm.spacing + 0.5).toInt()
            val j0 = ((z0 + hm.half) / hm.spacing + 0.5).toInt()
            val n = (chunkSize.toDouble() / hm.spacing + 0.5).toInt()
            var mn = Double.POSITIVE_INFINITY
            for (j in j0..j0 + n) for (i in i0..i0 + n) {
                val h = hm.data[j * hm.N + i].toDouble()
                if (h < mn) mn = h
            }
            if (mn < wl + 0.8) quads.add(doubleArrayOf(x0, z0, x0 + chunkSize, z0 + chunkSize))
        }
        // horizon ring: 4 big quads around the map
        val h = hm.half
        val e = extent
        quads.add(doubleArrayOf(-e, -e, e, -h))
        quads.add(doubleArrayOf(-e, h, e, e))
        quads.add(doubleArrayOf(-e, -h, -h, h))
        quads.add(doubleArrayOf(h, -e, e, h))
        val flat = DoubleArray(quads.size * 4)
        for (q in quads.indices) {
            flat[q * 4 + 0] = quads[q][0]
            flat[q * 4 + 1] = quads[q][1]
            flat[q * 4 + 2] = quads[q][2]
            flat[q * 4 + 3] = quads[q][3]
        }
        return flat
    }

    /**
     * IEEE 754 binary16 bit pattern of a Float — an exact mirror of THREE.DataUtils.toHalfFloat
     * (round-to-nearest-even) for the R16F height texture.
     */
    fun toHalfFloat(value: Double): Int {
        val x = java.lang.Float.floatToIntBits(value.toFloat())
        var bits = (x ushr 16) and 0x8000
        var m = (x ushr 12) and 0x07ff
        val e = (x ushr 23) and 0xff
        if (e < 103) return bits
        if (e > 142) {
            bits = bits or 0x7c00
            bits = bits or ((if (e == 255) 0 else 1) and (x and 0x007fffff))
            return bits
        }
        if (e < 113) {
            m = m or 0x0800
            bits = bits or ((m ushr (114 - e)) + ((m ushr (113 - e)) and 1))
            return bits
        }
        bits = bits or (((e - 112) shl 10) or (m ushr 1))
        bits += m and 1
        return bits
    }
}
