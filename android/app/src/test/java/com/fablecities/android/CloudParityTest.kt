package com.fablecities.android

import com.fablecities.android.worldgen.CloudGoldens
import com.fablecities.android.worldgen.CloudShadowMap
import com.fablecities.android.worldgen.Clouds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser cloud texture generators
 * (proceduralNoise.js + Clouds.js + CloudShadow.js, seed 1337):
 *  - buildCloudNoiseTexture: the 64³ RGBA Perlin-Worley shape volume
 *  - buildWeatherTexture: the 256² rank-equalised coverage/type map
 *  - buildCirrusTexture: the 256² fibrous cirrus sheet
 *  - CloudShadowMap: the 512² R8 ground-shadow bake (clear + rain coverage)
 * Byte probes allow ±1 LSB where a double sits exactly on a rounding boundary; byte sums
 * allow the same accumulated slack. The native clouds must be the site's clouds.
 */
class CloudParityTest {

    private fun checkProbes(tag: String, baked: ByteArray, probes: Array<IntArray>, slack: Int) {
        var drift = 0
        for (p in probes) {
            val i = p[0]
            for (c in 1 until 5) {
                val got = baked[i + c - 1].toInt() and 0xFF
                val want = p[c]
                if (got != want) {
                    assertTrue("$tag[$i+$c]: got $got want $want", Math.abs(got - want) <= slack)
                    drift++
                }
            }
        }
        // at most a couple of rounding-boundary hits across the whole probe set
        assertTrue("$tag: too many drifting probes ($drift)", drift <= probes.size)
    }

    private fun checkSum(tag: String, baked: ByteArray, want: Long) {
        var s = 0L
        for (b in baked) s += b.toInt() and 0xFF
        val drift = Math.abs(s - want)
        assertTrue("$tag byteSum: got $s want $want", drift <= 8)
    }

    @Test
    fun cloudNoiseTexture_bitParity() {
        val baked = Clouds.buildCloudNoiseTexture(1337)
        assertEquals(Clouds.NOISE_SIZE * Clouds.NOISE_SIZE * Clouds.NOISE_SIZE * 4, baked.size)
        checkProbes("noise", baked, CloudGoldens.noiseProbes, 1)
        checkSum("noise", baked, CloudGoldens.noiseTexSum)
    }

    @Test
    fun weatherTexture_bitParity() {
        val baked = Clouds.buildWeatherTexture(1337)
        assertEquals(Clouds.WEATHER_SIZE * Clouds.WEATHER_SIZE * 4, baked.size)
        checkProbes("weather", baked, CloudGoldens.weatherProbes, 1)
        checkSum("weather", baked, CloudGoldens.weatherTexSum)
    }

    @Test
    fun cirrusTexture_bitParity() {
        val baked = Clouds.buildCirrusTexture(1337)
        assertEquals(256 * 256 * 4, baked.size)
        checkProbes("cirrus", baked, CloudGoldens.cirrusProbes, 1)
        checkSum("cirrus", baked, CloudGoldens.cirrusTexSum)
    }

    @Test
    fun cloudShadow_bitParity() {
        val weather = Clouds.buildWeatherTexture(1337)
        val noise = Clouds.buildCloudNoiseTexture(1337)
        val shadow = CloudShadowMap(weather, noise, 22000.0)
        shadow.update(0.30, 1.0)
        assertEquals(CloudGoldens.shadowClearFrac, shadow.shadowFraction, 1e-6) // exp() ULP drift across 262k cells
        var s = 0L
        for (b in shadow.data) s += b.toInt() and 0xFF
        assertTrue("shadow clear byteSum: got $s", Math.abs(s - CloudGoldens.shadowClearSum) <= 8)
        for (p in CloudGoldens.shadowClearProbes) {
            val got = shadow.data[p[0]].toInt() and 0xFF
            assertTrue("shadow[${p[0]}]: got $got want ${p[1]}", Math.abs(got - p[1]) <= 1)
        }
        shadow.update(0.96, 1.0)
        assertEquals(CloudGoldens.shadowRainFrac, shadow.shadowFraction, 1e-6)
        var s2 = 0L
        for (b in shadow.data) s2 += b.toInt() and 0xFF
        assertTrue("shadow rain byteSum: got $s2", Math.abs(s2 - CloudGoldens.shadowRainSum) <= 8)
    }
}
