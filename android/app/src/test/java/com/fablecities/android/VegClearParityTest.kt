package com.fablecities.android

import com.fablecities.android.worldgen.GroundControl
import com.fablecities.android.worldgen.Heightmap
import com.fablecities.android.worldgen.SimplexNoise
import com.fablecities.android.worldgen.Vegetation
import com.fablecities.android.worldgen.VegClearGoldens
import com.fablecities.android.worldgen.WaterMath
import com.fablecities.android.worldgen.hash2Signed
import com.fablecities.android.worldgen.v8Hypot
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

/**
 * Bit-parity golden tests against the REAL browser Vegetation.js:
 *  - the clearing ops (clearRect / clearCircle / clearOriented / clearPolyline / isCleared /
 *    aliveCount + the 4 m clearMask raster) — the exact semantics of terrain/index.js's
 *    roads:changed / building:added / zones:changed / service:added handlers
 *  - _updateUndergrowth: the camera-focused turf patch (per-cell rng chain
 *    hash2(hash2(seed, cx*73856093), cz*19349663), meadow/fern density model, near-focus
 *    multiplier, 8 atlas variants, ground-tint blend with the default layer means, the
 *    clearMask exclusion)
 * Expected values produced by tools/probe_vegclear.mjs driving the REAL module in Node on a
 * bare prototype instance over the real heightmap + control maps (seed 1337).
 */
class VegClearParityTest {

    companion object {
        // the probe's clearing anchors are tree positions from the SAME pinned distribution,
        // re-derived here so both sides anchor identically
        fun anchors(trees: List<Vegetation.Tree>): List<Vegetation.Tree> {
            val inMap = trees.filter { !it.horizon }
            return listOf(inMap[1000], inMap[2000], inMap[3000], inMap[4000], inMap[4400])
        }
    }

    private fun hm1337(): Heightmap = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()

    private fun bake(hm: Heightmap): Triple<ByteArray, ByteArray, ByteArray> {
        val ground = GroundControl(hm, 1337)
        val shore = WaterMath.computeShoreDistance(hm)
        val res = 512
        val step = hm.size.toDouble() / res
        val ctrl = ByteArray(res * res * 4)
        val ctrl2 = ByteArray(res * res * 4)
        for (j in 0 until res) {
            val z = -hm.half + (j + 0.5) * step
            for (i in 0 until res) {
                val x = -hm.half + (i + 0.5) * step
                val k = (j * res + i) * 4
                val h = hm.getHeight(x, z)
                val slope = hm.getSlope(x, z)
                val c = ground.controlAt(x, z, h, slope, VegetationGround.shoreAt(hm, shore, x, z))
                ctrl[k] = (255.0 * c.dry).toInt().toByte()
                ctrl[k + 1] = (255.0 * c.dirt).toInt().toByte()
                ctrl[k + 2] = (255.0 * c.sand).toInt().toByte()
                ctrl[k + 3] = (255.0 * c.rock).toInt().toByte()
                ctrl2[k] = (255.0 * c.forest).toInt().toByte()
                ctrl2[k + 1] = (255.0 * c.field.coerceIn(0.0, 1.0)).toInt().toByte()
                ctrl2[k + 2] = 0
                val e = 8.0
                val lap = (hm.getHeight(x + e, z) + hm.getHeight(x - e, z) +
                    hm.getHeight(x, z + e) + hm.getHeight(x, z - e) - 4.0 * h) / (e * e)
                ctrl2[k + 3] = (255.0 * (0.5 - lap * 45.0).coerceIn(0.05, 0.95)).toInt().toByte()
            }
        }
        return Triple(ctrl, ctrl2, shore)
    }

    /** groundTint with the default layer means (the probe uses AVG = 0.5 per layer). */
    private fun groundTint05(gi: Vegetation.GroundInfo, out: DoubleArray) {
        val LAYER_TINT = arrayOf(
            doubleArrayOf(0.46, 0.55, 0.40), doubleArrayOf(0.50, 0.51, 0.38),
            doubleArrayOf(0.55, 0.49, 0.38), doubleArrayOf(0.90, 0.88, 0.90),
            doubleArrayOf(0.51, 0.47, 0.38), doubleArrayOf(0.52, 0.48, 0.40),
            doubleArrayOf(0.90, 0.88, 0.90), doubleArrayOf(0.32, 0.30, 0.22))
        val a = doubleArrayOf(0.5, 0.5, 0.5)
        val w = doubleArrayOf(gi.grass, gi.dry, gi.dirt, gi.rock, gi.sand, gi.wet * 0.35, 0.0, gi.forest * 0.5 * gi.grass)
        var sw = 0.0
        out[0] = 0.0; out[1] = 0.0; out[2] = 0.0
        for (i in 0 until 8) {
            val wi = w[i]
            if (wi <= 0.001) continue
            val t = LAYER_TINT[i]
            out[0] += wi * a[0] * t[0]; out[1] += wi * a[1] * t[1]; out[2] += wi * a[2] * t[2]; sw += wi
        }
        if (sw > 0.0) { out[0] /= sw; out[1] /= sw; out[2] /= sw } else { out[0] = 0.3; out[1] = 0.38; out[2] = 0.18 }
    }

    private fun data(
        hm: Heightmap, ctrl: ByteArray, ctrl2: ByteArray, shore: ByteArray,
    ): Pair<Vegetation.Forest, (Double, Double) -> Vegetation.GroundInfo> {
        val ground = GroundControl(hm, 1337)
        val trees = Vegetation.distribute(
            hm, 1337, 1.0, hm.half,
            { x, z, h, slope -> ground.forestMask(x, z, h, slope) },
            { x, z -> Vegetation.groundInfo(hm, ctrl, ctrl2, 512, shore, x, z) },
        )
        return Pair(Vegetation.Forest(trees, hm.half, hm), { x, z -> Vegetation.groundInfo(hm, ctrl, ctrl2, 512, shore, x, z) })
    }

    private fun runClearing(forest: Vegetation.Forest): List<Vegetation.Tree> {
        val (A, B, C, D, E) = anchors(forest.trees)
        forest.clearRect(A.x - 50, A.z - 40, A.x + 50, A.z + 40)
        forest.clearCircle(B.x, B.z, 30.0)
        forest.clearOriented(C.x, C.z, 20.0, 14.0, 0.7, 1.5)
        forest.clearPolyline(
            listOf(doubleArrayOf(D.x, D.z), doubleArrayOf((D.x + E.x) / 2.0, (D.z + E.z) / 2.0), doubleArrayOf(E.x, E.z)), 24.0)
        return anchors(forest.trees)
    }

    @Test
    fun clearing_bitParity() {
        val hm = hm1337()
        val (ctrl, ctrl2, shore) = bake(hm)
        val (forest, _) = data(hm, ctrl, ctrl2, shore)
        assertEquals("tree total", VegClearGoldens.treeTotal.toLong(), forest.trees.size.toLong())
        val (A, B, C, D, E) = anchors(forest.trees)
        val nRect = forest.clearRect(A.x - 50, A.z - 40, A.x + 50, A.z + 40)
        val nCircle = forest.clearCircle(B.x, B.z, 30.0)
        val nOriented = forest.clearOriented(C.x, C.z, 20.0, 14.0, 0.7, 1.5)
        val nPoly = forest.clearPolyline(
            listOf(doubleArrayOf(D.x, D.z), doubleArrayOf((D.x + E.x) / 2.0, (D.z + E.z) / 2.0), doubleArrayOf(E.x, E.z)), 24.0)
        assertEquals("cleared rect", VegClearGoldens.clearedRect.toLong(), nRect.toLong())
        assertEquals("cleared circle", VegClearGoldens.clearedCircle.toLong(), nCircle.toLong())
        assertEquals("cleared oriented", VegClearGoldens.clearedOriented.toLong(), nOriented.toLong())
        assertEquals("cleared polyline", VegClearGoldens.clearedPoly.toLong(), nPoly.toLong())
        var maskSum = 0
        var maskW = 0L
        for (i in forest.clearMask.indices) {
            maskSum += forest.clearMask[i].toInt()
            maskW += forest.clearMask[i].toLong() * ((i % 97 + 1).toLong())
        }
        assertEquals("mask sum", VegClearGoldens.maskSum.toLong(), maskSum.toLong())
        assertEquals("mask weighted", VegClearGoldens.maskWeighted.toLong(), maskW)
        assertEquals("alive after", VegClearGoldens.aliveAfter.toLong(), forest.aliveCount().toLong())
        val probePts = listOf(A.x to A.z, B.x to B.z, C.x to C.z, D.x to D.z, E.x to E.z,
            (D.x + E.x) / 2.0 to (D.z + E.z) / 2.0)
        for ((k, pt) in probePts.withIndex()) {
            assertEquals("isCleared[$k]", VegClearGoldens.clearedProbes[k],
                if (forest.isCleared(pt.first, pt.second)) 1 else 0)
        }
    }

    @Test
    fun undergrowth_bitParity() {
        val hm = hm1337()
        val (ctrl, ctrl2, shore) = bake(hm)
        val (forest, gi) = data(hm, ctrl, ctrl2, shore)
        anchors(forest.trees) // no-op: keeps anchor derivation identical to the probe
        val cn = SimplexNoise(hash2Signed(1337, 909))
        val tintFn = { x: Double, z: Double, out: DoubleArray -> groundTint05(gi(x, z), out) }

        // ---- patch 1: camera over the cleared oriented footprint ----
        val (_, _, C, _, _) = anchors(forest.trees)
        val cam1 = doubleArrayOf(C.x - 40.0, 42.0, C.z - 40.0)
        val dir1 = doubleArrayOf(0.57735, -0.57735, 0.57735)
        val h1 = hm.getHeight(cam1[0], cam1[2])
        val t1 = jsClamp(-(cam1[1] - h1) / dir1[1], 0.0, 55.0)
        val fx1 = cam1[0] + dir1[0] * t1
        val fz1 = cam1[2] + dir1[2] * t1
        assertEquals("focus1 x", VegClearGoldens.ugFocusX, fx1, 1e-9)
        assertEquals("focus1 z", VegClearGoldens.ugFocusZ, fz1, 1e-9)
        // the probe's patches run AFTER the same clearing sequence — apply it here too
        runClearing(forest)
        val patch1 = Vegetation.undergrowthPatch(
            hm, 1337, 1.0, hm.half, cn, gi, tintFn,
            { x, z -> forest.isCleared(x, z) }, null, fx1, fz1, cam1[1] - h1)
        assertEquals("patch1 count", VegClearGoldens.ugCount.toLong(), patch1!!.instances.size.toLong())
        var chk1 = 0.0
        for ((k, g) in patch1.instances.withIndex()) {
            chk1 = jsMod(chk1 + (f32(g.x) * 1.31 + f32(g.z) * 2.17 + f32(g.sy) * 3.03 + f32(g.variant.toDouble()) * 4.01 + f32(g.r) * 5.07 + f32(g.g) * 6.11 + f32(g.b) * 7.02) * (k % 71 + 1), 4294967296.0)
        }
        assertEquals("patch1 checksum", VegClearGoldens.ugChk, chk1, 1e-6)
        val hist1 = IntArray(8)
        for (g in patch1.instances) hist1[g.variant]++
        for (v in 0 until 8) assertEquals("patch1 varHist[$v]", VegClearGoldens.ugVarHist[v].toLong(), hist1[v].toLong())
        for (i in VegClearGoldens.ugProbes.indices) {
            val g = patch1.instances[i]
            val p = VegClearGoldens.ugProbes[i]
            // the site stores instances in Float32Arrays — compare the same truncation
            assertEquals("p1[$i].x", p[0], f32(g.x), 1e-9)
            assertEquals("p1[$i].z", p[1], f32(g.z), 1e-9)
            assertEquals("p1[$i].sx", p[2], hyp32(g), 1e-6)
            assertEquals("p1[$i].sy", p[3], f32(g.sy), 1e-9)
            assertEquals("p1[$i].yaw", p[4], atan32(g), 1e-6)
            assertEquals("p1[$i].variant", p[5].toInt(), g.variant)
            assertEquals("p1[$i].r", p[6], f32(g.r), 1e-9)
            assertEquals("p1[$i].g", p[7], f32(g.g), 1e-9)
            assertEquals("p1[$i].b", p[8], f32(g.b), 1e-9)
        }
        // the web guarantee: no tuft sits in a cleared mask cell
        var inCleared = 0
        for (g in patch1.instances) if (forest.isCleared(g.x, g.z)) inCleared++
        assertEquals("no tufts in cleared cells", 0, inCleared)

        // ---- patch 2: fern-rich forest focus ----
        val t500 = forest.trees.filter { !it.horizon }[500]
        val cam2 = doubleArrayOf(t500.x, 42.0, t500.z - 60.0)
        val dir2 = doubleArrayOf(0.0, -0.70710678, 0.70710678)
        val h2 = hm.getHeight(cam2[0], cam2[2])
        val t2 = jsClamp(-(cam2[1] - h2) / dir2[1], 0.0, 55.0)
        val fx2 = cam2[0] + dir2[0] * t2
        val fz2 = cam2[2] + dir2[2] * t2
        assertEquals("focus2 x", VegClearGoldens.ug2FocusX, fx2, 1e-9)
        assertEquals("focus2 z", VegClearGoldens.ug2FocusZ, fz2, 1e-9)
        val patch2 = Vegetation.undergrowthPatch(
            hm, 1337, 1.0, hm.half, cn, gi, tintFn,
            { x, z -> forest.isCleared(x, z) }, null, fx2, fz2, cam2[1] - h2)
        assertEquals("patch2 count", VegClearGoldens.ug2Count.toLong(), patch2!!.instances.size.toLong())
        var chk2 = 0.0
        for ((k, g) in patch2.instances.withIndex()) {
            chk2 = jsMod(chk2 + (f32(g.x) * 1.31 + f32(g.z) * 2.17 + f32(g.sy) * 3.03 + f32(g.variant.toDouble()) * 4.01 + f32(g.r) * 5.07 + f32(g.g) * 6.11 + f32(g.b) * 7.02) * (k % 71 + 1), 4294967296.0)
        }
        assertEquals("patch2 checksum", VegClearGoldens.ug2Chk, chk2, 1e-6)
        val hist2 = IntArray(8)
        for (g in patch2.instances) hist2[g.variant]++
        for (v in 0 until 8) assertEquals("patch2 varHist[$v]", VegClearGoldens.ug2VarHist[v].toLong(), hist2[v].toLong())
        for (i in VegClearGoldens.ug2Probes.indices) {
            val g = patch2.instances[i]
            val p = VegClearGoldens.ug2Probes[i]
            assertEquals("p2[$i].x", p[0], f32(g.x), 1e-9)
            assertEquals("p2[$i].z", p[1], f32(g.z), 1e-9)
            assertEquals("p2[$i].sx", p[2], hyp32(g), 1e-6)
            assertEquals("p2[$i].sy", p[3], f32(g.sy), 1e-9)
            assertEquals("p2[$i].yaw", p[4], atan32(g), 1e-6)
            assertEquals("p2[$i].variant", p[5].toInt(), g.variant)
            assertEquals("p2[$i].r", p[6], f32(g.r), 1e-9)
            assertEquals("p2[$i].g", p[7], f32(g.g), 1e-9)
            assertEquals("p2[$i].b", p[8], f32(g.b), 1e-9)
        }
    }

    /** the instance columns as the site's Float32Array stores them */
    private fun f32(v: Double): Double = v.toFloat().toDouble()
    /** Math.hypot over the float32 (cos·yaw·sx, sin·yaw·sx) columns */
    private fun hyp32(g: Vegetation.UndergrowthInstance): Double {
        val cs = f32(cos(g.yaw) * g.sx)
        val sn = f32(sin(g.yaw) * g.sx)
        return v8Hypot(cs, sn)
    }
    /** Math.atan2 over the float32 columns */
    private fun atan32(g: Vegetation.UndergrowthInstance): Double {
        val cs = f32(cos(g.yaw) * g.sx)
        val sn = f32(sin(g.yaw) * g.sx)
        return kotlin.math.atan2(sn, cs)
    }

    private fun jsClamp(v: Double, lo: Double, hi: Double) = v.coerceIn(lo, hi)
    private fun jsMod(a: Double, n: Double): Double = a % n
}
