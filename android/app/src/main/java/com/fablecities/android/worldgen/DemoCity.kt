package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin

/**
 * Demo city layout — a Kotlin port of the browser game's src/demo/DemoCity.js site picker,
 * shoreline profile and street network (motorway + trumpet interchange, downtown grid, coastal
 * boulevards, esplanade, suburban crescents, industrial estate). The SAME seed finds the SAME
 * site and lays out the SAME streets: the local frame is fitted to the shoreline, +v points out
 * to sea, +u runs along the shore.
 *
 * Terrain editing uses the already-ported Heightmap.conformPath (the same mechanism the web
 * roads module drives). Buildings are preview boxes per city block (the full zoning/building
 * module port replaces them later); landmark/civic/park blocks follow the web's block plan.
 */
class DemoCity(private val hm: Heightmap, private val seed: Int = 1337) {

    // ---------------------------------------------------------------- site picking (verbatim port)

    class Site(
        val cx: Double, val cz: Double,
        val ux: Double, val uz: Double,
        val vx: Double, val vz: Double,
        val shoreDist: Double,
    )

    val site: Site = pickSite()

    private fun inBounds(x: Double, z: Double): Boolean = abs(x) < WORLD_HALF && abs(z) < WORLD_HALF
    private fun isWater(x: Double, z: Double): Boolean = hm.getHeight(x, z) < 0.0

    private fun marchToWater(x: Double, z: Double, dx: Double, dz: Double, maxR: Double, step: Double): Double? {
        var r = step
        while (r <= maxR) {
            val px = x + dx * r
            val pz = z + dz * r
            if (!inBounds(px, pz)) return null
            if (isWater(px, pz)) return r
            r += step
        }
        return null
    }

    private fun nearestWater(x: Double, z: Double, maxR: Double, step: Double): DoubleArray? {
        var best = Double.POSITIVE_INFINITY
        var bdx = 0.0
        var bdz = 0.0
        for (a in 0 until 32) {
            val th = (a.toDouble() / 32.0) * PI * 2.0
            val dx = cos(th)
            val dz = sin(th)
            val d = marchToWater(x, z, dx, dz, maxR, step)
            if (d != null && d < best) { best = d; bdx = dx; bdz = dz }
        }
        return if (best == Double.POSITIVE_INFINITY) null else doubleArrayOf(best, bdx, bdz)
    }

    private fun scoreSite(x: Double, z: Double): DoubleArray? {
        if (!inBounds(x, z)) return null
        val nw = nearestWater(x, z, 1150.0, 40.0)
        var vx: Double
        var vz: Double
        var shoreDist: Double
        if (nw != null) { vx = nw[1]; vz = nw[2]; shoreDist = nw[0] } else { vx = 0.0; vz = 1.0; shoreDist = 1400.0 }
        if (nw != null) {
            val ux0 = vz
            val uz0 = -vx
            var n = 0.0; var su = 0.0; var sd = 0.0; var suu = 0.0; var sud = 0.0
            var u = -420.0
            while (u <= 420.0) {
                val ox = x + ux0 * u
                val oz = z + uz0 * u
                val d = marchToWater(ox, oz, vx, vz, 1150.0, 24.0)
                if (d != null) {
                    n++; su += u; sd += d; suu += u * u; sud += u * d
                }
                u += 84.0
            }
            if (n >= 4.0) {
                val den = n * suu - su * su
                val slope = if (abs(den) > 1e-6) (n * sud - su * sd) / den else 0.0
                val a = atan(clamp(slope, -1.2, 1.2))
                val c = cos(a); val s = sin(a)
                val nvx = vx * c - vz * s
                val nvz = vx * s + vz * c
                vx = nvx; vz = nvz
                shoreDist = (sd / n) * cos(a)
            }
        }
        val len = hypot(vx, vz)
        val lvx = vx / (if (len == 0.0) 1.0 else len)
        val lvz = vz / (if (len == 0.0) 1.0 else len)
        vx = lvx; vz = lvz
        val ux = vz
        val uz = -vx

        var rough = 0.0; var wet = 0.0; var oob = 0.0; var n = 0.0
        val vTop = min(shoreDist - 60.0, 620.0)
        var u = -820.0
        while (u <= 820.0) {
            var v = -1080.0
            while (v <= vTop) {
                val px = x + ux * u + vx * v
                val pz = z + uz * u + vz * v
                val w = if (abs(u) < 560.0 && v > -740.0 && v < vTop) 2.4 else 1.0
                n += 1.0
                if (!inBounds(px, pz)) { oob += w; v += 100.0; continue }
                val h = hm.getHeight(px, pz)
                val dh = abs(hm.getHeight(px + 34.0, pz) - h) + abs(hm.getHeight(px, pz + 34.0) - h)
                rough += dh * w
                if (isWater(px, pz)) { wet += w; v += 100.0; continue }
                v += 100.0
            }
            u += 100.0
        }
        val shorePref = if (shoreDist > 1200.0) -70.0 else -abs(shoreDist - 430.0) * 0.055
        val score = -(rough / n) * 3.4 - (wet / n) * 900.0 - (oob / n) * 2600.0 + shorePref - hypot(x, z) / 1400.0
        return doubleArrayOf(x, z, ux, uz, vx, vz, shoreDist, score)
    }

    private fun pickSite(): Site {
        val r = min(700.0, WORLD_HALF * 0.70)
        var best = Double.NEGATIVE_INFINITY
        var bestSite: DoubleArray? = null
        var x = -r
        while (x <= r) {
            var z = -r
            while (z <= r) {
                val s = scoreSite(x, z)
                if (s != null && s[7] > best) { best = s[7]; bestSite = s }
                z += 104.0
            }
            x += 104.0
        }
        if (bestSite != null) {
            val b0 = bestSite[0]
            val b1 = bestSite[1]
            var rx = b0 - 78.0
            while (rx <= b0 + 78.0) {
                var rz = b1 - 78.0
                while (rz <= b1 + 78.0) {
                    val s = scoreSite(rx, rz)
                    if (s != null && s[7] > best) { best = s[7]; bestSite = s }
                    rz += 39.0
                }
                rx += 39.0
            }
        }
        val b = bestSite ?: return Site(0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 600.0)
        return Site(b[0], b[1], b[2], b[3], b[4], b[5], b[6])
    }

    // ---------------------------------------------------------------- shoreline profile

    inner class Shore {
        val minV: Double
        private val sm = DoubleArray(SHORE_N)

        init {
            val raw = DoubleArray(SHORE_N) { Double.POSITIVE_INFINITY }
            for (i in 0 until SHORE_N) {
                val u = SHORE_U0 + i * SHORE_STEP
                var hit = Double.POSITIVE_INFINITY
                var v = max(60.0, site.shoreDist - 420.0)
                while (v <= site.shoreDist + 620.0) {
                    val p = L(u, v)
                    if (!inBounds(p[0], p[1])) break
                    if (isWater(p[0], p[1])) { hit = v; break }
                    v += 10.0
                }
                raw[i] = hit
            }
            for (i in 0 until SHORE_N) {
                var s = 0.0
                var w = 0.0
                for (k in -2..2) {
                    val j = i + k
                    if (j < 0 || j >= SHORE_N || raw[j] == Double.POSITIVE_INFINITY) continue
                    val wk = 1.0 / (1.0 + abs(k))
                    s += raw[j] * wk
                    w += wk
                }
                sm[i] = if (w > 0.0 && raw[i] != Double.POSITIVE_INFINITY) s / w else Double.POSITIVE_INFINITY
            }
            var mv = Double.POSITIVE_INFINITY
            for (i in 0 until SHORE_N) {
                val u = SHORE_U0 + i * SHORE_STEP
                if (u < -560.0 || u > 560.0) continue
                if (sm[i] != Double.POSITIVE_INFINITY) mv = min(mv, sm[i])
            }
            if (mv == Double.POSITIVE_INFINITY) mv = if (site.shoreDist != Double.POSITIVE_INFINITY) site.shoreDist else 600.0
            minV = mv
        }

        fun at(u: Double): Double {
            val fi = (u - SHORE_U0) / SHORE_STEP
            val i = round(fi).toInt()
            if (i < 0 || i >= SHORE_N) return Double.POSITIVE_INFINITY
            return sm[i]
        }
    }

    val shore: Shore = Shore()

    // ---------------------------------------------------------------- local frame + layout constants

    fun L(u: Double, v: Double): DoubleArray = doubleArrayOf(
        site.cx + site.ux * u + site.vx * v,
        site.cz + site.uz * u + site.vz * v,
    )

    val DT = 88
    val COLS: DoubleArray = DoubleArray(13) { ((it - 6) * DT).toDouble() }
    val ROWS: DoubleArray = DoubleArray(8) { (-(it * DT)).toDouble() }
    val COAST_V: Double = clamp(round(shore.minV - 54.0), -220.0, 620.0)
    val CORE_V: Double = COAST_V + ROWS[2]
    val GRID_U0: Double = COLS[0]
    val GRID_U1: Double = COLS[COLS.size - 1]
    val GRID_V0: Double = ROWS[ROWS.size - 1]
    val HW_V: Double = COAST_V + GRID_V0 - 300.0
    val IND_U0 = 190.0
    val IND_U1 = 720.0
    val IND_V0 = HW_V + 96.0
    val IND_V1 = HW_V + 300.0

    val AVENUE_COLS = setOf(-3 * DT, 0.0, 3 * DT)
    val AVENUE_ROWS = setOf(0, 2)
    val CIVIC = mapOf(
        "4,1" to "police", "8,4" to "fire", "3,3" to "health", "9,2" to "education",
        "1,5" to "education", "6,5" to "fire", "10,0" to "water", "2,1" to "health",
        "7,3" to "police", "5,6" to "education", "11,4" to "health", "0,2" to "education",
        "1,0" to "police", "10,6" to "fire",
    )
    val PARKS = setOf("5,1", "8,2", "2,3", "9,5")
    val SITE_BLOCK = "2,2"
    val LANDMARK = mapOf(
        "6,1" to "tower_deco", "5,2" to "tower_twin", "7,2" to "tower_round",
        "4,2" to "townhall", "6,4" to "cathedral",
    )

    private fun clamp(v: Double, a: Double, b: Double): Double = if (v < a) a else if (v > b) b else v

    /** Land use mix (verbatim zoneFor). Returns the zone id used by the preview blocks. */
    fun zoneFor(u: Double, dv: Double, rng: Rng): Int {
        val r = hypot(u * 0.80, dv * 1.06)
        return when {
            r < 150.0 -> if (rng.chance(0.44)) Z_OFFICE else Z_COM_HIGH
            r < 285.0 -> if (rng.chance(0.24)) Z_OFFICE else (if (rng.chance(0.42)) Z_COM_HIGH else Z_RES_HIGH)
            r < 430.0 -> if (rng.chance(0.88)) Z_RES_HIGH else Z_COM_LOW
            r < 560.0 -> if (rng.chance(0.84)) Z_RES_HIGH else (if (rng.chance(0.6)) Z_RES_LOW else Z_COM_LOW)
            else -> if (rng.chance(0.62)) Z_RES_HIGH else (if (rng.chance(0.72)) Z_RES_LOW else Z_COM_LOW)
        }
    }

    companion object {
        const val WORLD_HALF = 1024.0
        private const val SHORE_U0 = -1000.0
        private const val SHORE_STEP = 25.0
        private const val SHORE_N = 81
        private const val MARGIN = 48.0
        const val Z_RES_LOW = 0
        const val Z_RES_HIGH = 1
        const val Z_COM_LOW = 2
        const val Z_COM_HIGH = 3
        const val Z_OFFICE = 4
        const val Z_SERVICE = 5
        const val Z_LANDMARK = 6

        // half carriageway widths per road type (metres)
        fun halfWidth(type: String): Float = when (type) {
            "highway" -> 15f
            "avenue" -> 11f
            "local" -> 8f
            else -> 3.5f // path
        }
    }

    // ---------------------------------------------------------------- street network

    class RoadPoly(val type: String, val uv: List<DoubleArray>, val bezier: Boolean) {
        val world: ArrayList<DoubleArray> = ArrayList() // dense [x, z] after clipping + resampling
    }

    val roads = ArrayList<RoadPoly>()

    private fun insideMargin(p: DoubleArray): Boolean =
        p[0] > -WORLD_HALF + MARGIN && p[0] < WORLD_HALF - MARGIN && p[1] > -WORLD_HALF + MARGIN && p[1] < WORLD_HALF - MARGIN

    /** Catmull-Rom resample through the control points (stands in for the web's bezier curves). */
    private fun resample(pts: List<DoubleArray>, perSeg: Int): List<DoubleArray> {
        if (pts.size < 3) return pts
        val out = ArrayList<DoubleArray>(pts.size * perSeg)
        for (s in 0 until pts.size - 1) {
            val p0 = pts[max(s - 1, 0)]
            val p1 = pts[s]
            val p2 = pts[s + 1]
            val p3 = pts[min(s + 2, pts.size - 1)]
            for (k in 0 until perSeg) {
                val t = k.toDouble() / perSeg
                val t2 = t * t
                val t3 = t2 * t
                val x = 0.5 * ((2.0 * p1[0]) + (-p0[0] + p2[0]) * t + (2.0 * p0[0] - 5.0 * p1[0] + 4.0 * p2[0] - p3[0]) * t2 + (-p0[0] + 3.0 * p1[0] - 3.0 * p2[0] + p3[0]) * t3)
                val z = 0.5 * ((2.0 * p1[1]) + (-p0[1] + p2[1]) * t + (2.0 * p0[1] - 5.0 * p1[1] + 4.0 * p2[1] - p3[1]) * t2 + (-p0[1] + 3.0 * p1[1] - 3.0 * p2[1] + p3[1]) * t3)
                out.add(doubleArrayOf(x, z))
            }
        }
        out.add(pts[pts.size - 1])
        return out
    }

    private fun buildRoad(type: String, uvPts: List<DoubleArray>, bezier: Boolean = false) {
        // map to world, clip to the longest in-bounds run (margin M=48)
        val w3 = uvPts.map { L(it[0], it[1]) }
        var bs = -1
        var bl = 0
        var s = -1
        for (i in 0..w3.size) {
            if (i < w3.size && insideMargin(w3[i])) { if (s < 0) s = i; continue }
            if (s >= 0 && i - s > bl) { bl = i - s; bs = s }
            s = -1
        }
        if (bl < 2) return
        val run = w3.subList(bs, bs + bl)
        val dense = if (bezier) resample(run, 12) else run
        val poly = RoadPoly(type, uvPts, bezier)
        for (p in dense) poly.world.add(doubleArrayOf(p[0], p[1]))
        roads.add(poly)
    }

    /** Port of the demo street network build list. */
    fun buildStreets() {
        // motorway across the inland edge with a gentle S
        val hwPts = listOf(
            doubleArrayOf(-620.0, HW_V - 26.0), doubleArrayOf(-380.0, HW_V + 14.0), doubleArrayOf(-120.0, HW_V + 4.0),
            doubleArrayOf(300.0, HW_V - 10.0), doubleArrayOf(560.0, HW_V + 16.0), doubleArrayOf(760.0, HW_V - 6.0),
        )
        buildRoad("highway", hwPts, bezier = true)

        // avenue spine: interchange → downtown boulevard
        buildRoad("avenue", listOf(doubleArrayOf(0.0, HW_V + 210.0), doubleArrayOf(0.0, COAST_V)))

        // trumpet interchange: four slip roads
        buildRoad("local", listOf(
            doubleArrayOf(0.0, HW_V + 186.0), doubleArrayOf(96.0, HW_V + 150.0), doubleArrayOf(210.0, HW_V + 62.0),
            doubleArrayOf(330.0, HW_V + 20.0), doubleArrayOf(470.0, HW_V + 4.0)), bezier = true)
        buildRoad("local", listOf(
            doubleArrayOf(-470.0, HW_V + 2.0), doubleArrayOf(-330.0, HW_V + 22.0), doubleArrayOf(-206.0, HW_V + 64.0),
            doubleArrayOf(-92.0, HW_V + 152.0), doubleArrayOf(0.0, HW_V + 186.0)), bezier = true)
        buildRoad("local", listOf(
            doubleArrayOf(0.0, HW_V + 128.0), doubleArrayOf(-120.0, HW_V + 116.0), doubleArrayOf(-196.0, HW_V + 44.0),
            doubleArrayOf(-150.0, HW_V + 4.0)), bezier = true)
        buildRoad("local", listOf(
            doubleArrayOf(0.0, HW_V + 128.0), doubleArrayOf(132.0, HW_V + 120.0), doubleArrayOf(214.0, HW_V + 48.0),
            doubleArrayOf(168.0, HW_V + 4.0)), bezier = true)

        // the main grid
        for (j in ROWS.indices) {
            val v = COAST_V + ROWS[j]
            val type = if (AVENUE_ROWS.contains(j)) "avenue" else "local"
            val pad = if (AVENUE_ROWS.contains(j)) 108.0 else 0.0
            buildRoad(type, listOf(doubleArrayOf(GRID_U0 - pad, v), doubleArrayOf(0.0, v), doubleArrayOf(GRID_U1 + pad, v)))
        }
        for (u in COLS) {
            if (AVENUE_COLS.contains(u)) continue
            val vTop = COAST_V + (if (abs(u) > 380.0) ROWS[1] else ROWS[0])
            buildRoad("local", listOf(doubleArrayOf(u, vTop), doubleArrayOf(u, COAST_V + GRID_V0)))
        }

        // coastal boulevard continues past the grid, curving with the bay
        val boulW = ArrayList<DoubleArray>()
        val boulE = ArrayList<DoubleArray>()
        var uw = GRID_U0 - 108.0
        while (uw >= GRID_U0 - 430.0) {
            boulW.add(doubleArrayOf(uw, COAST_V - 8.0 - (GRID_U0 - 108.0 - uw) * 0.06))
            uw -= 108.0
        }
        var ue = GRID_U1 + 108.0
        while (ue <= GRID_U1 + 430.0) {
            boulE.add(doubleArrayOf(ue, COAST_V - 8.0 - (ue - GRID_U1 - 108.0) * 0.06))
            ue += 108.0
        }
        if (boulW.isNotEmpty()) buildRoad("avenue", listOf(doubleArrayOf(GRID_U0 - 108.0, COAST_V)) + boulW, bezier = true)
        if (boulE.isNotEmpty()) buildRoad("avenue", listOf(doubleArrayOf(GRID_U1 + 108.0, COAST_V)) + boulE, bezier = true)

        // esplanade following the shoreline + cross streets
        val esplV = fun(u: Double): Double {
            val sv = shore.at(u)
            return if (sv != Double.POSITIVE_INFINITY) min(sv - 48.0, COAST_V + 300.0) else Double.NaN
        }
        var espl = ArrayList<DoubleArray>()
        fun flushEspl() { if (espl.size > 2) buildRoad("avenue", espl, bezier = true); espl = ArrayList() }
        var eu = GRID_U0 - 70.0
        while (eu <= GRID_U1 + 70.0) {
            val ev = esplV(eu)
            if (ev.isNaN() || ev < COAST_V + 76.0) flushEspl() else espl.add(doubleArrayOf(eu, ev))
            eu += 64.0
        }
        flushEspl()
        var cu = GRID_U0 + DT
        while (cu <= GRID_U1) {
            val ev = esplV(cu)
            if (!ev.isNaN() && ev >= COAST_V + 76.0) buildRoad("local", listOf(doubleArrayOf(cu, COAST_V), doubleArrayOf(cu, ev)))
            cu += DT
        }

        // waterfront promenade (pedestrian path at the water's edge)
        val promW = ArrayList<DoubleArray>()
        var pu = GRID_U0 - 60.0
        while (pu <= GRID_U1 + 60.0) {
            val sv = shore.at(pu)
            if (sv == Double.POSITIVE_INFINITY) {
                if (promW.size > 3) buildRoad("path", promW.toList(), bezier = true)
                promW.clear()
            } else {
                promW.add(doubleArrayOf(pu, min(sv - 14.0, COAST_V + 330.0)))
            }
            pu += 44.0
        }
        if (promW.size > 3) buildRoad("path", promW.toList(), bezier = true)

        // suburban crescents (inland-west)
        val subCU = GRID_U0 - 170.0
        val subCV = COAST_V + ROWS[4] - 20.0
        for (spec in arrayOf(doubleArrayOf(152.0, -80.0, 96.0), doubleArrayOf(238.0, -68.0, 88.0))) {
            val pts = ArrayList<DoubleArray>()
            for (k in 0..9) {
                val a = lerpD(spec[1], spec[2], k / 9.0) * PI / 180.0
                pts.add(doubleArrayOf(subCU + sin(a) * spec[0], subCV + cos(a) * spec[0]))
            }
            buildRoad("local", pts, bezier = true)
        }
        for (aDeg in doubleArrayOf(-58.0, 0.0, 58.0)) {
            val ar = aDeg * PI / 180.0
            buildRoad("local", listOf(
                doubleArrayOf(subCU + sin(ar) * 112.0, subCV + cos(ar) * 112.0),
                doubleArrayOf(subCU + sin(ar) * 288.0, subCV + cos(ar) * 288.0)))
        }
        buildRoad("local", listOf(doubleArrayOf(GRID_U0, subCV + 96.0), doubleArrayOf(subCU + 120.0, subCV + 124.0)), bezier = true)
        buildRoad("local", listOf(doubleArrayOf(GRID_U0, subCV - 130.0), doubleArrayOf(subCU + 118.0, subCV - 158.0)), bezier = true)

        // eastern hillside suburb crescent
        val eCU = GRID_U1 + 190.0
        val eCV = COAST_V + ROWS[3] + 30.0
        val ePts = ArrayList<DoubleArray>()
        for (k in 0..8) {
            val a = lerpD(112.0, 250.0, k / 8.0) * PI / 180.0
            ePts.add(doubleArrayOf(eCU + sin(a) * 176.0, eCV + cos(a) * 176.0))
        }
        buildRoad("local", ePts, bezier = true)
        buildRoad("local", listOf(doubleArrayOf(GRID_U1, eCV + 40.0), doubleArrayOf(eCU - 96.0, eCV + 86.0)), bezier = true)
        buildRoad("local", listOf(doubleArrayOf(GRID_U1, eCV - 152.0), doubleArrayOf(eCU - 74.0, eCV - 178.0)), bezier = true)

        // industrial estate + freight links
        buildRoad("avenue", listOf(
            doubleArrayOf(IND_U0 - 190.0, IND_V1 + 40.0), doubleArrayOf(IND_U0 - 30.0, IND_V1 + 6.0),
            doubleArrayOf(IND_U1, IND_V1 - 10.0)), bezier = true)
        var iu = IND_U0 - 30.0
        while (iu <= IND_U1) {
            buildRoad("local", listOf(doubleArrayOf(iu, IND_V1 + 6.0), doubleArrayOf(iu + 14.0, IND_V0)), bezier = true)
            iu += 112.0
        }
        var iv = IND_V0 + 96.0
        while (iv < IND_V1 - 30.0) {
            buildRoad("local", listOf(doubleArrayOf(IND_U0 - 30.0, iv), doubleArrayOf(IND_U1, iv)))
            iv += 96.0
        }
        buildRoad("local", listOf(
            doubleArrayOf(168.0, HW_V + 4.0), doubleArrayOf(220.0, IND_V0 - 30.0), doubleArrayOf(IND_U0 - 30.0, IND_V0)), bezier = true)
        buildRoad("avenue", listOf(
            doubleArrayOf(0.0, COAST_V + GRID_V0), doubleArrayOf(180.0, COAST_V + GRID_V0 - 60.0),
            doubleArrayOf(IND_U0 - 30.0, IND_V1 + 6.0)), bezier = true)

        // a country lane
        buildRoad("local", listOf(
            doubleArrayOf(GRID_U1 + 96.0, COAST_V + ROWS[6]), doubleArrayOf(GRID_U1 + 260.0, COAST_V + ROWS[6] - 130.0),
            doubleArrayOf(GRID_U1 + 300.0, HW_V + 230.0)), bezier = true)
    }

    // ---------------------------------------------------------------- block grading (verbatim port)

    /** Level each block to a smoothed version of its own ground height so streets become the ramps. */
    fun gradeBlocks(): Int {
        val nI = COLS.size - 1
        val nJ = ROWS.size - 1
        val hM = DoubleArray(nI * nJ)
        val wet = BooleanArray(nI * nJ)
        for (i in 0 until nI) {
            for (j in 0 until nJ) {
                val u0 = COLS[i]
                val u1 = COLS[i + 1]
                val v0 = COAST_V + ROWS[j + 1]
                val v1 = COAST_V + ROWS[j]
                val hs = ArrayList<Double>(9)
                var nWet = 0
                var n = 0
                for (a in 0..2) {
                    for (b in 0..2) {
                        val p = L(u0 + (u1 - u0) * (a / 2.0), v0 + (v1 - v0) * (b / 2.0))
                        if (!inBounds(p[0], p[1])) { nWet++; n++; continue }
                        if (isWater(p[0], p[1])) nWet++
                        hs.add(hm.getHeight(p[0], p[1]))
                        n++
                    }
                }
                hs.sort()
                hM[i * nJ + j] = if (hs.isNotEmpty()) hs[hs.size / 2] else 2.0
                wet[i * nJ + j] = nWet > n * 0.34
            }
        }
        for (pass in 0 until 2) {
            val src = hM.copyOf()
            for (i in 0 until nI) {
                for (j in 0 until nJ) {
                    var sum = 0.0
                    var w = 0.0
                    for (di in -1..1) {
                        for (dj in -1..1) {
                            val ii = i + di
                            val jj = j + dj
                            if (ii < 0 || ii >= nI || jj < 0 || jj >= nJ) continue
                            val k = if (di == 0 && dj == 0) 3.0 else 1.0
                            sum += src[ii * nJ + jj] * k
                            w += k
                        }
                    }
                    hM[i * nJ + j] = sum / w
                }
            }
        }
        var graded = 0
        for (i in 0 until nI) {
            for (j in 0 until nJ) {
                if (wet[i * nJ + j]) continue
                val y = max(hM[i * nJ + j], 1.4)
                val vc = COAST_V + (ROWS[j] + ROWS[j + 1]) / 2.0
                val a = L(COLS[i] + 10.0, vc)
                val b = L(COLS[i + 1] - 10.0, vc)
                val pts = listOf(
                    Heightmap.PathPoint(a[0], y, a[1]),
                    Heightmap.PathPoint(b[0], y, b[1]),
                )
                hm.conformPath(pts, (DT - 30).toDouble(), 20.0)
                graded++
            }
        }
        return graded
    }

    // ---------------------------------------------------------------- preview blocks

    class BlockBuilding(
        val x: Float, val y: Float, val z: Float,
        val w: Float, val d: Float, val h: Float,
        val kind: Int, val yaw: Float, val seed: Int,
    )

    val blocks = ArrayList<BlockBuilding>()

    private fun colOf(u: Double): Int {
        for (i in 0 until COLS.size - 1) if (u >= COLS[i] && u < COLS[i + 1]) return i
        return -1
    }

    private fun rowOf(v: Double): Int {
        val t = v - COAST_V
        for (j in 0 until ROWS.size - 1) if (t <= ROWS[j] && t > ROWS[j + 1]) return j
        return -1
    }

    private val blockTypes = HashMap<String, Int>()

    fun blockType(i: Int, j: Int): Int {
        val key = "$i,$j"
        val existing = blockTypes[key]
        if (existing != null) return existing
        val u = (COLS[i] + COLS[i + 1]) / 2.0
        val v = COAST_V + (ROWS[j] + ROWS[j + 1]) / 2.0
        val t = zoneFor(u, v - CORE_V, Rng(hash2Signed(seed, 0x51de + i * 977 + j * 31)))
        blockTypes[key] = t
        return t
    }

    /** Deterministic preview blocks aligned to the city frame (full building-module port replaces these). */
    fun generateBlocks() {
        blocks.clear()
        val nI = COLS.size - 1
        val nJ = ROWS.size - 1
        val rng = Rng(20240817)
        for (i in 0 until nI) {
            for (j in 0 until nJ) {
                val key = "$i,$j"
                val uMid = (COLS[i] + COLS[i + 1]) / 2.0
                val vMid = COAST_V + (ROWS[j] + ROWS[j + 1]) / 2.0
                val yaw = atan(-site.uz, site.ux).toFloat()
                if (PARKS.contains(key)) continue
                if (CIVIC.containsKey(key)) {
                    placeBox(uMid, vMid, 34f, 34f, 22f, Z_SERVICE, yaw, rng)
                    continue
                }
                if (LANDMARK.containsKey(key)) {
                    val spec = when (LANDMARK[key]) {
                        "tower_deco" -> floatArrayOf(30f, 30f, 128f)
                        "tower_twin" -> floatArrayOf(44f, 24f, 92f)
                        "tower_round" -> floatArrayOf(30f, 30f, 102f)
                        "townhall" -> floatArrayOf(52f, 26f, 38f)
                        else -> floatArrayOf(28f, 52f, 46f) // cathedral
                    }
                    placeBox(uMid, vMid, spec[0], spec[1], spec[2], Z_LANDMARK, yaw, rng)
                    continue
                }
                if (key == SITE_BLOCK) continue
                val zone = blockType(i, j)
                // 2x2 lots per block, block inner size ~68 m
                val cMid = L(uMid, vMid)
                for (li in 0..1) {
                    for (lj in 0..1) {
                        if (rng.next().toFloat() < 0.22f) continue
                        val du = (if (li == 0) -17f else 17f).toDouble()
                        val dv = (if (lj == 0) -17f else 17f).toDouble()
                        // rotate the lot offset into the world frame
                        val wx = cMid[0] + site.ux * du + site.vx * dv
                        val wz = cMid[1] + site.uz * du + site.vz * dv
                        val spec: Triple<Float, Float, Float> = when (zone) {
                            Z_OFFICE -> Triple(22f + rng.next().toFloat() * 6f, 22f + rng.next().toFloat() * 6f, 56f + rng.next().toFloat() * 60f)
                            Z_COM_HIGH -> Triple(22f + rng.next().toFloat() * 6f, 22f + rng.next().toFloat() * 6f, 34f + rng.next().toFloat() * 42f)
                            Z_RES_HIGH -> Triple(24f + rng.next().toFloat() * 4f, 24f + rng.next().toFloat() * 4f, 26f + rng.next().toFloat() * 30f)
                            Z_COM_LOW -> Triple(20f + rng.next().toFloat() * 8f, 20f + rng.next().toFloat() * 8f, 10f + rng.next().toFloat() * 12f)
                            else -> Triple(18f + rng.next().toFloat() * 8f, 18f + rng.next().toFloat() * 8f, 8f + rng.next().toFloat() * 9f)
                        }
                        addBlock(wx, wz, spec.first, spec.second, spec.third, zone, yaw, rng)
                    }
                }
            }
        }
    }

    private fun placeBox(u: Double, v: Double, w: Float, d: Float, h: Float, kind: Int, yaw: Float, rng: Rng) {
        val p = L(u, v)
        addBlock(p[0], p[1], w, d, h, kind, yaw, rng)
    }

    private fun addBlock(wx: Double, wz: Double, w: Float, d: Float, h: Float, kind: Int, yaw: Float, rng: Rng) {
        val y = hm.getHeight(wx, wz).toFloat()
        blocks.add(BlockBuilding(wx.toFloat(), y, wz.toFloat(), w, d, h, kind, yaw, (rng.next() * 10000.0).toInt()))
    }

    // ---------------------------------------------------------------- vehicle routes

    class Route(val samples: FloatArray, val count: Int, val step: Float) {
        fun length(): Float = (count - 1) * step

        /** position + tangent at arc length s (clamped/wrapped by the caller). */
        fun at(s: Float, out: FloatArray) {
            val t = (s / step).coerceIn(0f, (count - 1).toFloat())
            val i = floor(t).toInt().coerceIn(0, count - 2)
            val f = t - i
            val a = i * 3
            val b = (i + 1) * 3
            out[0] = samples[a] + (samples[b] - samples[a]) * f
            out[1] = samples[a + 1] + (samples[b + 1] - samples[a + 1]) * f
            out[2] = samples[a + 2] + (samples[b + 2] - samples[a + 2]) * f
            out[3] = samples[b] - samples[a]
            out[4] = samples[b + 2] - samples[a + 2]
        }
    }

    val routes = ArrayList<Route>()

    /** Sample two driving routes (spine + coastal boulevard) after conforming. */
    fun buildRoutes() {
        routes.clear()
        // spine: u = 0, v from HW_V+210 down to COAST_V
        addRoute(fun(v: Double): DoubleArray = L(0.0, v), HW_V + 210.0, COAST_V)
        // coastal boulevard: v = COAST_V, u from GRID_U0-108 to GRID_U1+108
        addRoute(fun(u: Double): DoubleArray = L(u, COAST_V), GRID_U0 - 108.0, GRID_U1 + 108.0)
    }

    private fun addRoute(pointAt: (Double) -> DoubleArray, from: Double, to: Double) {
        val step = 8.0
        val n = (abs(to - from) / step).toInt() + 2
        val samples = FloatArray(n * 3)
        val dir = if (to >= from) 1.0 else -1.0
        for (i in 0 until n) {
            val t = from + dir * min(i.toDouble() * step, abs(to - from))
            val p = pointAt(t)
            samples[i * 3] = p[0].toFloat()
            samples[i * 3 + 1] = hm.getHeight(p[0], p[1]).toFloat()
            samples[i * 3 + 2] = p[1].toFloat()
        }
        routes.add(Route(samples, n, 8f))
    }

    private fun lerpD(a: Double, b: Double, t: Double): Double = a + (b - a) * t

    private fun atan(y: Double, x: Double): Double = kotlin.math.atan2(y, x)
}
