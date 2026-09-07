package com.fablecities.android.worldgen

import kotlin.math.ceil
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Bit-exact Kotlin port of the web game's src/modules/effects/PuddleField.js — standing water on
 * the road, built from the REAL road network. Water goes where water goes: the gutter (the outer
 * metre of the carriageway, where the camber drains) and the wheel ruts of each lane, as discrete
 * ellipses stretched ALONG the kerb — never blobs across the crown.
 *
 * Two products, from the same deterministic ellipse list, so they can never disagree:
 *  1. merged, feathered disc geometry (per-vertex ALPHA shore band, camber-following rims);
 *  2. a world-space RGBA drainage map (R pool, G ploughed tyre band, B road corridor) the shaders
 *     sample by world XZ, so the wet-road mirror sharpens exactly where the pools are and the snow
 *     tyre tracks follow the real lanes.
 *
 * Everything is seeded from the segment id + world seed (FNV-1a of the id XOR seed XOR 0x9d2b,
 * mulberry32), so a given seed always produces the same puddles. Ported to the JVM in the exact
 * evaluation order of the JS original; pinned by PuddleParityTest against the real module in Node.
 */
object PuddleField {

    /** Ring segments per puddle disc (a 3 m pool is ~10 px across at 120 m — 8 is plenty). */
    const val RING = 8
    /** Triangle budget guard: the demo city has ~15 km of kerb, more pools than a frame needs. */
    const val MAX_POOLS = 2800
    /** Alpha stays 1 out to this fraction of the radius, then falls to 0 — the shore band. */
    const val CORE = 0.84
    /** How high the water film sits over the asphalt (metres). */
    const val LIFT = 0.022
    /** Map texel size in metres (upper bound; the map is capped at MAP_MAX texels a side). */
    const val TEXEL = 0.6
    const val MAP_MAX = 2048

    /** The puddle-relevant half of the web's roads/RoadTypes.js definitions. */
    class RoadDef(val cwHalf: Double, val medianHalf: Double, val laneWidth: Double, val sidewalk: Double)

    val TYPES: Map<String, RoadDef> = mapOf(
        "local" to RoadDef(3.8, 0.0, 3.8, 2.0),
        "avenue" to RoadDef(9.0, 1.5, 3.75, 2.8),
        "highway" to RoadDef(15.4, 1.6, 3.5, 0.0),
        "path" to RoadDef(1.2, 0.0, 1.2, 0.0),
    )

    /** One road centre-line polyline: [x0, z0, x1, z1, ...] in metres. */
    class SegIn(val id: String, val type: String, val width: Double, val pts: DoubleArray)

    class Pool(
        val x: Double, val z: Double, val tx: Double, val tz: Double,
        val ra: Double, val rb: Double, val str: Double,
        var y: Double = 0.0, var slope: Double = 0.0,
    )

    class Result(
        val pools: List<Pool>,
        val mapSize: Int,
        val mapX0: Double,
        val mapZ0: Double,
        val mapSpan: Double,
        /** RGBA8 raster: R pool, G tyre band, B corridor, A 255. */
        val mapData: ByteArray,
        /** Interleaved puddle-disc vertices: x, y, z, alpha (4 floats per vertex). */
        val verts: FloatArray,
        val indices: IntArray,
        val buildMs: Long,
        val lastBuildSegs: Int,
    )

    /** FNV-1a of the segment id — the web's shared/random.js hashString. */
    fun fnv(s: String): Int {
        var h = 2166136261.toInt()
        for (ch in s) { h = h xor ch.code; h *= 16777619 }
        return h
    }

    /**
     * Rebuild from the road network. Safe to call with an empty network (returns null).
     * `surfaceHeight` returns the cambered asphalt height (null when off-road); when absent the
     * terrain height + 0.05 stands in, exactly like the web fallback.
     */
    fun build(
        segs: List<SegIn>,
        seed: Int,
        surfaceHeight: ((Double, Double) -> Double?)? = null,
        terrainH: ((Double, Double) -> Double)? = null,
    ): Result? {
        val t0 = System.nanoTime()
        if (segs.isEmpty()) return null

        // ---- 1. bounds ----
        var x0 = Double.MAX_VALUE; var x1 = -Double.MAX_VALUE
        var z0 = Double.MAX_VALUE; var z1 = -Double.MAX_VALUE
        for (s in segs) {
            var i = 0
            while (i + 1 < s.pts.size) {
                val px = s.pts[i]; val pz = s.pts[i + 1]
                if (px < x0) x0 = px; if (px > x1) x1 = px
                if (pz < z0) z0 = pz; if (pz > z1) z1 = pz
                i += 2
            }
        }
        if (x0 == Double.MAX_VALUE) return null
        val pad = 24.0
        x0 -= pad; z0 -= pad; x1 += pad; z1 += pad
        val span = max(x1 - x0, z1 - z0)
        val size = min(MAP_MAX, max(256, 1 shl ceilLog2(span / TEXEL)))
        val texel = span / size

        // ---- 2. drainage map raster ----
        val data = ByteArray(size * size * 4)
        fun put(x: Double, z: Double, ch: Int, v: Double) {
            val ix = ((x - x0) / span * size).toInt()
            val iz = ((z - z0) / span * size).toInt()
            if (ix < 0 || iz < 0 || ix >= size || iz >= size) return
            val o = (iz * size + ix) * 4 + ch
            val b = v * 255.0
            if (b > (data[o].toInt() and 0xFF)) data[o] = b.toInt().toByte()
        }

        // ---- 3. walk every segment: pools in the gutters and wheel ruts, tyre bands, corridor mask ----
        val ell = ArrayList<Pool>(512)
        val step = max(0.45, texel * 0.75)

        for (seg in segs) {
            val pts = seg.pts
            if (pts.size < 4) continue
            val def = TYPES[seg.type]
            val cwHalf = def?.cwHalf ?: max(2.0, (if (seg.width != 0.0) seg.width else 12.0) * 0.34)
            if (cwHalf < 1.6) continue                                // footpaths do not pond
            val medianHalf = def?.medianHalf ?: 0.0
            val laneW = def?.laneWidth ?: 3.6
            val sw = def?.sidewalk ?: 1.6
            val corridor = cwHalf + sw + 1.2
            // wheel ruts: one pair per lane, 1.7 m apart, centred on the lane
            val ruts = ArrayList<Double>(8)
            var i = 0
            while (true) {
                val c = medianHalf + laneW * (i + 0.5)
                if (c + 0.9 > cwHalf) break
                ruts.add(c - 0.85); ruts.add(c + 0.85)
                if (i > 6) break
                i++
            }
            val rng = Rng(fnv(seg.id) xor seed xor 0x9d2b)

            // arc-length walk
            var carry = rng.range(2.0, 11.0)                          // distance to the next gutter pool
            var carryRut = rng.range(6.0, 26.0)
            // JS: for (let i = 0; i < pts.length - 1; i++) over point pairs [a, b]
            var pi = 0
            while (pi + 3 < pts.size) {
                val ax = pts[pi]; val az = pts[pi + 1]
                val bx = pts[pi + 2]; val bz = pts[pi + 3]
                var dx = bx - ax; var dz = bz - az
                val len = v8Hypot(dx, dz)
                if (len < 1e-4) { pi += 2; continue }
                dx /= len; dz /= len
                val nx = -dz; val nz = dx                             // right-hand normal

                // --- raster: corridor + tyre bands, marched along this span ---
                var s = 0.0
                while (s < len) {
                    val px = ax + dx * s; val pz = az + dz * s
                    var lat = -corridor
                    while (lat <= corridor) {
                        val wx = px + nx * lat; val wz = pz + nz * lat
                        put(wx, wz, 2, 1.0)                            // B: road corridor
                        val al = kotlin.math.abs(lat)
                        if (al <= cwHalf) {
                            var band = 0.0
                            for (r in ruts.indices) {
                                val b2 = 1.0 - kotlin.math.abs(al - ruts[r]) / 0.95
                                if (b2 > band) band = b2
                            }
                            if (band > 0.0) put(wx, wz, 1, min(1.0, band))   // G: ploughed tyre band
                        }
                        lat += step
                    }
                    s += step
                }

                // --- gutter pools: long, thin, hugging the kerb (the camber drains here) ---
                var gs = carry
                while (gs < len) {
                    val side = if (rng.next() < 0.5) -1.0 else 1.0
                    val lat = side * (cwHalf - 0.35 - rng.range(0.0, 0.75))
                    val ra = rng.range(1.5, 4.4)                       // along the kerb
                    val rb = min(rng.range(0.65, 1.55), cwHalf * 0.34)
                    val px = ax + dx * gs + nx * lat; val pz = az + dz * gs + nz * lat
                    ell.add(Pool(px, pz, dx, dz, ra, rb, rng.range(0.85, 1.0)))
                    gs += rng.range(5.0, 15.0)
                }
                carry = gs - len

                // --- rut pools: shorter, in the wheel tracks, only where the ruts exist ---
                if (ruts.isNotEmpty()) {
                    var t = carryRut
                    while (t < len) {
                        val r = ruts[(rng.next() * ruts.size).toInt()]
                        val side = if (rng.next() < 0.5) -1.0 else 1.0
                        val lat = side * r
                        val ra = rng.range(1.0, 3.0)
                        val rb = rng.range(0.4, 0.85)
                        val px = ax + dx * t + nx * lat; val pz = az + dz * t + nz * lat
                        ell.add(Pool(px, pz, dx, dz, ra, rb, rng.range(0.6, 0.9)))
                        t += rng.range(9.0, 26.0)
                    }
                    carryRut = t - len
                }
                pi += 2
            }
        }

        // ---- 4. lift every pool onto the cambered asphalt and drop the ones off-road ----
        val keep = ArrayList<Pool>(ell.size)
        for (e in ell) {
            if (keep.size >= MAX_POOLS) break
            var y: Double? = null
            if (surfaceHeight != null) {
                try { y = surfaceHeight(e.x, e.z) } catch (_: Exception) { y = null }
            }
            if (y == null || !y.isFinite()) y = terrainH?.invoke(e.x, e.z)?.plus(0.05)
            if (y == null || !y.isFinite()) continue
            e.y = y + LIFT
            // Camber ramp: two extra probes across the road give the whole disc its slope.
            e.slope = 0.0
            if (surfaceHeight != null) {
                val nx = -e.tz; val nz = e.tx; val o = max(0.5, e.rb)
                var hp: Double? = null; var hm2: Double? = null
                try { hp = surfaceHeight(e.x + nx * o, e.z + nz * o); hm2 = surfaceHeight(e.x - nx * o, e.z - nz * o) } catch (_: Exception) { /* off road */ }
                if (hp != null && hm2 != null && hp.isFinite() && hm2.isFinite()) e.slope = (hp - hm2) / (2.0 * o)
            }
            keep.add(e)
            // R: the pool itself, into the drainage map
            val r = max(e.ra, e.rb)
            val stamp = max(0.35, texel * 0.9)
            var ox = -r
            while (ox <= r) {
                var oz = -r
                while (oz <= r) {
                    val u = (ox * e.tx + oz * e.tz) / e.ra
                    val v = (-ox * e.tz + oz * e.tx) / e.rb
                    val d = sqrt(u * u + v * v)
                    if (d <= 1.05) put(e.x + ox, e.z + oz, 0, e.str * min(1.0, 1.3 - d * 0.9))
                    oz += stamp
                }
                ox += stamp
            }
        }

        // ---- 5. publish the map ----
        var di = 3
        while (di < data.size) { data[di] = 255.toByte(); di += 4 }

        // ---- 6. merged disc geometry ----
        val perV = 1 + RING * 2
        val perI = RING * 3
        val verts = FloatArray(keep.size * perV * 4)
        val idx = IntArray(keep.size * perI * 3)
        var vo = 0
        var io = 0
        for (e in keep) {
            val base = vo
            // centre
            verts[vo * 4] = e.x.toFloat(); verts[vo * 4 + 1] = e.y.toFloat(); verts[vo * 4 + 2] = e.z.toFloat()
            verts[vo * 4 + 3] = 1f
            vo++
            for (ring in 0 until 2) {
                val k = if (ring == 0) CORE else 1.0
                val alpha = if (ring == 0) 1f else 0f
                for (ri in 0 until RING) {
                    val th = (ri.toDouble() / RING) * Math.PI * 2.0
                    val u = kotlin.math.cos(th) * e.ra * k
                    val v = kotlin.math.sin(th) * e.rb * k
                    val vx = e.x + u * e.tx - v * e.tz
                    val vz = e.z + u * e.tz + v * e.tx
                    verts[vo * 4] = vx.toFloat()
                    verts[vo * 4 + 1] = (e.y + e.slope * v).toFloat()
                    verts[vo * 4 + 2] = vz.toFloat()
                    verts[vo * 4 + 3] = alpha
                    vo++
                }
            }
            val r0 = base + 1
            val r1 = base + 1 + RING
            for (ri in 0 until RING) {
                val j = (ri + 1) % RING
                idx[io++] = base; idx[io++] = r0 + j; idx[io++] = r0 + ri      // core fan
                idx[io++] = r0 + ri; idx[io++] = r0 + j; idx[io++] = r1 + j    // shore
                idx[io++] = r0 + ri; idx[io++] = r1 + j; idx[io++] = r1 + ri
            }
        }
        return Result(keep, size, x0, z0, span, data, verts, idx,
            (System.nanoTime() - t0) / 1_000_000L, segs.size)
    }

    /** Smallest k with 2^k >= v — mirrors Math.min(MAP_MAX, Math.max(256, 1 << Math.ceil(Math.log2(v)))). */
    private fun ceilLog2(v: Double): Int {
        if (v <= 1.0) return 0
        var k = 0
        var p = 1L
        while (p < v) { p = p shl 1; k++ }
        return k
    }
}
