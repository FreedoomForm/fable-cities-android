package com.fablecities.android.worldgen

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Procedural heightmap — a bit-exact Kotlin port of the web game's
 * src/modules/terrain/Heightmap.js (the analytic generator `sampleGen` and the grid +
 * editing API). The SAME seed produces the SAME world as the browser game: the coastal
 * plain around the centre, the meandering river running south into the sea, the rolling
 * flanks and the terraced mountain range to the north.
 *
 * Not yet ported (no native consumer yet, tracked in docs/ANDROID_PORT.md): `raycast`.
 * The outer horizon-ring coarse grids (Heightmap.js `_buildOuterGrids`) ARE ported — they feed
 * getHeightAny, which the ground-control rules (GroundControl.kt) sample just past the map edge.
 */
class Heightmap(val size: Int = 2048, val spacing: Int = 2, seed: Int = 1337) {

    val half: Double = size / 2.0
    val N: Int = round(size.toDouble() / spacing).toInt() + 1
    val waterLevel: Double = 0.0
    var data = FloatArray(N * N)
        private set
    var minH = 0.0
        private set
    var maxH = 0.0
        private set
    var version = 0
        private set

    private val seed: Int = seed

    // independent noise fields (different seeds → decorrelated) — identical derivations as the web
    private val nBase = SimplexNoise(seed * 7 + 1)
    private val nMid = SimplexNoise(seed * 7 + 2)
    private val nHi = SimplexNoise(seed * 7 + 3)
    private val nMount = SimplexNoise(seed * 7 + 4)
    private val nRiver = SimplexNoise(seed * 7 + 5)
    private val nMask = SimplexNoise(seed * 7 + 6)
    private val nCoast = SimplexNoise(seed * 7 + 7)
    private val nDrain = SimplexNoise(seed * 7 + 8)

    // river / coast parameters (seeded variation, bounded so the centre stays buildable)
    val river: River
    val coast: Coast
    val mountainBias: Double

    init {
        fun r(k: Int, a: Double, b: Double): Double =
            a + (b - a) * (0.5 + 0.5 * nMask.noise2D(k * 13.7, -k * 3.1))
        river = River(
            x0 = r(1, -420.0, -180.0),
            amp = r(2, 140.0, 220.0),
            wave = r(3, 380.0, 520.0),
            phase = r(4, 0.0, 6.283),
            width = r(5, 26.0, 38.0),
        )
        coast = Coast(
            z0 = r(6, 560.0, 700.0),
            amp = r(7, 90.0, 160.0),
            wave = r(8, 420.0, 620.0),
            phase = r(9, 0.0, 6.283),
        )
        mountainBias = r(10, 0.6, 0.8)
    }

    class River(val x0: Double, val amp: Double, val wave: Double, val phase: Double, val width: Double)
    class Coast(val z0: Double, val amp: Double, val wave: Double, val phase: Double)

    /** Dense polyline point carrying the final bed height in [y] (see conformPath). */
    class PathPoint(val x: Double, var y: Double, val z: Double)

    /** Erosion-field scratch record (Heightmap.js `this._f`) — shared across calls, single-threaded. */
    class Relief {
        var upland = 0.0
        var gully = 0.0
        var ridge = 0.0
        var wx = 0.0
        var wz = 0.0
        var low = 0.0
        var mid = 0.0
    }

    private val f = Relief()

    // ---------------------------------------------------------------------------------------------
    // analytic generator
    // ---------------------------------------------------------------------------------------------

    /** Centre x of the river at a given z (world coords). */
    fun riverX(z: Double): Double {
        val rv = river
        return rv.x0 + rv.amp * sin(z / rv.wave + rv.phase) +
            70.0 * nRiver.noise2D(z / 260.0, 3.3) +
            12.0 * nRiver.noise2D(z / 110.0, 9.1)
    }

    fun riverHalfWidth(z: Double): Double =
        river.width * (1.0 + 0.35 * nRiver.noise2D(z / 180.0, 17.7))

    /** Height anywhere (Heightmap.js getHeightAny): fine grid inside, coarse horizon rings outside. */
    fun getHeightAny(x: Double, z: Double): Double {
        val r = max(abs(x), abs(z))
        if (r <= half) return getHeight(x, z)
        if (outerGrid == null) buildOuterGrids()
        if (r <= half * 2.0) return outerGrid!!.getHeight(x, z)
        return farGrid!!.getHeight(x, z)
    }

    private var outerGrid: CoarseGrid? = null
    private var farGrid: CoarseGrid? = null

    /** Direct read of the 8 m outer horizon grid (Vegetation.js reads hm.outer.getHeight). */
    fun outerHeight(x: Double, z: Double): Double {
        if (outerGrid == null) buildOuterGrids()
        return outerGrid!!.getHeight(x, z)
    }

    /** getSlope over getHeightAny (Heightmap.js getSlopeAny) — distance-adaptive stencil. */
    fun getSlopeAny(x: Double, z: Double): Double {
        val r = max(abs(x), abs(z))
        val e = if (r <= half) spacing.toDouble() else if (r <= half * 2.0) 8.0 else 32.0
        val dx = (getHeightAny(x + e, z) - getHeightAny(x - e, z)) / (2.0 * e)
        val dz = (getHeightAny(x, z + e) - getHeightAny(x, z - e)) / (2.0 * e)
        return 1.0 - 1.0 / sqrt(1.0 + dx * dx + dz * dz)
    }

    /** Heightmap.js _buildOuterGrids — coarse horizon rings outside the playable map. */
    private fun buildOuterGrids() {
        val outer = CoarseGrid(8, half * 2.0)
        outer.fill { x, z ->
            val r = max(abs(x), abs(z))
            if (r <= half) getHeight(x, z) else sampleGen(x, z, if (r - half < 96.0) 0 else 1)
        }
        val far = CoarseGrid(32, half * 4.0)
        far.fill { x, z ->
            val r = max(abs(x), abs(z))
            if (r <= half * 2.0) outer.getHeight(x, z) else sampleGen(x, z, if (r - half * 2.0 < 128.0) 1 else 2)
        }
        outerGrid = outer
        farGrid = far
    }

    /** Exact port of Heightmap.js CoarseGrid — float32 payload, bilinear with clamped extent. */
    class CoarseGrid(val spacing: Int, val half: Double) {
        val N: Int = jsRound(half * 2.0 / spacing).toInt() + 1
        var data = FloatArray(N * N)
            private set
        var minH = 0.0
            private set
        var maxH = 0.0
            private set

        fun fill(fn: (Double, Double) -> Double): CoarseGrid {
            var mn = Double.POSITIVE_INFINITY
            var mx = Double.NEGATIVE_INFINITY
            for (j in 0 until N) {
                val z = -half + j * spacing
                for (i in 0 until N) {
                    val x = -half + i * spacing
                    val h = fn(x, z)
                    data[j * N + i] = h.toFloat()
                    if (h < mn) mn = h
                    if (h > mx) mx = h
                }
            }
            minH = mn; maxH = mx
            return this
        }

        fun getHeight(x: Double, z: Double): Double {
            var fx = (x + half) / spacing
            var fz = (z + half) / spacing
            if (fx < 0) fx = 0.0 else if (fx > N - 1) fx = (N - 1).toDouble()
            if (fz < 0) fz = 0.0 else if (fz > N - 1) fz = (N - 1).toDouble()
            var i = floor(fx).toInt()
            var j = floor(fz).toInt()
            if (i >= N - 1) i = N - 2
            if (j >= N - 1) j = N - 2
            val tx = fx - i
            val tz = fz - j
            val a = data[j * N + i].toDouble()
            val b = data[j * N + i + 1].toDouble()
            val c = data[(j + 1) * N + i].toDouble()
            val d = data[(j + 1) * N + i + 1].toDouble()
            return (a + (b - a) * tx) * (1.0 - tz) + (c + (d - c) * tx) * tz
        }
    }

    /** Second derivative of the river centreline (Heightmap.js riverCurvature) — sign picks the bend side. */
    fun riverCurvature(z: Double): Double {
        val e = 24.0
        return (riverX(z + e) - 2.0 * riverX(z) + riverX(z - e)) / (e * e)
    }

    /** Coastline z at a given x — sea for z beyond this. */
    fun coastZ(x: Double): Double {
        val c = coast
        return c.z0 + c.amp * sin(x / c.wave + c.phase) +
            60.0 * nCoast.noise2D(x / 300.0, 1.5) +
            18.0 * nCoast.noise2D(x / 80.0, 4.2)
    }

    /** Horizontal distance from (x,z) to the river centreline (approximate but robust for mild meanders). */
    fun riverDistance(x: Double, z: Double): Double {
        // the 5 centreline samples depend on z only → cached per row (generation scans rows)
        var c = rowCache
        if (c == null || c.z != z) {
            c = RowCache(z, riverX(z), riverX(z - 40.0), riverX(z - 20.0), riverX(z + 20.0), riverX(z + 40.0))
            rowCache = c
        }
        var d = abs(x - c.r0)
        var dx = x - c.rm2; var dd = sqrt(dx * dx + 1600.0); if (dd < d) d = dd
        dx = x - c.rm1; dd = sqrt(dx * dx + 400.0); if (dd < d) d = dd
        dx = x - c.rp1; dd = sqrt(dx * dx + 400.0); if (dd < d) d = dd
        dx = x - c.rp2; dd = sqrt(dx * dx + 1600.0); if (dd < d) d = dd
        return d
    }

    private class RowCache(val z: Double, val r0: Double, val rm2: Double, val rm1: Double, val rp1: Double, val rp2: Double)
    private var rowCache: RowCache? = null

    /**
     * Erosion-style relief fields shared by the generator and (later) the ground rules,
     * written into the reusable scratch object [f].
     */
    fun relief(x: Double, z: Double, lod: Int): Relief {
        val low = nBase.fbm2D(x / 1150.0, z / 1150.0, 3)
        val mid = nMid.fbm2D(x / 300.0, z / 300.0, if (lod < 2) 4 else 3)
        f.upland = smoothstep(-0.05, 0.55, low + 0.15 * mid)
        // domain warp → flow-like, non-blobby shapes
        val wx = x + 110.0 * nDrain.noise2D(x / 520.0 + 7.3, z / 520.0)
        val wz = z + 110.0 * nDrain.noise2D(x / 520.0, z / 520.0 - 7.3)
        f.wx = wx; f.wz = wz
        f.ridge = nDrain.ridged2D(wx / 240.0 + 3.0, wz / 240.0, if (lod == 0) 3 else 2, 2.0, 0.55)
        // drainage: the zero set of a warped noise forms sinuous gullies; wider/softer on the lowland
        val dN = nDrain.noise2D(wx / 150.0 - 11.0, wz / 150.0 + 5.0) + 0.25 * nDrain.noise2D(wx / 48.0 + 2.0, wz / 48.0)
        val halfW = 0.13 + 0.12 * (1.0 - f.upland)
        val g = 1.0 - smoothstep(0.0, halfW, abs(dN))
        f.gully = g * g * (3.0 - 2.0 * g)
        f.low = low; f.mid = mid
        return f
    }

    /**
     * Unbounded terrain height in metres at world (x, z).
     * `lod` selects the octave budget for the sampling density: 0 → 2 m grid (full detail),
     * 1 → 8 m grid, 2 → 32 m grid.
     */
    fun sampleGen(x: Double, z: Double, lod: Int = 0): Double {
        // --- rolling base + erosion-style relief ---------------------------------------------------
        val fr = relief(x, z, lod)
        val mid = fr.mid
        val upland = fr.upland
        val hi = when (lod) {
            0 -> nHi.fbm2D(x / 46.0, z / 46.0, 3)
            1 -> nHi.fbm2D(x / 46.0, z / 46.0, 1)
            else -> 0.0
        }
        // rolling relief on the lowland: 100-400 m wavelengths, 6-14 m amplitude (grades stay < 6 %)
        val roll = nMid.fbm2D(x / 230.0 + 5.5, z / 230.0 - 2.5, if (lod < 2) 3 else 2)
        val roll2 = nMid.fbm2D(x / 560.0 - 3.1, z / 560.0 + 8.4, 2)
        val knoll = abs(nMid.noise2D(x / 90.0 + 2.0, z / 90.0))
        var h = 7.5 + 1.6 * mid * (0.35 + 0.65 * upland) + 0.45 * hi * (0.4 + 0.6 * upland) +
            (1.0 - upland) * (5.0 * roll + 3.4 * roll2 + 1.4 * knoll - 0.8 * fr.gully) +
            upland * (34.0 + 26.0 * mid + 6.0 * knoll + 18.0 * (fr.ridge - 0.5) - 5.5 * fr.gully)

        // --- mountains (north, terraced ridges → cliffs) ---------------------------------------
        val mMaskNoise = nMount.fbm2D(x / 1500.0 + 4.2, z / 1500.0 - 1.7, 3) +
            mountainBias * (-clamp(z, -half, half) / half) - 0.05
        var mount = smoothstep(0.22, 0.7, mMaskNoise) * smoothstep(120.0, 520.0, hypot(x, z))
        var mh = 0.0
        if (mount > 0.0005) {
            val ridge = nMount.ridged2D(
                x / 360.0 + 9.0, z / 360.0 - 5.0,
                if (lod == 0) 5 else if (lod == 1) 4 else 3, 2.1, if (lod == 0) 0.5 else 0.42,
            )
            // per-massif amplitude (±35 %) so summits reach different altitudes
            val peakVar = 1.0 + 0.35 * nMount.noise2D(x / 760.0 + 3.3, z / 760.0 - 6.1)
            mh = 60.0 + 150.0 * ridge * peakVar
            // terracing → cliffs & benches
            val step = 22.0
            val q = floor(mh / step) * step
            val tfr = (mh - q) / step
            val tf = smoothstep(0.35, 0.75, tfr)
            mh = lerp(mh, q + tf * step, if (lod == 0) 0.55 else if (lod == 1) 0.35 else 0.12)
            // far ring: the range keeps rising towards the horizon
            val rOut = max(abs(x), abs(z)) - half
            if (rOut > 0.0) mh += 70.0 * smoothstep(200.0, 2200.0, rOut) * smoothstep(0.3, 0.8, mMaskNoise)
        }

        // --- river & coast masks --------------------------------------------------------------
        val zc = coastZ(x)
        val dc = z - zc // >0 = seaward
        val d = riverDistance(x, z)
        val w = riverHalfWidth(z) * (1.0 + 0.9 * smoothstep(-420.0, 60.0, dc)) // estuary widens
        val floodH = 4.6 + 1.4 * mid + 0.25 * hi + 1.2 * roll - 0.5 * fr.gully
        val floodBlend = smoothstep(260.0, 90.0, d) // 1 near river, 0 far away
        mount *= smoothstep(120.0, 460.0, d) * smoothstep(-80.0, -520.0, dc)
        h = lerp(h, floodH, floodBlend)
        h += mount * mh

        // --- coastal plain & beach (south) ----------------------------------------------------
        val coastalPlain = smoothstep(-460.0, -140.0, dc)
        h = lerp(h, 3.8 + 1.2 * mid + 0.3 * hi, coastalPlain * (1.0 - mount) * 0.92)
        val beach = smoothstep(-80.0, 0.0, dc)
        h = lerp(h, 1.4 - 2.6 * (dc + 80.0) / 80.0, beach * 0.95)

        // --- river channel with a continuous, natural bank profile ------------------------------
        if (d < w + 30.0) {
            val bank = smoothstep(w + 30.0, w + 6.0, d)
            val bankH = 1.3 + 0.5 * nRiver.noise2D(x / 37.0, z / 37.0)
            val side = if (x - riverX(z) > 0.0) 1.0 else -1.0
            val bluffN = nRiver.noise2D(z / 210.0 + 40.0, side * 7.7) + 0.35 * nRiver.noise2D(z / 60.0 - 11.0, side * 3.1)
            val bluff = smoothstep(0.32, 0.6, bluffN) * (1.0 - beach) * smoothstep(-40.0, -200.0, dc) * (1.0 - mount)
            val bluffH = max(h, bankH + 4.5 + 3.5 * smoothstep(0.5, 0.9, bluffN))
            val target = lerp(min(h, bankH), bluffH, bluff)
            h = lerp(h, target, bank)
            if (d < w + 6.0) {
                val step = smoothstep(w + 6.0, w, d)
                h = lerp(lerp(h, min(h, 0.7), step), lerp(h, 0.7, smoothstep(w + 4.5, w + 0.5, d)), bluff)
            }
            if (d < w) {
                val u = d / w
                val prof = Math.pow(1.0 - u * u, 1.15)
                h = min(h, 0.7 - 9.0 * prof)
            }
        }

        // --- sea ------------------------------------------------------------------------------
        if (dc > 0.0) {
            val depth = -2.5 - 14.0 * smoothstep(0.0, 260.0, dc) - 6.0 * smoothstep(200.0, 900.0, dc) -
                14.0 * smoothstep(900.0, 3000.0, dc) + 1.2 * hi
            val sea = lerp(h, depth, smoothstep(0.0, 40.0, dc))
            h = min(h, sea)
        }
        return h
    }

    // ---------------------------------------------------------------------------------------------
    // grid generation & queries
    // ---------------------------------------------------------------------------------------------

    fun generate(): Heightmap {
        var mn = Double.POSITIVE_INFINITY
        var mx = Double.NEGATIVE_INFINITY
        for (j in 0 until N) {
            val z = -half + j * spacing
            for (i in 0 until N) {
                val x = -half + i * spacing
                val h = sampleGen(x, z)
                data[j * N + i] = h.toFloat()
                if (h < mn) mn = h
                if (h > mx) mx = h
            }
        }
        minH = mn
        maxH = mx
        version++
        return this
    }

    /** Bilinear height at world (x, z). Coordinates are clamped to the map. */
    fun getHeight(x: Double, z: Double): Double {
        var fx = (x + half) / spacing
        var fz = (z + half) / spacing
        if (fx < 0.0) fx = 0.0 else if (fx > N - 1.0) fx = (N - 1).toDouble()
        if (fz < 0.0) fz = 0.0 else if (fz > N - 1.0) fz = (N - 1).toDouble()
        var i = floor(fx).toInt()
        var j = floor(fz).toInt()
        if (i >= N - 1) i = N - 2
        if (j >= N - 1) j = N - 2
        val tx = fx - i
        val tz = fz - j
        val a = data[j * N + i].toDouble()
        val b = data[j * N + i + 1].toDouble()
        val c = data[(j + 1) * N + i].toDouble()
        val d = data[(j + 1) * N + i + 1].toDouble()
        return (a + (b - a) * tx) * (1.0 - tz) + (c + (d - c) * tx) * tz
    }

    /** Slope (0 flat … 1 vertical-ish) = 1 - normal.y. */
    fun getSlope(x: Double, z: Double): Double {
        val e = spacing.toDouble()
        val dx = (getHeight(x + e, z) - getHeight(x - e, z)) / (2.0 * e)
        val dz = (getHeight(x, z + e) - getHeight(x, z - e)) / (2.0 * e)
        return 1.0 - 1.0 / sqrt(1.0 + dx * dx + dz * dz)
    }

    // ---------------------------------------------------------------------------------------------
    // editing
    // ---------------------------------------------------------------------------------------------

    /** Flatten a rectangle [x0,x1]×[z0,z1] (world metres) to height [y] with a smooth [falloff] blend. */
    fun flattenRect(x0: Double, z0: Double, x1: Double, z1: Double, y: Double, falloff: Double = 6.0): IntArray? {
        val i0 = clamp(floor((min(x0, x1) - falloff + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val i1 = clamp(ceil((max(x0, x1) + falloff + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val j0 = clamp(floor((min(z0, z1) - falloff + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val j1 = clamp(ceil((max(z0, z1) + falloff + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        if (i1 < i0 || j1 < j0) return null
        val ax = min(x0, x1); val bx = max(x0, x1); val az = min(z0, z1); val bz = max(z0, z1)
        for (j in j0..j1) {
            val z = -half + j * spacing
            val dz = when {
                z < az -> az - z
                z > bz -> z - bz
                else -> 0.0
            }
            for (i in i0..i1) {
                val x = -half + i * spacing
                val dx = when {
                    x < ax -> ax - x
                    x > bx -> x - bx
                    else -> 0.0
                }
                val d = hypot(dx, dz)
                val w = if (falloff > 0.0) 1.0 - smoothstep(0.0, falloff, d) else if (d == 0.0) 1.0 else 0.0
                if (w <= 0.0) continue
                val k = j * N + i
                data[k] = lerp(data[k].toDouble(), y, w).toFloat()
                if (data[k].toDouble() > maxH) maxH = data[k].toDouble()
                if (data[k].toDouble() < minH) minH = data[k].toDouble()
            }
        }
        version++
        return intArrayOf(i0, i1, j0, j1)
    }

    /**
     * Conform the terrain to a corridor: [points] = dense centreline samples carrying the final
     * bed height in y, [width] = full corridor width, [falloff] = metres of smooth blend outside.
     */
    fun conformPath(points: List<PathPoint>, width: Double, falloff: Double = 6.0): IntArray? {
        if (points.size < 2) return null
        val r = width / 2.0
        val reach = r + falloff
        var minX = Double.POSITIVE_INFINITY; var maxX = Double.NEGATIVE_INFINITY
        var minZ = Double.POSITIVE_INFINITY; var maxZ = Double.NEGATIVE_INFINITY
        for (p in points) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
            if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z
        }
        val i0 = clamp(floor((minX - reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val i1 = clamp(ceil((maxX + reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val j0 = clamp(floor((minZ - reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val j1 = clamp(ceil((maxZ + reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        if (i1 < i0 || j1 < j0) return null
        val W = i1 - i0 + 1
        val H = j1 - j0 + 1
        val bestD = FloatArray(W * H) { Float.POSITIVE_INFINITY }
        val bestY = FloatArray(W * H)
        for (s in 0 until points.size - 1) {
            val a = points[s]
            val b = points[s + 1]
            val abx = b.x - a.x; val abz = b.z - a.z
            val len2 = abx * abx + abz * abz
            if (len2 < 1e-6) continue
            val si0 = clamp(floor((min(a.x, b.x) - reach + half) / spacing), i0.toDouble(), i1.toDouble()).toInt()
            val si1 = clamp(ceil((max(a.x, b.x) + reach + half) / spacing), i0.toDouble(), i1.toDouble()).toInt()
            val sj0 = clamp(floor((min(a.z, b.z) - reach + half) / spacing), j0.toDouble(), j1.toDouble()).toInt()
            val sj1 = clamp(ceil((max(a.z, b.z) + reach + half) / spacing), j0.toDouble(), j1.toDouble()).toInt()
            for (j in sj0..sj1) {
                val z = -half + j * spacing
                for (i in si0..si1) {
                    val x = -half + i * spacing
                    val u = clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0.0, 1.0)
                    val px = a.x + abx * u
                    val pz = a.z + abz * u
                    val d = hypot(x - px, z - pz)
                    if (d >= reach) continue
                    val k = (j - j0) * W + (i - i0)
                    if (d < bestD[k]) {
                        bestD[k] = d.toFloat()
                        bestY[k] = (a.y + (b.y - a.y) * u).toFloat()
                    }
                }
            }
        }
        var touched = false
        for (j in j0..j1) for (i in i0..i1) {
            val k = (j - j0) * W + (i - i0)
            val d = bestD[k].toDouble()
            if (d == Double.POSITIVE_INFINITY) continue
            val w = if (d <= r) 1.0 else 1.0 - smoothstep(r, reach, d)
            if (w <= 0.0) continue
            val g = j * N + i
            data[g] = lerp(data[g].toDouble(), bestY[k].toDouble(), w).toFloat()
            if (data[g].toDouble() > maxH) maxH = data[g].toDouble()
            if (data[g].toDouble() < minH) minH = data[g].toDouble()
            touched = true
        }
        if (!touched) return null
        version++
        return intArrayOf(i0, i1, j0, j1)
    }

    /** Conform a disc (junction pad) to height [y] with a smooth falloff outside radius [r]. */
    fun conformDisc(x: Double, z: Double, r: Double, y: Double, falloff: Double = 6.0): IntArray? {
        val reach = r + falloff
        val i0 = clamp(floor((x - reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val i1 = clamp(ceil((x + reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val j0 = clamp(floor((z - reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        val j1 = clamp(ceil((z + reach + half) / spacing), 0.0, (N - 1).toDouble()).toInt()
        if (i1 < i0 || j1 < j0) return null
        for (j in j0..j1) {
            val dz = -half + j * spacing - z
            for (i in i0..i1) {
                val dx = -half + i * spacing - x
                val d = hypot(dx, dz)
                if (d >= reach) continue
                val w = if (d <= r) 1.0 else 1.0 - smoothstep(r, reach, d)
                val g = j * N + i
                data[g] = lerp(data[g].toDouble(), y, w).toFloat()
                if (data[g].toDouble() > maxH) maxH = data[g].toDouble()
                if (data[g].toDouble() < minH) minH = data[g].toDouble()
            }
        }
        version++
        return intArrayOf(i0, i1, j0, j1)
    }

    /** Average height inside a rectangle (used to pick the flatten level for lots). */
    fun averageHeight(x0: Double, z0: Double, x1: Double, z1: Double): Double {
        val n = 4
        var sum = 0.0
        for (a in 0..n) for (b in 0..n) sum += getHeight(lerp(x0, x1, a.toDouble() / n), lerp(z0, z1, b.toDouble() / n))
        return sum / ((n + 1) * (n + 1))
    }

    private companion object {
        fun clamp(v: Double, a: Double, b: Double): Double = if (v < a) a else if (v > b) b else v
        fun clamp01(v: Double): Double = if (v < 0.0) 0.0 else if (v > 1.0) 1.0 else v
        fun lerp(a: Double, b: Double, t: Double): Double = a + (b - a) * t
        fun smoothstep(a: Double, b: Double, v: Double): Double {
            val t = clamp01((v - a) / (b - a))
            return t * t * (3.0 - 2.0 * t)
        }
    }
}
