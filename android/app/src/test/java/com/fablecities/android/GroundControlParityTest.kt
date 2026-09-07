package com.fablecities.android

import com.fablecities.android.worldgen.GroundControl
import com.fablecities.android.worldgen.GroundControlGoldens
import com.fablecities.android.worldgen.Heightmap
import com.fablecities.android.worldgen.WaterMath
import com.fablecities.android.worldgen.jsRound
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser ground rules:
 *  - terrain/GroundControl.js makeGroundControl (controlAt / forestMask / fields / fieldAt)
 *    on the native heightmap grid (size 2048, spacing 4, seed 1337)
 *  - the full 512x512 control bake exactly as terrain/index.js performs it:
 *    ctrl RGBA = (dry, dirt, sand, rock) · 255, ctrl2 RGBA = (forest, field, 0, curvature) · 255,
 *    with shoreAt from Heightmap.computeShoreDistance and the 8 m Laplacian curvature
 * Expected values were produced by running the actual web code in Node (tools/probe_groundcontrol.mjs).
 * The native terrain splat must weigh its 8 layers with the SAME fields as the browser.
 */
class GroundControlParityTest {

    private fun hm1337(): Heightmap = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()

    private fun shoreAt(hm: Heightmap, shore: ByteArray, x: Double, z: Double): Double {
        val i = jsRound((x + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        val j = jsRound((z + hm.half) / hm.spacing).toInt().coerceIn(0, hm.N - 1)
        return ((shore[j * hm.N + i].toInt() and 0xFF) - 128) * 0.25
    }

    private fun curvatureAt(hm: Heightmap, x: Double, z: Double, h: Double): Double {
        val e = 8.0
        val lap = (hm.getHeight(x + e, z) + hm.getHeight(x - e, z) +
            hm.getHeight(x, z + e) + hm.getHeight(x, z - e) - 4.0 * h) / (e * e)
        return ((0.5 - lap * 45.0).coerceIn(0.05, 0.95))
    }

    /** The terrain/index.js control bake. Returns [ctrl, ctrl2] byte maps 512x512x4. */
    private fun bake(hm: Heightmap): Pair<ByteArray, ByteArray> {
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
                val c = ground.controlAt(x, z, h, slope, shoreAt(hm, shore, x, z))
                ctrl[k] = (255.0 * c.dry).toInt().toByte()
                ctrl[k + 1] = (255.0 * c.dirt).toInt().toByte()
                ctrl[k + 2] = (255.0 * c.sand).toInt().toByte()
                ctrl[k + 3] = (255.0 * c.rock).toInt().toByte()
                ctrl2[k] = (255.0 * c.forest).toInt().toByte()
                ctrl2[k + 1] = (255.0 * c.field.coerceIn(0.0, 1.0)).toInt().toByte()
                ctrl2[k + 2] = 0
                ctrl2[k + 3] = (255.0 * curvatureAt(hm, x, z, h)).toInt().toByte()
            }
        }
        return Pair(ctrl, ctrl2)
    }

    @Test
    fun controlMap_channelSums_bitParity() {
        val hm = hm1337()
        val (ctrl, ctrl2) = bake(hm)
        for (ch in 0 until 4) {
            var s = 0L
            for (i in ch until ctrl.size step 4) s += ctrl[i].toInt() and 0xFF
            assertEquals("ctrl ch$ch", GroundControlGoldens.ctrlSums[ch].toLong(), s)
            var s2 = 0L
            for (i in ch until ctrl2.size step 4) s2 += ctrl2[i].toInt() and 0xFF
            assertEquals("ctrl2 ch$ch", GroundControlGoldens.ctrl2Sums[ch].toLong(), s2)
        }
    }

    @Test
    fun controlMap_probeRows_bitParity() {
        val hm = hm1337()
        val (ctrl, ctrl2) = bake(hm)
        val res = 512
        var idx = 0
        for (j in GroundControlGoldens.probeRows) {
            var i = 0
            while (i < res) {
                val k = (j * res + i) * 4
                for (c in 0 until 4) {
                    assertEquals("ctrl[$j,$i] ch$c", GroundControlGoldens.rowBytes[idx].toInt(), ctrl[k + c].toInt() and 0xFF)
                    assertEquals("ctrl2[$j,$i] ch$c", GroundControlGoldens.rowBytes[idx + 4].toInt(), ctrl2[k + c].toInt() and 0xFF)
                    idx++
                }
                idx += 4
                i += 8
            }
        }
        assertEquals("consumed all probe bytes", GroundControlGoldens.rowBytes.size, idx)
    }

    @Test
    fun controlRules_doubleParity() {
        val hm = hm1337()
        val ground = GroundControl(hm, 1337)
        val shore = WaterMath.computeShoreDistance(hm)
        for (p in GroundControlGoldens.probePts.indices) {
            val x = GroundControlGoldens.probePts[p][0]
            val z = GroundControlGoldens.probePts[p][1]
            val h = hm.getHeight(x, z)
            val slope = hm.getSlope(x, z)
            val c = ground.controlAt(x, z, h, slope, shoreAt(hm, shore, x, z))
            val exp = GroundControlGoldens.ctrlDoubles[p]
            assertEquals("dry@$p", exp[0], c.dry, 1e-9)
            assertEquals("dirt@$p", exp[1], c.dirt, 1e-9)
            assertEquals("sand@$p", exp[2], c.sand, 1e-9)
            assertEquals("rock@$p", exp[3], c.rock, 1e-9)
            assertEquals("forest@$p", exp[4], c.forest, 1e-9)
            assertEquals("field@$p", exp[5], c.field, 1e-9)
            assertEquals("fieldEdge@$p", exp[6], c.fieldEdge, 1e-9)
            assertEquals("curv@$p", exp[7], curvatureAt(hm, x, z, h), 1e-9)
            val fmExp = GroundControlGoldens.fmDoubles[p][0]
            assertEquals("forestMask@$p", fmExp, ground.forestMask(x, z, h, slope), 1e-9)
            assertTrue("curvGolden@$p", GroundControlGoldens.curvDoubles[p][0] >= 0.05 - 1e-9)
        }
    }
}
