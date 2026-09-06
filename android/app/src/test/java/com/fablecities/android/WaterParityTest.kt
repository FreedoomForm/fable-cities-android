package com.fablecities.android

import com.fablecities.android.worldgen.Heightmap
import com.fablecities.android.worldgen.WaterGoldens
import com.fablecities.android.worldgen.WaterMath
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser water stack:
 *  - Heightmap.js computeShoreDistance (exact EDT shoreline SDF, Uint8 payload 128 + 4·sd)
 *  - terrain/textures.js makeNoiseTexture(256, 1337) + makeWaterNormalTexture(256, 3)
 *  - Water.js _buildGeometry quad scan (chunkSize 128) and THREE.DataUtils.toHalfFloat
 * Expected values were produced by running the actual web code in Node (tools/probe_water.mjs)
 * on the native grid (size 2048, spacing 4, seed 1337). The native water must show the SAME
 * shoreline, the same foam noise, the same ripple normals and the same surface extent.
 */
class WaterParityTest {

    private fun hm1337(): Heightmap = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()

    private fun byteSum(a: ByteArray): Long {
        var s = 0L
        for (b in a) s += b.toInt() and 0xFF
        return s
    }

    @Test
    fun shoreDistance_bitParity() {
        val hm = hm1337()
        val shore = WaterMath.computeShoreDistance(hm)
        assertEquals(513 * 513, shore.size)
        for (i in WaterGoldens.shoreProbes.indices) {
            val cell = WaterGoldens.shoreCells[i]
            val v = shore[cell[0] * 513 + cell[1]].toInt() and 0xFF
            assertEquals("shore[$i]@(${cell[0]},${cell[1]})", WaterGoldens.shoreProbes[i].toInt(), v)
        }
        var under = 0
        for (b in shore) if (b.toInt() and 0xFF < 128) under++
        assertEquals("count of under-water texels", WaterGoldens.shoreUnder.toLong(), under.toLong())
    }

    @Test
    fun noiseTexture_bitParity() {
        val tex = WaterMath.makeNoiseTexture(256, 1337)
        assertEquals(256 * 256 * 4, tex.size)
        for (row in WaterGoldens.noiseProbes.indices) {
            val k = ((row * 4093 + 7) % 65536) * 4 // tools/probe_water.mjs texIdx
            val p = WaterGoldens.noiseProbes[row]
            for (c in 0 until 4) {
                assertEquals("noise[${k + c}]", p[c].toInt(), tex[k + c].toInt() and 0xFF)
            }
        }
        assertEquals(WaterGoldens.noiseByteSum.toLong(), byteSum(tex))
    }

    @Test
    fun waterNormalTexture_bitParity() {
        val tex = WaterMath.makeWaterNormalTexture(256, 3)
        assertEquals(256 * 256 * 4, tex.size)
        for (row in WaterGoldens.wnormalProbes.indices) {
            val k = ((row * 4093 + 7) % 65536) * 4 // tools/probe_water.mjs texIdx
            val p = WaterGoldens.wnormalProbes[row]
            for (c in 0 until 4) {
                assertEquals("wnormal[${k + c}]", p[c].toInt(), tex[k + c].toInt() and 0xFF)
            }
        }
        assertEquals(WaterGoldens.wnormalByteSum.toLong(), byteSum(tex))
    }

    @Test
    fun waterQuads_bitParity() {
        val hm = hm1337()
        val quads = WaterMath.buildWaterQuads(hm, 128, hm.half * 3.0)
        assertEquals("quad count", WaterGoldens.quadCount.toLong(), (quads.size / 4).toLong())
        for (i in WaterGoldens.quadProbes.indices) {
            assertEquals("quad[$i]", WaterGoldens.quadProbes[i], quads[i], 1e-9)
        }
    }

    @Test
    fun toHalfFloat_bitParity() {
        val heights = listOf(-24.5, -8.25, -0.5, -0.05, 0.0, 0.05, 1.5, 6.75, 24.0, 96.125, 172.0, 320.5, 512.0, 700.75)
        for ((i, h) in heights.withIndex()) {
            assertEquals("half[$h]", WaterGoldens.halfProbes[i].toInt(), WaterMath.toHalfFloat(h))
        }
    }
}
