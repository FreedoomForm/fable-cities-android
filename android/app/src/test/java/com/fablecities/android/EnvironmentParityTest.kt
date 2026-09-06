package com.fablecities.android

import com.fablecities.android.worldgen.EnvGoldens
import com.fablecities.android.worldgen.Environment
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs

/**
 * Bit-parity golden tests against the REAL browser environment module
 * (src/modules/environment/atmosphere.js + the clear-weather branch of
 * src/modules/environment/index.js computeFrame / sampleSkyAverages).
 * Expected values were produced by running the actual web code in Node
 * (scripts/probe_env.mjs) at the site's defaults: hour 14.0 (Config.js),
 * month 5 (0-indexed June) day 1 -> doy 121, latitude 47.3, clear weather
 * (cover 0.30, turbidity 2.0, sunFactor 1.0, fog 5.6e-4). The native app must
 * light the world with the SAME sky as the site.
 */
class EnvironmentParityTest {

    private fun near(actual: Double, expected: Double, tol: Double, what: String) {
        assertTrue(
            "$what: expected $expected, got $actual (diff ${actual - expected})",
            abs(actual - expected) <= tol
        )
    }

    private fun near3(a: DoubleArray, e: List<Double>, tol: Double, what: String) {
        for (i in 0 until 3) near(a[i], e[i], tol, "$what[$i]")
    }

    @Test
    fun dayOfYear_siteDefaults() {
        // World.js: month 5 (0-indexed June), day 1 -> 121 (atmosphere.js dayOfYear)
        org.junit.Assert.assertEquals(121, Environment.dayOfYear(5, 1))
        org.junit.Assert.assertEquals(1, Environment.dayOfYear(0, 1))
        org.junit.Assert.assertEquals(365, Environment.dayOfYear(11, 31))
    }

    @Test
    fun celestial_bitParity() {
        val lat = Environment.LATITUDE
        val doy = 121
        val cel = DoubleArray(13)
        for (h in listOf(0.0, 8.0, 14.0, 19.5, 22.0)) {
            Environment.celestial(h, doy, lat, cel)
            val g = EnvGoldens.hours["$h"]!!
            near(cel[0] * 180.0 / PI, g.sunAltDeg, 1e-9, "sunAltDeg@$h")
            near3(doubleArrayOf(cel[2], cel[3], cel[4]), g.sunDir, 1e-9, "sunDir@$h")
            near3(doubleArrayOf(cel[7], cel[8], cel[9]), g.moonDir, 1e-9, "moonDir@$h")
            near(cel[11], g.moonIllum, 1e-9, "moonIllum@$h")
        }
    }

    @Test
    fun lightingKey_bitParity() {
        val doy = 121
        val st = Environment.EnvState()
        for ((h, g) in EnvGoldens.hours) {
            Environment.compute(h, doy, Environment.LATITUDE, 24.0, 0.0, -1.0, st)
            near(st.sunAltDeg, g.sunAltDeg, 1e-9, "sunAltDeg@$h")
            near(st.sunIntensity, g.sunIntensity, 1e-9, "sunIntensity@$h")
            near3(st.sunColor, g.sunColor, 1e-9, "sunColor@$h")
            near(st.moonIntensity, g.moonIntensity, 1e-9, "moonIntensity@$h")
            near3(st.moonColor, g.moonColor, 1e-9, "moonColor@$h")
            near(st.exposure, g.exposure, 1e-9, "exposure@$h")
            near(st.nightFactor, g.nightFactor, 1e-9, "nightFactor@$h")
            near3(st.skyAvg, g.skyAvg, 1e-9, "skyAvg@$h")
            near3(st.horizonAvg, g.horizonAvg, 1e-9, "horizonAvg@$h")
            near3(st.sunSideAvg, g.sunSideAvg, 1e-9, "sunSideAvg@$h")
            near(st.hemiIntensity, g.hemiIntensity, 1e-9, "hemiIntensity@$h")
            near(st.hemiRaw, g.hemiRaw, 1e-9, "hemiRaw@$h")
            near(st.floorMix, g.floorMix, 1e-9, "floorMix@$h")
            near3(st.hemiCol, g.hemiCol, 1e-9, "hemiCol@$h")
            near3(st.hemiGround, g.hemiGround, 1e-9, "hemiGround@$h")
            near3(st.groundRad, g.groundRad, 1e-9, "groundRad@$h")
            near3(st.fogColor, g.fogColor, 1e-9, "fogColor@$h")
            near(st.fogDensity, g.fogDensity, 1e-12, "fogDensity@$h")
            near3(st.lightDir, g.lightDir, 1e-9, "lightDir@$h")
        }
    }

    @Test
    fun skyRadiance_bitParity() {
        val dirs = listOf(
            doubleArrayOf(0.0, 1.0, 0.0), doubleArrayOf(0.6, 0.3, -0.74),
            doubleArrayOf(-0.5, 0.1, 0.86), doubleArrayOf(0.2, -0.3, 0.93))
        val cel = DoubleArray(13)
        Environment.celestial(14.0, 121, Environment.LATITUDE, cel)
        val sunDir = doubleArrayOf(cel[2], cel[3], cel[4])
        val moonDir = doubleArrayOf(cel[7], cel[8], cel[9])
        val rad = DoubleArray(3)
        val tr = DoubleArray(3)
        for ((i, d) in dirs.withIndex()) {
            val hits = Environment.skyRadiance(
                d, 24.0, sunDir, moonDir, Environment.SUN_E, 0.0, 2.0,
                Environment.SCATTER_BOOST, 12, 5, rad, tr)
            for (c in 0 until 3) near(rad[c], EnvGoldens.direct[i][c], 1e-9, "direct[$i][$c]")
            val hitE = EnvGoldens.direct[i][3] > 0.5
            org.junit.Assert.assertEquals("direct[$i] hitsGround", hitE, hits)
        }
    }

    @Test
    fun exposureCurve_keyPoints() {
        near(Environment.exposureForSun(-90.0), 3.15, 1e-12, "exp(-90)")
        near(Environment.exposureForSun(-3.0), 2.25, 1e-12, "exp(-3)")
        near(Environment.exposureForSun(10.0), 1.75, 1e-12, "exp(10)")
        near(Environment.exposureForSun(30.0), 1.37, 1e-12, "exp(30)")
        near(Environment.nightFactorForSun(14.0 * 0.0 + 10.0), 0.0, 1e-12, "nf(day)")
        near(Environment.nightFactorForSun(-27.8), 1.0, 1e-12, "nf(night)")
    }
}
