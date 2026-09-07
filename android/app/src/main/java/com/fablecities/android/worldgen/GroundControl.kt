package com.fablecities.android.worldgen

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Bit-exact Kotlin port of the web game's src/modules/terrain/GroundControl.js — the ground
 * composition rules shared by the control texture (in-map), the horizon vertex attributes
 * (outside the map) and the vegetation scatter. One function, so the map edge is invisible.
 *
 *   controlAt(x, z, h, slope, shoreDist?) → { dry, dirt, sand, rock, forest, field, fieldEdge }
 *
 * Ground cover is driven by the same erosion fields the heightmap uses (relief: upland / gully /
 * ridge), by aspect (sun-facing slopes dry out, hollows stay lush), by slope and by drainage-aligned
 * noise (dirt streaks run down the fall line). Sand exists only on the sea coast and on the inner
 * (convex) side of river meanders where the bank is nearly flat — everywhere else grass or mud runs
 * to the waterline. The forest mask is a thresholded low-frequency clump field (80-300 m stands with
 * ragged edges, ≈0 outside) plus riparian strips and hedgerows along the field patchwork.
 *
 * Every double-precision expression is written in the exact evaluation order of the JS original so
 * the JVM produces the same bits (verified by GroundControlParityTest against the real module in Node).
 */
class GroundControl(private val hm: Heightmap, seed: Int) {

    private val forestNoise = SimplexNoise(seed * 7 + 21)
    private val groundNoise = SimplexNoise(seed * 7 + 22)
    private val fieldSeed: Int = hash2Signed(seed, 4242)
    private val wl: Double = hm.waterLevel

    class Ctrl(
        var dry: Double = 0.0, var dirt: Double = 0.0, var sand: Double = 0.0,
        var rock: Double = 0.0, var forest: Double = 0.0,
        var field: Double = 0.0, var fieldEdge: Double = 0.0,
    )

    private class FieldHit(var w: Double, var id: Double, var edge: Double)

    /** Jittered-grid Voronoi: nearest cell id (0..1 hash), and distance to the nearest cell edge (m). */
    private val fieldsHit = FieldHit(0.0, 0.0, 0.0)
    private fun fields(x0: Double, z0: Double): FieldHit {
        // domain warp → plot edges meander instead of reading as straight polygon edges
        val x = x0 + 26.0 * groundNoise.noise2D(x0 / 70.0 + 31.0, z0 / 70.0)
        val z = z0 + 26.0 * groundNoise.noise2D(x0 / 70.0, z0 / 70.0 - 17.0)
        val gx = floorS(x / FIELD_CELL); val gz = floorS(z / FIELD_CELL)
        var d1 = Double.MAX_VALUE; var d2 = Double.MAX_VALUE; var id = 0.0
        for (j in -1..1) for (i in -1..1) {
            val cx = gx + i; val cz = gz + j
            val hsh = hash2Signed(hash2Signed(fieldSeed, cx * 7919), cz * 104729)
            val jx = ((hsh.toLong() and 0xFFFFL).toDouble() / 65535.0) * 0.8 + 0.1
            val jz = (((hsh.toLong() ushr 16) and 0xFFFFL).toDouble() / 65535.0) * 0.8 + 0.1
            val sx = (cx + jx) * FIELD_CELL; val sz = (cz + jz) * FIELD_CELL
            // anisotropic metric → elongated, plot-like cells
            val dx = (x - sx) * 1.25; val dz = (z - sz) * 0.85
            val d = sqrt(dx * dx + dz * dz)
            if (d < d1) { d2 = d1; d1 = d; id = ((hsh.toLong() and 0xFFFFFFFFL) % 1000).toDouble() / 1000.0 }
            else if (d < d2) d2 = d
        }
        fieldsHit.w = 0.0; fieldsHit.id = id; fieldsHit.edge = (d2 - d1) * 0.5
        return fieldsHit
    }

    /** Downhill gradient (gx, gz) of the terrain anywhere (4 m stencil). */
    private class Grad(var gx: Double = 0.0, var gz: Double = 0.0)
    private val gradScratch = Grad()
    private fun gradAt(x: Double, z: Double): Grad {
        val e = 4.0
        gradScratch.gx = (hm.getHeightAny(x + e, z) - hm.getHeightAny(x - e, z)) / (2.0 * e)
        gradScratch.gz = (hm.getHeightAny(x, z + e) - hm.getHeightAny(x, z - e)) / (2.0 * e)
        return gradScratch
    }

    /** Field patch weight (0 outside lowland pasture) and per-field id/edge distance. */
    private val fldScratch = FieldHit(0.0, 0.0, 0.0)
    private fun fieldAt(x: Double, z: Double, h: Double, slope: Double, riverD: Double, riverW: Double): FieldHit {
        val low = smoothstep(26.0, 14.0, h - wl) * smoothstep(1.2, 3.0, h - wl) * (1.0 - smoothstep(0.06, 0.13, slope))
        val nearRiver = smoothstep(riverW + 70.0, riverW + 20.0, riverD)
        val w = low * (1.0 - nearRiver)
        if (w <= 0.001) { fldScratch.w = 0.0; fldScratch.id = 0.0; fldScratch.edge = 999.0; return fldScratch }
        val f = fields(x, z)
        fldScratch.w = w; fldScratch.id = f.id; fldScratch.edge = f.edge
        return fldScratch
    }

    /** Debug/inspection accessor mirroring the web's exported fields(): (id, edgeDistance). */
    fun fieldsAt(x: Double, z: Double): Pair<Double, Double> {
        val f = fields(x, z)
        return Pair(f.id, f.edge)
    }

    class RelPre(var gully: Double = 0.0, var ridge: Double = 0.0, var rd: Double = 0.0, var rw: Double = 0.0)

    /**
     * 0..1 probability that a tree stands at (x,z). Thresholded clump noise: ≈0.9 inside stands,
     * ≈0 outside; hills carry closed forest, the valley floor copses, riparian strips and hedgerows.
     */
    fun forestMask(x: Double, z: Double, h: Double, slope: Double, pre: RelPre? = null): Double {
        val hA = h - wl
        var gully: Double; var ridge: Double; var rd: Double; var rw: Double
        if (pre != null) { gully = pre.gully; ridge = pre.ridge; rd = pre.rd; rw = pre.rw }
        else {
            val rel = hm.relief(x, z, 1)
            gully = rel.gully; ridge = rel.ridge
            rd = hm.riverDistance(x, z); rw = hm.riverHalfWidth(z)
        }
        val big = forestNoise.fbm2D(x / 420.0, z / 420.0, 3)                 // 80-300 m stands
        val med = forestNoise.fbm2D(x / 130.0 + 7.1, z / 130.0 - 3.3, 2)     // ragged edges
        val moisture = 0.6 * gully - 0.25 * ridge                            // hollows wetter, ridges drier
        val n = big * 0.75 + med * 0.42 + 0.3 * moisture
        val upland = smoothstep(16.0, 42.0, hA)
        val threshold = lerp(0.30, -0.02, upland)
        var f = smoothstep(threshold - 0.05, threshold + 0.11, n) * (0.82 + 0.18 * smoothstep(-0.5, 0.5, med))
        // lone trees are rare outside the stands
        f = maxOf(f, 0.004)
        // riparian strip along the river bank (broken up along the bank)
        val bankD = rd - rw
        val ripGate = smoothstep(0.3, 0.62, 0.5 + 0.5 * forestNoise.noise2D(z / 75.0 + 3.0, x / 75.0))
        val riparian = smoothstep(34.0, 16.0, bankD) * smoothstep(3.5, 9.0, bankD) * ripGate * 0.72
        f = maxOf(f, riparian)
        // hedgerows along the pasture plot edges (on ~45 % of the edges)
        if (hA > 2.0 && hA < 28.0 && slope < 0.1 && bankD > 40.0) {
            val fl = fields(x, z)
            val hedgeGate = smoothstep(0.42, 0.58, 0.5 + 0.5 * groundNoise.noise2D(x / 90.0 + 55.0, z / 90.0 - 21.0))
            val hedge = (1.0 - smoothstep(1.2, 3.4, fl.edge)) * hedgeGate * 0.6
            f = maxOf(f, hedge)
        }
        f *= 1.0 - smoothstep(0.30, 0.44, slope)                     // nothing on steep faces
        val treeLine = 112.0 + 18.0 * forestNoise.noise2D(x / 400.0 + 3.0, z / 400.0)
        f *= 1.0 - smoothstep(treeLine - 10.0, treeLine + 12.0, hA)  // tree line
        return clamp(f, 0.0, 1.0)
    }

    private val relPre = RelPre()
    private val out = Ctrl()

    /**
     * Ground control at a point. `shoreDist` (metres to the waterline, + on land) is optional — when
     * absent (horizon ring) it is estimated from the river / coast fields.
     */
    fun controlAt(x: Double, z: Double, h: Double, slope: Double, shoreDist: Double? = null): Ctrl {
        val hA = h - wl
        val rel = hm.relief(x, z, 1)
        val gully = rel.gully; val ridge = rel.ridge; val upland = rel.upland
        val rd = hm.riverDistance(x, z); val rw = hm.riverHalfWidth(z)
        relPre.gully = gully; relPre.ridge = ridge; relPre.rd = rd; relPre.rw = rw
        val f = forestMask(x, z, h, slope, relPre)
        val dc = z - hm.coastZ(x)
        val sd: Double = if (shoreDist == null) minOf(rd - rw, -dc) else shoreDist
        val fld = fieldAt(x, z, h, slope, rd, rw)
        val g = gradAt(x, z)
        val grade = v8Hypot(g.gx, g.gz)
        val aspectSouth = if (grade > 1e-4) clamp(g.gz / grade, -1.0, 1.0) else 0.0   // +1 = faces south (+z), sun-exposed
        val slopeF = smoothstep(0.02, 0.12, grade)

        // dryness: 20-110 m patches + aspect + ridges + altitude, lush in hollows / drainage
        val dryN = 0.55 * groundNoise.fbm2D(x / 110.0, z / 110.0, 3) + 0.32 * groundNoise.fbm2D(x / 24.0 + 3.0, z / 24.0, 2)
        var dry = smoothstep(0.16, 0.62,
            dryN + 0.22 * aspectSouth * slopeF + 0.22 * (ridge - 0.5) * upland - 0.45 * gully + 0.14 * smoothstep(8.0, 40.0, hA)) * (1.0 - 0.7 * f)
        if (fld.w > 0.0) {
            val fieldDry = smoothstep(0.35, 0.8, fld.id) * 0.65         // ~50 % of fields are dry pasture / hay
            val inner = smoothstep(2.5, 9.0, fld.edge)                   // soft margins along the plot edges
            dry = lerp(dry, fieldDry * inner + dry * (1.0 - inner) * 0.5, fld.w * 0.85)
        }

        // dirt: fall-line streaks (noise stretched along the downhill direction), gully beds on the hills,
        // worn field margins, steep cuts; forest floor is handled by the canopy mask in the shader
        var dirt = 0.0
        if (grade > 0.03) {
            val dx = g.gx / grade; val dz = g.gz / grade
            val along = x * dx + z * dz; val across = -x * dz + z * dx
            val streakN = groundNoise.noise2D(along / 55.0 + 9.0, across / 16.0)
            dirt += smoothstep(0.55, 0.9, streakN) * slopeF * (0.35 + 0.65 * smoothstep(0.35, 0.6, dryN + 0.5)) * 0.42
        }
        dirt += gully * upland * smoothstep(0.03, 0.09, grade) * 0.34
        // steep flanks lose their turf only in patches — a solid dirt flank reads as a bald dusty hill
        dirt += smoothstep(0.22, 0.38, slope) * 0.30 * smoothstep(0.35, 0.75, 0.5 + 0.5 * groundNoise.noise2D(x / 33.0 + 12.0, z / 33.0 - 5.0))
        if (fld.w > 0.0) dirt = maxOf(dirt, fld.w * smoothstep(3.2, 0.8, fld.edge) * 0.32 * smoothstep(0.35, 0.7, 0.5 + 0.5 * groundNoise.noise2D(x / 40.0 - 9.0, z / 40.0 + 4.0)))

        // sand: sea beach, and point bars on the inner side of river meanders — flat, patchy
        var sand = 0.0
        val flat = 1.0 - smoothstep(0.08, 0.17, grade)
        val sandN = 0.5 + 0.5 * groundNoise.noise2D(x / 48.0 + 17.0, z / 48.0 - 8.0)
        if (dc > -140.0 && hA < 6.0) {
            // coast: continuous beach where the plain runs out into the sea
            sand = smoothstep(-70.0 - 30.0 * sandN, -12.0, dc) * flat * smoothstep(3.5, 1.0, hA - 0.6 * sandN)
        }
        if (rd < rw + 40.0 && hA < 4.0) {
            val curv = hm.riverCurvature(z)
            val side = x - hm.riverX(z)
            val inner = smoothstep(3e-4, 8e-4, side * curv)            // convex bank of a pronounced bend
            val bar = inner * smoothstep(0.6, 0.78, sandN) * flat       // ~25 % of the inner banks carry a bar
            val sdd = maxOf(sd, 0.0)
            // solid at the waterline, breaking into patches with grass between them further up the bank
            val patch = smoothstep(0.30, 0.62, 0.5 + 0.5 * groundNoise.noise2D(x / 13.0 + 41.0, z / 13.0 - 7.0) + 0.45 * (1.0 - smoothstep(0.5, 5.0, sdd)))
            sand = maxOf(sand, bar * smoothstep(4.0 + 6.0 * sandN, 0.8, sdd) * patch)
        }

        // extra rock: high ground (patchy) + ridge outcrops on the hills
        val rockBoost = maxOf(
            smoothstep(78.0, 115.0, hA) * (0.45 + 0.55 * smoothstep(-0.2, 0.5, groundNoise.fbm2D(x / 90.0 + 40.0, z / 90.0, 2))),
            smoothstep(0.62, 0.85, ridge) * upland * smoothstep(0.1, 0.24, grade) * 0.85)
        out.dry = clamp(dry, 0.0, 1.0); out.dirt = clamp(dirt, 0.0, 1.0); out.sand = clamp(sand, 0.0, 1.0)
        out.rock = clamp(rockBoost, 0.0, 1.0); out.forest = f
        out.field = clamp(fld.w, 0.0, 1.0); out.fieldEdge = fld.edge
        return out
    }

    companion object {
        private const val FIELD_CELL = 150.0

        fun clamp(v: Double, a: Double, b: Double): Double = if (v < a) a else if (v > b) b else v
        fun lerp(a: Double, b: Double, t: Double): Double = a + (b - a) * t
        fun smoothstep(a: Double, b: Double, v: Double): Double {
            val t = ((v - a) / (b - a)).coerceIn(0.0, 1.0)
            return t * t * (3.0 - 2.0 * t)
        }
        private fun floorS(v: Double): Int {
            val f = kotlin.math.floor(v)
            return f.toInt()
        }
    }
}
