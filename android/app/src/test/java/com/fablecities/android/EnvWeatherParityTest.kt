package com.fablecities.android

import com.fablecities.android.worldgen.EnvWeatherGoldens
import com.fablecities.android.worldgen.Environment
import com.fablecities.android.worldgen.Weather
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden tests for the FULL-weather lighting key (environment/index.js computeFrame
 * weather branch) against the REAL web Weather.js presets + atmosphere.js in Node
 * (tools/probe_env_weather.mjs): 5 presets x 4 hours (08:00, 14:00, 19:30, 22:00),
 * each row pinning sun/moon state, intensity/colour keys, exposure, night factors,
 * hemisphere light, ground radiance, fog colour/density/height/sun-glow/ceiling,
 * directional aerial perspective and wetness/snow outputs.
 * The native renderer must light storms, fog and snow EXACTLY like the site.
 */
class EnvWeatherParityTest {

    @Test
    fun allPresets_bitParity() {
        val doy = Environment.dayOfYear(Environment.DEFAULT_MONTH, Environment.DEFAULT_DAY)
        assertEquals(121, doy)
        for (t in EnvWeatherGoldens.TAGS.indices) {
            val tag = EnvWeatherGoldens.TAGS[t]
            val preset = tag.substringBefore('_')
            val hour = tag.substringAfter('_').toDouble()
            val w = Weather(1337, preset)
            val st = Environment.EnvState()
            Environment.compute(hour, doy, Environment.LATITUDE, 24.0, 0.0, -1.0, st, w.state)

            val got = ArrayList<Double>(64)
            got.add(st.sunAltDeg); got.add(st.moonAltDeg); got.add(st.moonIllum)
            for (v in st.sunDir) got.add(v)
            for (v in st.moonDir) got.add(v)
            for (v in st.lightDir) got.add(v)
            got.add(st.sunIntensity); for (v in st.sunColor) got.add(v)
            got.add(st.moonIntensity); for (v in st.moonColor) got.add(v)
            got.add(st.exposure); got.add(st.nightFactor); got.add(st.nightAmount)
            for (v in st.skyAvg) got.add(v)
            for (v in st.horizonAvg) got.add(v)
            for (v in st.sunSideAvg) got.add(v)
            got.add(st.hemiIntensity); got.add(st.hemiRaw); got.add(st.floorMix)
            for (v in st.hemiCol) got.add(v)
            for (v in st.hemiGround) got.add(v)
            for (v in st.groundRad) got.add(v)
            for (v in st.fogColor) got.add(v)
            got.add(st.fogDensity); got.add(st.fogH); got.add(st.fogFloor); got.add(st.fogSunGlow); got.add(st.fogMax)
            for (v in st.fogWarm) got.add(v)
            for (v in st.fogCool) got.add(v)
            got.add(st.wetness); got.add(st.snowCover); got.add(st.cloudCover); got.add(st.sunFactor); got.add(st.skyFog)

            val row = EnvWeatherGoldens.ROWS[t]
            assertEquals("$tag row length", row.size, got.size)
            // 1e-9 like EnvironmentParityTest: sin/cos/pow differ by <=1 ULP between libms,
            // everything downstream is exact arithmetic on those values
            for (i in row.indices) {
                assertEquals("$tag[$i]", row[i], got[i], 1e-9)
            }
        }
    }
}
