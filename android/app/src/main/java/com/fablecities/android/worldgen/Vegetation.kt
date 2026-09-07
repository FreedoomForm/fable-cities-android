package com.fablecities.android.worldgen

import kotlin.math.abs
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
        val x: Double, val y: Double, val z: Double,
        val sxz: Double, val sy: Double, val yaw: Double,
        val kind: Int, val species: Int, val horizon: Boolean,
        val r: Double, val g: Double, val b: Double,
    ) { var alive = 1 }

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
}

/** Shore-distance helper shared with the ground bake (jsRound index like terrain/index.js). */
object GroundControlShore {
    fun shoreAt(hm: Heightmap, shore: ByteArray, x: Double, z: Double): Double {
        val i = jsRound((x + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        val j = jsRound((z + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        return ((shore[j * hm.N + i].toInt() and 0xFF) - 128) * 0.25
    }
}
