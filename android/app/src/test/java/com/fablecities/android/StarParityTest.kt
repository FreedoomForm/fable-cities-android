package com.fablecities.android

import com.fablecities.android.worldgen.StarGoldens
import com.fablecities.android.worldgen.Stars
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser environment/StarField.js:
 *  - buildStarCubeTexture(1337): the Milky Way cube (6 faces, 256² RGBA, chroma+alpha encode)
 *  - buildMoonTexture(1337): the 512×256 equirect moon albedo map (highlands, maria, 180 craters)
 * Expected values were produced by running the actual web code in Node (tools/probe_star.mjs).
 * The native night sky must show the SAME Milky Way and the SAME moon surface as the site.
 */
class StarParityTest {

    private fun byteSum(a: ByteArray): Long {
        var s = 0L
        for (b in a) s += b.toInt() and 0xFF
        return s
    }

    @Test
    fun starCube_bitParity() {
        val faces = Stars.buildStarCubeTexture(1337)
        assertEquals(6, faces.size)
        val sums = longArrayOf(
            StarGoldens.face0Sum.toLong(), StarGoldens.face1Sum.toLong(), StarGoldens.face2Sum.toLong(),
            StarGoldens.face3Sum.toLong(), StarGoldens.face4Sum.toLong(), StarGoldens.face5Sum.toLong(),
        )
        for (f in 0 until 6) {
            assertEquals(256 * 256 * 4, faces[f].size)
            assertEquals("face$f byteSum", sums[f], byteSum(faces[f]))
        }
        for (p in StarGoldens.texelProbes) {
            val f = p[0].toInt(); val k = p[1].toInt()
            for (c in 0 until 4) {
                assertEquals("face$f[$k+$c]", p[2 + c].toInt(), faces[f][k + c].toInt() and 0xFF)
            }
        }
    }

    @Test
    fun moonTexture_bitParity() {
        val moon = Stars.buildMoonTexture(1337)
        assertEquals(512 * 256 * 4, moon.size)
        assertEquals("moon byteSum", StarGoldens.moonSum.toLong(), byteSum(moon))
        for (p in StarGoldens.moonProbes) {
            val k = p[0].toInt()
            assertEquals("moon[$k].r", p[1].toInt(), moon[k].toInt() and 0xFF)
            assertEquals("moon[$k].a", p[2].toInt(), moon[k + 3].toInt() and 0xFF)
        }
    }
}
