package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Kotlin port of the browser game's cloud texture stack:
 *   src/modules/environment/proceduralNoise.js (tileable Perlin 3D / Worley 3D / Perlin 2D)
 *   src/modules/environment/Clouds.js          (buildCloudNoiseTexture / buildWeatherTexture /
 *                                               buildCirrusTexture)
 *   src/modules/environment/CloudShadow.js     (CloudShadowMap — the R8 ground-shadow bake)
 *
 * All generators are deterministic per seed (the site's mulberry32 via Rng). Values match the
 * web bit-for-bit in double math; the final byte round() can differ by 1 LSB where a value sits
 * exactly on a rounding boundary, so the golden tests allow ±1 per byte.
 *
 * Pinned by CloudParityTest against tools/probe_clouds.mjs running the REAL web generators.
 */
object CloudMath {
    fun clamp01(v: Double): Double = if (v < 0.0) 0.0 else if (v > 1.0) 1.0 else v
    fun remap(v: Double, a: Double, b: Double, c: Double, d: Double): Double = c + ((v - a) / (b - a)) * (d - c)
    fun fade(t: Double): Double = t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
    fun sstep(a: Double, b: Double, v: Double): Double {
        val t = clamp01((v - a) / (b - a))
        return t * t * (3.0 - 2.0 * t)
    }
}

class TileablePerlin3D(seed: Int, val period: Int = 16) {
    private val perm = ByteArray(512)
    private val grad = arrayOf(
        doubleArrayOf(1.0, 1.0, 0.0), doubleArrayOf(-1.0, 1.0, 0.0), doubleArrayOf(1.0, -1.0, 0.0), doubleArrayOf(-1.0, -1.0, 0.0),
        doubleArrayOf(1.0, 0.0, 1.0), doubleArrayOf(-1.0, 0.0, 1.0), doubleArrayOf(1.0, 0.0, -1.0), doubleArrayOf(-1.0, 0.0, -1.0),
        doubleArrayOf(0.0, 1.0, 1.0), doubleArrayOf(0.0, -1.0, 1.0), doubleArrayOf(0.0, 1.0, -1.0), doubleArrayOf(0.0, -1.0, -1.0),
        doubleArrayOf(1.0, 1.0, 0.0), doubleArrayOf(-1.0, 1.0, 0.0), doubleArrayOf(0.0, -1.0, 1.0), doubleArrayOf(0.0, -1.0, -1.0),
    )

    init {
        val rng = Rng(seed)
        val p = ByteArray(256)
        for (i in 0 until 256) p[i] = i.toByte()
        for (i in 255 downTo 1) {
            val j = floor(rng.next() * (i + 1)).toInt()
            val t = p[i]; p[i] = p[j]; p[j] = t
        }
        for (i in 0 until 512) perm[i] = p[i and 255]
    }

    private fun g(ix0: Int, iy0: Int, iz0: Int, period: Int): DoubleArray {
        val ix = ((ix0 % period) + period) % period
        val iy = ((iy0 % period) + period) % period
        val iz = ((iz0 % period) + period) % period
        return grad[perm[ix + (perm[iy + perm[iz].toInt() and 0xFF].toInt() and 0xFF)].toInt() and 15]
    }

    /** x,y,z in lattice units; tiles with `period`. Returns [-1,1]. */
    fun noise(x: Double, y: Double, z: Double, period: Int = this.period): Double {
        val X = floor(x).toInt(); val Y = floor(y).toInt(); val Z = floor(z).toInt()
        val fx = x - X; val fy = y - Y; val fz = z - Z
        val u = CloudMath.fade(fx); val v = CloudMath.fade(fy); val w = CloudMath.fade(fz)
        var result = 0.0
        for (dz in 0 until 2) {
            for (dy in 0 until 2) {
                for (dx in 0 until 2) {
                    val gr = g(X + dx, Y + dy, Z + dz, period)
                    val dot = gr[0] * (fx - dx) + gr[1] * (fy - dy) + gr[2] * (fz - dz)
                    val wgt = (if (dx != 0) u else 1 - u) * (if (dy != 0) v else 1 - v) * (if (dz != 0) w else 1 - w)
                    result += wgt * dot
                }
            }
        }
        return result * 1.15
    }

    /** fBm in [0,1] across `octaves`, each octave doubling the frequency. */
    fun fbm(x: Double, y: Double, z: Double, octaves: Int = 3, basePeriod: Int = this.period): Double {
        var amp = 0.5; var sum = 0.0; var norm = 0.0; var f = 1
        for (o in 0 until octaves) {
            sum += amp * noise(x * f, y * f, z * f, basePeriod * f)
            norm += amp
            amp *= 0.5
            f *= 2
        }
        return 0.5 + 0.5 * (sum / norm)
    }
}

/** Tileable Worley (cellular) noise: one feature point per cell, wraps every `cells`. Returns [0,1]. */
class TileableWorley3D(seed: Int, val cells: Int = 4) {
    private val points: DoubleArray

    init {
        val rng = Rng(seed)
        val n = cells * cells * cells
        points = DoubleArray(n * 3)
        for (i in 0 until n) {
            points[i * 3] = rng.next()
            points[i * 3 + 1] = rng.next()
            points[i * 3 + 2] = rng.next()
        }
    }

    /** x,y,z in [0,1) texture space. */
    fun sample(x: Double, y: Double, z: Double): Double {
        val c = cells
        val px = x * c; val py = y * c; val pz = z * c
        val ix = floor(px).toInt(); val iy = floor(py).toInt(); val iz = floor(pz).toInt()
        var minD = 1e9
        for (dz in -1..1) {
            for (dy in -1..1) {
                for (dx in -1..1) {
                    val cx = ix + dx; val cy = iy + dy; val cz = iz + dz
                    val wx = ((cx % c) + c) % c; val wy = ((cy % c) + c) % c; val wz = ((cz % c) + c) % c
                    val idx = (wx + wy * c + wz * c * c) * 3
                    val fx = cx + points[idx] - px
                    val fy = cy + points[idx + 1] - py
                    val fz = cz + points[idx + 2] - pz
                    val d = fx * fx + fy * fy + fz * fz
                    if (d < minD) minD = d
                }
            }
        }
        return 1.0 - min(1.0, sqrt(minD))
    }
}

/** Tileable 2D fBm in [0,1] built from the 3D Perlin with z fixed. */
class TileablePerlin2D(seed: Int, period: Int = 8) {
    private val p3 = TileablePerlin3D(seed, period)
    private val period = period

    fun fbm(x: Double, y: Double, octaves: Int = 4, basePeriod: Int = this.period, gain: Double = 0.5): Double {
        var amp = 0.5; var sum = 0.0; var norm = 0.0; var f = 1
        for (o in 0 until octaves) {
            sum += amp * p3.noise(x * f, y * f, 0.37, basePeriod * f)
            norm += amp
            amp *= gain
            f *= 2
        }
        return 0.5 + 0.5 * (sum / norm)
    }
}

object Clouds {
    const val NOISE_SIZE = 64
    const val WEATHER_SIZE = 256

    /** Clouds.js buildCloudNoiseTexture: 64³ RGBA Perlin-Worley shape volume. */
    fun buildCloudNoiseTexture(seed: Int): ByteArray {
        val N = NOISE_SIZE
        val perlin = TileablePerlin3D(seed xor 0x51ab, 4)
        val w1 = TileableWorley3D(seed xor 0x1001, 4)
        val w2 = TileableWorley3D(seed xor 0x1002, 8)
        val w3 = TileableWorley3D(seed xor 0x1003, 16)
        val w4 = TileableWorley3D(seed xor 0x1004, 32)
        val data = ByteArray(N * N * N * 4)
        var i = 0
        for (z in 0 until N) {
            for (y in 0 until N) {
                for (x in 0 until N) {
                    val u = (x + 0.5) / N; val v = (y + 0.5) / N; val w = (z + 0.5) / N
                    val p = perlin.fbm(u * 4, v * 4, w * 4, 3, 4)
                    val a = w1.sample(u, v, w); val b = w2.sample(u, v, w); val c = w3.sample(u, v, w); val d = w4.sample(u, v, w)
                    val worleyFbm = a * 0.625 + b * 0.25 + c * 0.125
                    val pw = CloudMath.clamp01(CloudMath.remap(p, 0.0, 1.0, worleyFbm, 1.0))
                    data[i++] = (CloudMath.clamp01(pw) * 255.0).roundToInt().toByte()
                    data[i++] = (CloudMath.clamp01(b) * 255.0).roundToInt().toByte()
                    data[i++] = (CloudMath.clamp01(c) * 255.0).roundToInt().toByte()
                    data[i++] = (CloudMath.clamp01(d) * 255.0).roundToInt().toByte()
                }
            }
        }
        return data
    }

    /** Clouds.js buildWeatherTexture: R = rank-equalised coverage, G = type, B = mid structure. */
    fun buildWeatherTexture(seed: Int): ByteArray {
        val N = WEATHER_SIZE
        val n1 = TileablePerlin2D(seed xor 0x7e01, 4)
        val n2 = TileablePerlin2D(seed xor 0x7e02, 8)
        val data = ByteArray(N * N * 4)
        val raw = FloatArray(N * N)  // the web uses Float32Array — float32 storage semantics
        val mids = FloatArray(N * N)
        for (y in 0 until N) {
            for (x in 0 until N) {
                val u = (x + 0.5) / N; val v = (y + 0.5) / N
                val big = n1.fbm(u * 4, v * 4, 5, 4)
                val mid = n2.fbm(u * 8, v * 8, 3, 8)
                raw[y * N + x] = (big * 0.72 + mid * 0.28).toFloat()
                mids[y * N + x] = mid.toFloat()
            }
        }
        // rank-equalise → uniform distribution: a coverage threshold of (1 - c) covers exactly c
        val order = Array(raw.size) { it }.sortedBy { raw[it] }
        val rank = FloatArray(N * N)
        for (i in order.indices) rank[order[i]] = ((i + 0.5) / order.size).toFloat()
        for (y in 0 until N) {
            for (x in 0 until N) {
                val u = (x + 0.5) / N; val v = (y + 0.5) / N
                val i = y * N + x
                val type = CloudMath.clamp01(CloudMath.remap(n2.fbm(u * 8 + 0.31, v * 8 + 0.77, 3, 8), 0.3, 0.7, 0.0, 1.0))
                data[i * 4] = (rank[i] * 255f).roundToInt().toByte()
                data[i * 4 + 1] = (type * 255.0).roundToInt().toByte()
                data[i * 4 + 2] = (mids[i] * 255f).roundToInt().toByte()
                data[i * 4 + 3] = 255.toByte()
            }
        }
        return data
    }

    /** Clouds.js buildCirrusTexture: R = fibrous streaks, G = broad patches (rank-equalised). */
    fun buildCirrusTexture(seed: Int): ByteArray {
        val N = 256
        val fine = TileablePerlin2D(seed xor 0x2c11, 6)
        val broad = TileablePerlin2D(seed xor 0x2c12, 2)
        val r = FloatArray(N * N); val g = FloatArray(N * N) // web Float32Array
        for (y in 0 until N) {
            for (x in 0 until N) {
                val u = (x + 0.5) / N; val v = (y + 0.5) / N
                val a = 1.0 - abs(2.0 * fine.fbm(u * 6, v * 6, 4, 6) - 1.0)
                val b = 1.0 - abs(2.0 * fine.fbm(u * 6 + 0.37, v * 6 + 0.11, 5, 6, 0.6) - 1.0)
                val soft = fine.fbm(u * 6 + 0.71, v * 6 + 0.29, 3, 6)
                r[y * N + x] = CloudMath.clamp01(CloudMath.clamp01(a * 0.6 + b * 0.4).pow(1.25) * 0.55 + soft * 0.45).toFloat()
                g[y * N + x] = broad.fbm(u * 2, v * 2, 3, 2).toFloat()
            }
        }
        val equalise = { arr: FloatArray ->
            val order = Array(arr.size) { it }.sortedBy { arr[it] }
            val out = FloatArray(arr.size)
            for (i in order.indices) out[order[i]] = ((i + 0.5) / arr.size).toFloat()
            out
        }
        val rq = equalise(r); val gq = equalise(g)
        val data = ByteArray(N * N * 4)
        for (i in 0 until N * N) {
            data[i * 4] = (rq[i] * 255f).roundToInt().toByte()
            data[i * 4 + 1] = (gq[i] * 255f).roundToInt().toByte()
            data[i * 4 + 2] = 0
            data[i * 4 + 3] = 255.toByte()
        }
        return data
    }
}

/**
 * CloudShadowMap (CloudShadow.js): an R8 ground-shadow texture baked from the weather map
 * (coverage fronts) eroded by a slice of the 64³ shape noise (cumulus cells).
 */
class CloudShadowMap(
    weatherTexture: ByteArray,
    noiseTexture: ByteArray,
    private val weatherScale: Double = 22000.0,
    noiseTile: Double = 780.0,
    private val shapeK: Double = 1.0,
) {
    companion object {
        const val SIZE = 512
        const val CLOUD_BASE = 1000.0
        const val CLOUD_THICK = 2350.0 // must match CloudLayer uCloudBase / uCloudTop
        const val BASE_SCALE = 5600.0  // must match CloudLayer uBaseScale
    }

    val size = SIZE
    private val field = FloatArray(SIZE * SIZE) // weather coverage field (web Float32Array)
    private val base = FloatArray(SIZE * SIZE)  // shape-noise base density low in the cloud
    val data = ByteArray(SIZE * SIZE) { 255.toByte() }
    var shadowFraction = 0.0
        private set
    private var bakedCover = -1.0
    private var bakedStrength = -1.0

    init {
        val M = Clouds.WEATHER_SIZE; val w = weatherTexture
        val K = Clouds.NOISE_SIZE; val nd = noiseTexture
        val wrapM = { i: Int -> ((i % M) + M) % M }
        val wrapK = { i: Int -> ((i % K) + K) % K }
        val noiseRepeats = max(1.0, (weatherScale / noiseTile).roundToInt().toDouble())
        // fixed y slice: hf 0.12 above the base (shader maps y → y * 0.85 / 8000 in noise space)
        val qy = ((CLOUD_BASE + 0.12 * CLOUD_THICK) * 0.85 / BASE_SCALE) * K
        val y0 = floor(qy).toInt(); val ty = qy - y0; val ya = wrapK(y0); val yb = wrapK(y0 + 1)
        val hg = 0.92 // heightGradient(0.12) for cumulus-ish type
        val sampleNoise = { fx0: Double, fz0: Double ->
            val x0 = floor(fx0).toInt(); val tx = fx0 - x0; val xa = wrapK(x0); val xb = wrapK(x0 + 1)
            val z0 = floor(fz0).toInt(); val tz = fz0 - z0; val za = wrapK(z0); val zb = wrapK(z0 + 1)
            var r = 0.0; var g = 0.0; var b = 0.0; var a = 0.0
            val corners = arrayOf(
                arrayOf(xa, ya, za, (1 - tx) * (1 - ty) * (1 - tz)), arrayOf(xb, ya, za, tx * (1 - ty) * (1 - tz)),
                arrayOf(xa, yb, za, (1 - tx) * ty * (1 - tz)), arrayOf(xb, yb, za, tx * ty * (1 - tz)),
                arrayOf(xa, ya, zb, (1 - tx) * (1 - ty) * tz), arrayOf(xb, ya, zb, tx * (1 - ty) * tz),
                arrayOf(xa, yb, zb, (1 - tx) * ty * tz), arrayOf(xb, yb, zb, tx * ty * tz),
            )
            for (cr in corners) {
                val i = ((cr[2] as Int * K + cr[1] as Int) * K + cr[0] as Int) * 4 // (z*K + y)*K + x
                val wt = cr[3] as Double
                r += (nd[i].toInt() and 0xFF) * wt; g += (nd[i + 1].toInt() and 0xFF) * wt
                b += (nd[i + 2].toInt() and 0xFF) * wt; a += (nd[i + 3].toInt() and 0xFF) * wt
            }
            doubleArrayOf(r / 255.0, g / 255.0, b / 255.0, a / 255.0)
        }
        for (y in 0 until SIZE) {
            val v = (y + 0.5) / SIZE
            val fy = v * M - 0.5; val wy0 = floor(fy).toInt(); val wty = fy - wy0; val wya = wrapM(wy0); val wyb = wrapM(wy0 + 1)
            for (x in 0 until SIZE) {
                val u = (x + 0.5) / SIZE
                val fx = u * M - 0.5; val wx0 = floor(fx).toInt(); val wtx = fx - wx0; val wxa = wrapM(wx0); val wxb = wrapM(wx0 + 1)
                val i00 = (wya * M + wxa) * 4; val i10 = (wya * M + wxb) * 4; val i01 = (wyb * M + wxa) * 4; val i11 = (wyb * M + wxb) * 4
                val rr = (((w[i00].toInt() and 0xFF) * (1 - wtx) + (w[i10].toInt() and 0xFF) * wtx) * (1 - wty) +
                    ((w[i01].toInt() and 0xFF) * (1 - wtx) + (w[i11].toInt() and 0xFF) * wtx) * wty) / 255.0
                val bl = (((w[i00 + 2].toInt() and 0xFF) * (1 - wtx) + (w[i10 + 2].toInt() and 0xFF) * wtx) * (1 - wty) +
                    ((w[i01 + 2].toInt() and 0xFF) * (1 - wtx) + (w[i11 + 2].toInt() and 0xFF) * wtx) * wty) / 255.0
                field[y * SIZE + x] = (rr + (bl - 0.5) * 0.3).toFloat() // same field coverageAt() thresholds
                val pn = sampleNoise(u * noiseRepeats * K, v * noiseRepeats * K)
                base[y * SIZE + x] = (CloudMath.clamp01(pn[0] * 0.8 + (1.0 - pn[1]) * 0.2) * hg).toFloat()
            }
        }
        // rank-equalise the shape noise so cell thresholds are exact area fractions
        val order = Array(base.size) { it }.sortedBy { base[it] }
        for (r in order.indices) base[order[r]] = ((r + 0.5) / base.size).toFloat()
    }

    /** Re-threshold for the current cloud coverage (0..1) and shadow strength (0..1). True if re-baked. */
    fun update(cover: Double, strength: Double): Boolean {
        if (abs(cover - bakedCover) < 0.012 && abs(strength - bakedStrength) < 0.02) return false
        val th = 1.0 - cover
        val a = th - 0.3; val b = th + 0.16
        val cf = 0.42 + 0.58 * CloudMath.sstep(0.3, 0.9, cover) * shapeK
        val pT = 1.0 - cf
        val f = field; val bs = base; val d = data
        var shaded = 0.0
        for (i in f.indices) {
            val cov = CloudMath.sstep(a, b, f[i].toDouble())
            var shadow = 1.0
            if (cov > 0.002) {
                val cell = CloudMath.sstep(pT - 0.08, pT + 0.16, bs[i].toDouble())
                val dens = cov * cell
                val trans = exp(-dens * 6.5) // Beer through the cell: soft-edged, dark core
                shadow = 1.0 - strength * (1.0 - trans)
            }
            shaded += 1.0 - shadow
            d[i] = (shadow * 255.0).roundToInt().toByte()
        }
        shadowFraction = shaded / f.size
        bakedCover = cover
        bakedStrength = strength
        return true
    }
}
