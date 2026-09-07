package com.fablecities.android.worldgen

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Bit-exact Kotlin port of the tree DISTRIBUTION half of the web game's
 * src/modules/terrain/Vegetation.js (the `_distribute` / `_worley` / `_clump` /
 * `canopyCoverage` pipeline — placement, species/kind picking, per-instance colour jitter and
 * the crown-coverage raster that re-bakes ctrl2.r). The procedural branch/leaf GEOMETRY and the
 * canvas card textures stay web-side; the native renderer draws the placement with its own
 * instanced card trees (VegetationGfx).
 *
 * Every rule is ported in the exact evaluation order of the JS original, so the SAME seed
 * produces the SAME forest: the same stands with ragged edges, glades and gaps, the same
 * species mix (conifers gain altitude, broadleaves hold the valley), the same per-tree
 * hue/value jitter and the same autumn-tinged exceptions. Pinned by VegetationParityTest
 * against the real module in Node (tools/probe_vegetation.mjs drives the REAL class through
 * a bare prototype instance — no GL involved in placement).
 */
object Vegetation {

    class Tree(
        val x: Double, var y: Double, val z: Double,
        val sxz: Double, val sy: Double, val yaw: Double,
        val kind: Int, val species: Int, val horizon: Boolean,
        val r: Double, val g: Double, val b: Double,
    ) {
        var alive = 1
    }

    class Result(val trees: List<Tree>, val canopy: FloatArray, val buildMs: Long)

    /** terrain/index.js groundInfo — the scatter's soil/rock/sand exclusions, from the control bake. */
    class GroundInfo(
        val h: Double, val slope: Double, val grass: Double, val dry: Double,
        val dirt: Double, val sand: Double, val rock: Double, val wet: Double,
        val forest: Double, val shoreD: Double,
    )

    fun groundInfo(
        hm: Heightmap, ctrl: ByteArray, ctrl2: ByteArray, res: Int,
        shore: ByteArray, x: Double, z: Double,
    ): GroundInfo {
        val ctrlStep = hm.size.toDouble() / res
        val i = ((x + hm.half) / ctrlStep).toInt().coerceIn(0, res - 1)
        val j = ((z + hm.half) / ctrlStep).toInt().coerceIn(0, res - 1)
        val k = (j * res + i) * 4
        val h = hm.getHeight(x, z)
        val slope = hm.getSlope(x, z)
        val dry = (ctrl[k].toInt() and 0xFF) / 255.0
        val dirt = (ctrl[k + 1].toInt() and 0xFF) / 255.0
        val sand0 = (ctrl[k + 2].toInt() and 0xFF) / 255.0
        val rockB = (ctrl[k + 3].toInt() and 0xFF) / 255.0
        val forest = (ctrl2[k].toInt() and 0xFF) / 255.0
        val hA = h - hm.waterLevel
        val shoreD = GroundControlShore.shoreAt(hm, shore, x, z)
        val highland = smoothstep(14.0, 42.0, hA)
        val cut = smoothstep(0.24, 0.40, slope) * (1.0 - highland)
        val rockSlope = smoothstep(0.19, 0.40, slope)
        val rock = max(rockSlope * GroundControl.lerp(0.62, 1.0, highland),
            max(rockB * smoothstep(0.06, 0.2, slope + rockB * 0.3), cut * 0.7))
        val dirtW = max(dirt, cut * 0.45 + smoothstep(0.12, 0.24, slope) * (1.0 - rockSlope) * 0.28)
        val wet = (1.0 - smoothstep(0.3, 2.0, shoreD)) * smoothstep(-6.0, -1.0, shoreD)
        val sandW = max(sand0, smoothstep(0.2, -1.6, shoreD) * 0.6) * (1.0 - smoothstep(0.10, 0.22, slope))
        val rest = max(0.0, 1.0 - wet * 0.55 - sandW * (1.0 - wet) - rock * (1.0 - wet - sandW * (1.0 - wet)))
        return GroundInfo(h, slope, rest * (1.0 - dirtW) * (1.0 - dry * 0.4), rest * dry, rest * dirtW,
            sandW, rock, wet, forest, shoreD)
    }

    /** Pinned crown widths per kind (kind = species × variant index, defs order in Vegetation.js).
     *  Used ONLY by canopyCoverage (the forest-floor splat driver); the real widths come out of
     *  the web's procedural branch builders and are ≈8-11 m broadleaf / ≈5-7 m conifer. */
    val KIND_WIDTHS = doubleArrayOf(
        9.2, 8.4, 10.0,   // oak-a, oak-b, oak-c
        9.6, 9.0, 9.4,    // birch-a, birch-b, birch-c
        5.6, 5.0, 6.4,    // spruce-a, spruce-b, pine-c
    )

    /** kindsBySpecies from the defs table: species 0 → kinds 0,1,2 · 1 → 3,4,5 · 2 → 6,7,8. */
    val KINDS_BY_SPECIES = arrayOf(intArrayOf(0, 1, 2), intArrayOf(3, 4, 5), intArrayOf(6, 7, 8))

    /**
     * The site's scatter (Vegetation.js `_distribute`): quality.density 1.0 (the demo's tier),
     * forestMask × Worley clumps → stands with edges and glades.
     *
     * @param forestMask the GroundControl.forestMask (x, z, h, slope) → 0..1
     * @param isBlocked extra blocker (roads) — null on native (roads clear via the demo grid)
     */
    fun distribute(
        hm: Heightmap,
        seed: Int,
        density: Double,
        half: Double,
        forestMask: (Double, Double, Double, Double) -> Double,
        groundInfoFn: (Double, Double) -> GroundInfo,
    ): List<Tree> {
        val t0 = System.nanoTime()
        val rng = Rng(hash2Signed(seed, 777))
        val clusterNoise = SimplexNoise(hash2Signed(seed, 909))
        val clumpSeed = hash2Signed(seed, 5151)
        val wl = hm.waterLevel
        val dens = density.coerceIn(0.3, 1.4)
        val spacing = 4.6 / sqrt(dens)
        val h0 = half - 6.0
        val trees = ArrayList<Tree>(4096)

        fun clump(px: Double, pz: Double): Double = worley(clumpSeed, px, pz, 46.0, 3) * worley(clumpSeed, px, pz, 15.0, 11)

        fun pushTree(px: Double, pz: Double, h: Double, slope: Double, p: Double, horizon: Boolean) {
            if (rng.next() > p) return
            val coniferP = (smoothstep(20.0, 70.0, h - wl) * 0.85 + 0.06 + 0.35 * clusterNoise.fbm2D(px / 190.0 + 4.0, pz / 190.0 - 9.0, 2)).coerceIn(0.0, 1.0)
            val species = if (rng.next() < coniferP) 2 else (if (rng.next() < 0.62) 0 else 1)
            val ks = KINDS_BY_SPECIES[species]
            val kind = ks[min(ks.size - 1, floor(rng.next() * ks.size).toInt())]
            val sxz = (1.0 + rng.gaussian() * 0.13).coerceIn(0.74, 1.32) * (if (horizon) 1.15 else 1.0)
            val sy = sxz * rng.range(0.9, 1.15)
            // per-instance colour: ±8° hue (warm ↔ cool), ±15 % value, a few autumn-tinged broadleaves
            val hueS = rng.range(-1.0, 1.0)
            val `val` = rng.range(0.85, 1.15)
            var r = `val` * (1.0 + 0.16 * hueS)
            var g = `val` * (1.0 + 0.02 * hueS)
            var b = `val` * (1.0 - 0.22 * hueS)
            if (species != 2 && rng.next() < 0.07) { r *= 1.18; g *= 0.96; b *= 0.68 }
            if (species == 2) { r *= 0.95; b *= 1.04 }
            trees.add(Tree(px, h - 0.12, pz, sxz, sy, rng.range(0.0, Math.PI * 2.0), kind, species, horizon, r, g, b))
        }

        // in-map trees (full LOD chain)
        var z = -h0
        while (z <= h0) {
            var x = -h0
            while (x <= h0) {
                val px = x + rng.range(-0.48, 0.48) * spacing
                val pz = z + rng.range(-0.48, 0.48) * spacing
                val h = hm.getHeight(px, pz)
                if (h >= wl + 1.6) {
                    val slope = hm.getSlope(px, pz)
                    if (slope <= 0.42) {
                        var p = forestMask(px, pz, h, slope)
                        if (p >= 0.01) {
                            val gi = groundInfoFn(px, pz)
                            if (gi.rock <= 0.35 && gi.sand <= 0.6) {
                                p *= 1.0 - smoothstep(0.28, 0.42, slope)
                                // trees ONLY live in stands / copses
                                val cl = clump(px, pz)
                                if (cl >= 0.62) {
                                    p *= 1.5 * GroundControl.lerp(0.18, 1.0, ((cl - 0.55) / 0.62).coerceIn(0.0, 1.0))
                                    pushTree(px, pz, h, slope, p, false)
                                }
                            }
                        }
                    }
                }
                x += spacing
            }
            z += spacing
        }
        // horizon ring (impostor only): coarser, from the 8 m outer grid
        val sp = 9.5
        val outerHalf = hm.half * 2.0 - 12.0 // CoarseGrid(8, half*2).half − 12
        var oz = -outerHalf
        while (oz <= outerHalf) {
            var ox = -outerHalf
            while (ox <= outerHalf) {
                if (abs(ox) < half + 2.0 && abs(oz) < half + 2.0) { ox += sp; continue }
                val px = ox + rng.range(-0.48, 0.48) * sp
                val pz = oz + rng.range(-0.48, 0.48) * sp
                val h = hm.outerHeight(px, pz)
                if (h >= wl + 1.6) {
                    val slope = hm.getSlopeAny(px, pz)
                    if (slope <= 0.4) {
                        val cl = clump(px, pz)
                        if (cl >= 0.62) {
                            val p0 = forestMask(px, pz, h, slope)
                            val p = p0 * 1.3 * (1.0 - smoothstep(0.28, 0.4, slope)) *
                                GroundControl.lerp(0.18, 1.0, ((cl - 0.55) / 0.62).coerceIn(0.0, 1.0))
                            pushTree(px, pz, h, slope, p, true)
                        }
                    }
                }
                ox += sp
            }
            oz += sp
        }
        return trees
    }

    /** One Worley octave: jittered cells, some empty (glades), rounded falloff to the cell edge. */
    fun worley(clumpSeed: Int, px: Double, pz: Double, C: Double, salt: Int): Double {
        val gx = floor(px / C).toInt()
        val gz = floor(pz / C).toInt()
        var best = Double.MAX_VALUE
        var bestH = 0
        for (j in -1..1) for (i in -1..1) {
            val cx = gx + i
            val cz = gz + j
            val hsh = hash2Signed(hash2Signed(hash2Signed(clumpSeed, salt), cx * 7919), cz * 104729)
            val sx = (cx + ((hsh.toLong() and 0xFFFFL).toDouble() / 65535.0)) * C
            val sz = (cz + (((hsh.toLong() ushr 16) and 0xFFFFL).toDouble() / 65535.0)) * C
            val dx = px - sx
            val dz = pz - sz
            val d = dx * dx + dz * dz
            if (d < best) { best = d; bestH = hsh }
        }
        best = sqrt(best)
        val dens = ((bestH.toLong() ushr 8) and 0xFFL).toDouble() / 255.0
        if (dens < 0.16) return 0.05                                       // glade
        val r = C * (0.52 + 0.44 * dens)
        val inside = 1.0 - smoothstep(r * 0.55, r, best)
        return min(1.25, (0.55 + 0.85 * dens) * (0.30 + 0.70 * inside))
    }

    /**
     * Crown coverage of the in-map trees on a res×res grid (0..1) — the forest-floor driver
     * (canopyCoverage port; pinned kind widths stand in for the procedural builders').
     */
    fun canopyCoverage(trees: List<Tree>, half: Double, res: Int): FloatArray {
        val out = FloatArray(res * res)
        val cell = (half * 2.0) / res
        for (t in trees) {
            if (t.alive == 0 || t.horizon) continue
            val r = KIND_WIDTHS[t.kind] * 0.5 * t.sxz * 1.15
            val i0 = max(0, floor((t.x - r + half) / cell).toInt())
            val i1 = min(res - 1, floor((t.x + r + half) / cell).toInt())
            val j0 = max(0, floor((t.z - r + half) / cell).toInt())
            val j1 = min(res - 1, floor((t.z + r + half) / cell).toInt())
            var j = j0
            while (j <= j1) {
                val dz = -half + (j + 0.5) * cell - t.z
                var i = i0
                while (i <= i1) {
                    val dx = -half + (i + 0.5) * cell - t.x
                    val d = v8Hypot(dx, dz) / r
                    if (d < 1.0) {
                        val k = j * res + i
                        out[k] = min(1.0f, out[k] + (0.7 * (1.0 - d * d)).toFloat())
                    }
                    i++
                }
                j++
            }
        }
        return out
    }

    private fun smoothstep(a: Double, b: Double, v: Double): Double {
        val t = ((v - a) / (b - a)).coerceIn(0.0, 1.0)
        return t * t * (3.0 - 2.0 * t)
    }

    // -------------------------------------------------------------------------------------------
    // Clearing (Vegetation.js lines 850-931) — trees removed individually, clearMask for the
    // undergrowth, a 32 m spatial grid over the in-map trees for fast queries. All ops are exact
    // ports (evaluation order and clamp semantics included) so the SAME trees die for the SAME edit.
    // -------------------------------------------------------------------------------------------

    /**
     * Mutable forest state: the distributed trees + the site's spatial grid and 4 m clear mask.
     * The renderer repacks its instance buffer from `trees` (skipping alive == 0) after each edit,
     * exactly like Vegetation.update() skips !t.alive when it writes instances.
     */
    class Forest(
        val trees: List<Tree>,
        val half: Double,
        private val hm: Heightmap,
    ) {
        val cell = 32
        val maskCell = 4
        val maskN = ceil((half * 2.0) / maskCell).toInt()
        val clearMask = ByteArray(maskN * maskN)
        private val grid = HashMap<Int, ArrayList<Int>>()
        var undergrowthDirty = true
            private set

        init {
            // spatial grid (32 m cells) for fast clearing (in-map only) — JS _distribute tail
            for ((i, t) in trees.withIndex()) {
                if (t.horizon) continue
                val k = cellKey(t.x, t.z)
                grid.getOrPut(k) { ArrayList() }.add(i)
            }
        }

        private fun cellKey(x: Double, z: Double): Int =
            (floor((x + half) / cell).toInt() shl 12) or floor((z + half) / cell).toInt()

        private fun forEachTreeIn(x0: Double, z0: Double, x1: Double, z1: Double, fn: (Tree) -> Unit) {
            val c0x = floor((x0 + half) / cell).toInt()
            val c1x = floor((x1 + half) / cell).toInt()
            val c0z = floor((z0 + half) / cell).toInt()
            val c1z = floor((z1 + half) / cell).toInt()
            for (cz in c0z..c1z) for (cx in c0x..c1x) {
                val a = grid[(cx shl 12) or cz] ?: continue
                for (i in a) fn(trees[i])
            }
        }

        private fun markMask(x0: Double, z0: Double, x1: Double, z1: Double, test: ((Double, Double) -> Boolean)?) {
            val n = maskN
            val c = maskCell
            val h = half
            val i0 = floor((x0 + h) / c).toInt().coerceIn(0, n - 1)
            val i1 = floor((x1 + h) / c).toInt().coerceIn(0, n - 1)
            val j0 = floor((z0 + h) / c).toInt().coerceIn(0, n - 1)
            val j1 = floor((z1 + h) / c).toInt().coerceIn(0, n - 1)
            for (j in j0..j1) for (i in i0..i1) {
                val x = -h + (i + 0.5) * c
                val z = -h + (j + 0.5) * c
                if (test == null || test(x, z)) clearMask[j * n + i] = 1
            }
            undergrowthDirty = true
        }

        /** True when undergrowth must not grow at (x,z) (roads, lots, service pads, flattened areas). */
        fun isCleared(x: Double, z: Double): Boolean {
            val i = floor((x + half) / maskCell).toInt()
            val j = floor((z + half) / maskCell).toInt()
            if (i < 0 || j < 0 || i >= maskN || j >= maskN) return false
            return clearMask[j * maskN + i].toInt() == 1
        }

        fun clearRect(x0: Double, z0: Double, x1: Double, z1: Double): Int {
            val ax = min(x0, x1); val bx = max(x0, x1); val az = min(z0, z1); val bz = max(z0, z1)
            var n = 0
            forEachTreeIn(ax, az, bx, bz) { t ->
                if (t.alive != 0 && t.x >= ax && t.x <= bx && t.z >= az && t.z <= bz) { t.alive = 0; n++ }
            }
            markMask(ax, az, bx, bz, null)
            return n
        }

        fun clearCircle(x: Double, z: Double, r: Double): Int {
            var n = 0
            val r2 = r * r
            forEachTreeIn(x - r, z - r, x + r, z + r) { t ->
                if (t.alive != 0 && (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z) <= r2) { t.alive = 0; n++ }
            }
            markMask(x - r, z - r, x + r, z + r) { px, pz ->
                (px - x) * (px - x) + (pz - z) * (pz - z) <= (r + 2) * (r + 2)
            }
            return n
        }

        /** Clear a yaw-rotated rectangle (building / service footprint) with a margin. */
        fun clearOriented(x: Double, z: Double, w: Double, d: Double, yaw: Double = 0.0, margin: Double = 0.0): Int {
            val hw = w / 2.0 + margin
            val hd = d / 2.0 + margin
            val c = cos(yaw); val s = sin(yaw)
            val r = hypot(hw, hd)
            val inside: (Double, Double) -> Boolean = { px, pz ->
                val dx = px - x; val dz = pz - z
                val lx = dx * c + dz * s
                val lz = -dx * s + dz * c
                abs(lx) <= hw && abs(lz) <= hd
            }
            var n = 0
            forEachTreeIn(x - r, z - r, x + r, z + r) { t ->
                if (t.alive != 0 && inside(t.x, t.z)) { t.alive = 0; n++ }
            }
            markMask(x - r, z - r, x + r, z + r, inside)
            return n
        }

        /** Clear trees along a polyline of [x, z] points with a total corridor width. */
        fun clearPolyline(points: List<DoubleArray>, width: Double): Int {
            val r = width / 2.0
            var n = 0
            for (i in 0 until points.size - 1) {
                val a = points[i]; val b = points[i + 1]
                val abx = b[0] - a[0]; val abz = b[1] - a[1]
                val len2 = abx * abx + abz * abz
                val len2s = if (len2 == 0.0) 1.0 else len2
                val minx = min(a[0], b[0]) - r; val maxx = max(a[0], b[0]) + r
                val minz = min(a[1], b[1]) - r; val maxz = max(a[1], b[1]) + r
                val distOk = { px: Double, pz: Double, rr: Double ->
                    val u = (((px - a[0]) * abx + (pz - a[1]) * abz) / len2s).coerceIn(0.0, 1.0)
                    val qx = px - (a[0] + abx * u)
                    val qz = pz - (a[1] + abz * u)
                    qx * qx + qz * qz <= rr * rr
                }
                forEachTreeIn(minx, minz, maxx, maxz) { t ->
                    if (t.alive != 0 && distOk(t.x, t.z, r)) { t.alive = 0; n++ }
                }
                markMask(minx, minz, maxx, maxz) { px, pz -> distOk(px, pz, r + 2) }
            }
            return n
        }

        /** Re-snap tree heights after a terrain edit inside a rect. */
        fun resnap(x0: Double, z0: Double, x1: Double, z1: Double) {
            forEachTreeIn(min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1)) { t ->
                t.y = hm.getHeight(t.x, t.z) - 0.12
            }
            undergrowthDirty = true
        }

        fun aliveCount(): Int { var n = 0; for (t in trees) n += t.alive; return n }
    }

    // -------------------------------------------------------------------------------------------
    // Undergrowth placement (Vegetation.js _updateUndergrowth, lines 1026-1113) — the camera-
    // focused 64 m turf patch. Bit-exact: per-cell rng chain hash2(hash2(seed, cx*73856093),
    // cz*19349663), the meadow/fern density model, the near-focus multiplier, the 8 atlas
    // variants with their size ranges and the ground-tint blend (55 % towards the mean albedo).
    // -------------------------------------------------------------------------------------------

    class UndergrowthInstance(
        val x: Double, val y: Double, val z: Double,
        val yaw: Double, val sx: Double, val sy: Double,
        val variant: Int, val r: Double, val g: Double, val b: Double,
    )

    class UndergrowthPatch(val instances: List<UndergrowthInstance>, val fx: Double, val fz: Double)

    /** Mean atlas tuft colour (sRGB) — the ground tint is expressed relative to it. */
    val TUFT_AVG = doubleArrayOf(0.24, 0.32, 0.16)

    /**
     * Build the turf patch around the focus point (fx, fz). Returns null when the camera is too
     * high (> 170 m — the web empties the mesh) or the patch is empty.
     */
    fun undergrowthPatch(
        hm: Heightmap,
        seed: Int,
        density: Double,
        half: Double,
        clusterNoise: SimplexNoise,
        groundInfoFn: (Double, Double) -> GroundInfo,
        groundTintFn: ((Double, Double, DoubleArray) -> Unit)?,
        isClearedFn: (Double, Double) -> Boolean,
        isBlockedFn: ((Double, Double) -> Boolean)?,
        fx: Double,
        fz: Double,
        camHeight: Double,
    ): UndergrowthPatch? {
        if (camHeight > 170.0) return null
        val cap = Math.round(52000.0 * density.coerceIn(0.5, 1.3)).toInt()
        val R = 64.0
        val cell = 8.0
        val out = ArrayList<UndergrowthInstance>(min(cap, 8192))
        val c0x = floor((fx - R) / cell).toInt()
        val c1x = floor((fx + R) / cell).toInt()
        val c0z = floor((fz - R) / cell).toInt()
        val c1z = floor((fz + R) / cell).toInt()
        val perCell = 96.0 * density
        val wl = hm.waterLevel
        var broke = false
        outer@ for (cz in c0z..c1z) for (cx in c0x..c1x) {
            val ccx = (cx + 0.5) * cell
            val ccz = (cz + 0.5) * cell
            val dFocus = v8Hypot(ccx - fx, ccz - fz)
            if (dFocus > R + 6) continue
            if (abs(ccx) > half || abs(ccz) > half) continue
            val rng = Rng(hash2Signed(hash2Signed(seed, cx * 73856093), cz * 19349663))
            val info = groundInfoFn(ccx, ccz)
            val cluster = smoothstep(-0.35, 0.45, clusterNoise.fbm2D(ccx / 19.0, ccz / 19.0, 2))
            val meadow = (info.grass + info.dry * 0.8) * (1.0 - smoothstep(0.25, 0.4, info.slope)) *
                (0.35 + 0.65 * cluster) * (1.0 - 0.85 * info.sand)
            val fern = info.forest * smoothstep(0.4, 0.8, info.forest) * (1.0 - smoothstep(0.3, 0.45, info.slope)) * 0.45
            // ~4x density close to the focus point, tapering to 1x at ~45 m
            val near = 1.0 + 7.0 * (1.0 - smoothstep(14.0, 55.0, dFocus))
            val nFern = jsRound(perCell * 0.35 * fern * near).toInt()
            val count = jsRound(perCell * meadow.coerceIn(0.0, 1.0) * near).toInt() + nFern
            if (count == 0) continue
            // ground tint → tuft colour multiplier (55 % towards the ground albedo)
            var mr = 1.0; var mg = 1.0; var mb = 1.0
            if (groundTintFn != null) {
                val tint = DoubleArray(3)
                groundTintFn(ccx, ccz, tint)
                mr = GroundControl.lerp(1.0, (tint[0] / TUFT_AVG[0]).coerceIn(0.78, 1.30), 0.55)
                mg = GroundControl.lerp(1.0, (tint[1] / TUFT_AVG[1]).coerceIn(0.78, 1.30), 0.55)
                mb = GroundControl.lerp(1.0, (tint[2] / TUFT_AVG[2]).coerceIn(0.78, 1.30), 0.55)
            }
            val dryFrac = info.dry / max(0.05, info.grass + info.dry)
            for (k in 0 until count) {
                val x = cx * cell + rng.next() * cell
                val z = cz * cell + rng.next() * cell
                val isFern = k < nFern
                val h = hm.getHeight(x, z)
                if (h < wl + 0.5) continue
                if (isClearedFn(x, z)) continue
                if (isBlockedFn != null && isBlockedFn(x, z)) continue
                val dryPick = rng.next() < dryFrac
                val u = rng.next()
                var v: Int; var sx: Double; var sy: Double
                // grass is TALLER than it is wide — upright tufts dominate the mix
                if (isFern) { v = 3; sx = rng.range(0.85, 1.45); sy = sx * rng.range(0.80, 1.15) }
                else if (u < 0.40) { v = if (dryPick) 2 else 0; sx = rng.range(0.30, 0.52); sy = rng.range(0.44, 0.86) }
                else if (u < 0.60) { v = 1; sx = rng.range(0.34, 0.60); sy = rng.range(0.52, 1.00) }
                else if (u < 0.82) { v = if (dryPick) 7 else 4; sx = rng.range(0.62, 1.10); sy = rng.range(0.24, 0.44) }
                else if (u < 0.90) { v = 5; sx = rng.range(0.34, 0.58); sy = rng.range(0.20, 0.34) }
                else { v = if (dryPick) 2 else 6; sx = rng.range(0.28, 0.50); sy = rng.range(0.40, 0.72) }
                val yaw = rng.range(0.0, Math.PI)
                val br = rng.range(0.66, 1.14) * (if (dryPick) 0.88 else 1.0)
                val hs = rng.range(-0.14, 0.14)
                val blend = if (isFern) 0.4 else 1.0
                out.add(UndergrowthInstance(
                    x, h - 0.07, z, yaw, sx, sy, v,
                    (br * (1 + hs) * GroundControl.lerp(1.0, mr, blend)).coerceIn(0.18, 1.25),
                    (br * (1 + hs * 0.15) * GroundControl.lerp(1.0, mg, blend)).coerceIn(0.18, 1.25),
                    (br * (1 - hs * 1.35) * GroundControl.lerp(1.0, mb, blend)).coerceIn(0.18, 1.25),
                ))
                if (out.size >= cap) { broke = true; break@outer }
            }
        }
        if (broke) return UndergrowthPatch(out.subList(0, cap), fx, fz)
        return UndergrowthPatch(out, fx, fz)
    }
}

/** Shore-distance helper shared with the ground bake (jsRound index like terrain/index.js). */
object GroundControlShore {
    fun shoreAt(hm: Heightmap, shore: ByteArray, x: Double, z: Double): Double {
        val i = jsRound((x + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        val j = jsRound((z + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        return ((shore[j * hm.N + i].toInt() and 0xFF) - 128) * 0.25
    }
}
