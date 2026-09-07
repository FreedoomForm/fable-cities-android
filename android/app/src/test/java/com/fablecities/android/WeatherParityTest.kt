package com.fablecities.android

import com.fablecities.android.worldgen.Environment
import com.fablecities.android.worldgen.Weather
import com.fablecities.android.worldgen.WeatherGoldens
import com.fablecities.android.worldgen.WeatherPresets
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser environment/Weather.js:
 *  - constructor init state for all five presets (smoothed keys, precipitation, wetness,
 *    snowCover, wind direction/strength)
 *  - the clear→rain→snow→fog transition sequence driven by the site's gameSeconds clock
 *    (smoothing curves, wetness/snow accumulation, the deterministic wind wander)
 *  - the real-time update path (gameSeconds = null)
 *  - drying after rain (the slow −dt/120 wetness decay)
 *  - the derived getters (cloudCover / sunFactor / driftWind / turbidity / fog / milk / skyFog)
 * Expected values were produced by running the actual web code in Node (tools/probe_weather.mjs).
 * The native weather must transition EXACTLY like the site's.
 */
class WeatherParityTest {

    private fun assertRow(tag: String, actual: DoubleArray, expected: DoubleArray) {
        assertEquals("$tag row length", expected.size, actual.size)
        for (i in expected.indices) {
            assertEquals("$tag[$i]", expected[i], actual[i], 0.0)
        }
    }

    private fun snapshot(w: Weather): DoubleArray =
        doubleArrayOf(*w.state.keys, w.state.precipitation, w.state.wetness, w.state.snowCover, w.state.windX, w.state.windZ, w.state.windStrength)

    @Test
    fun init_allPresets_bitParity() {
        val goldens = mapOf(
            "clear" to WeatherGoldens.INIT_CLEAR,
            "cloudy" to WeatherGoldens.INIT_CLOUDY,
            "rain" to WeatherGoldens.INIT_RAIN,
            "fog" to WeatherGoldens.INIT_FOG,
            "snow" to WeatherGoldens.INIT_SNOW,
        )
        for ((name, golden) in goldens) {
            val w = Weather(WeatherGoldens.SEED, name)
            assertEquals(name, WeatherGoldens.SEED xor 0x77ea, w.seedForTest)
            assertRow("init:$name", snapshot(w), golden)
        }
    }

    @Test
    fun init_unknownFallsBackToClear() {
        val w = Weather(WeatherGoldens.SEED, "typhoon")
        assertEquals("clear", w.name)
        assertRow("init:fallback", snapshot(w), WeatherGoldens.INIT_CLEAR)
        // set() with an unknown name is a no-op that returns false
        assertEquals(false, w.set("storm"))
        assertEquals("clear", w.name)
        assertEquals(true, w.set("rain"))
        assertEquals("rain", w.name)
    }

    @Test
    fun transitionSequence_bitParity() {
        // the probe's exact sequence: clear@hour14 → rain (20 steps) → snow (20) → fog (20)
        val w = Weather(WeatherGoldens.SEED, "clear")
        var gameSeconds = 14.0 * 3600.0
        assertEquals("clear_t0", WeatherGoldens.SEQ_TAGS[0])
        assertEquals("fog_t19", WeatherGoldens.SEQ_TAGS[WeatherGoldens.SEQ_TAGS.size - 1])
        var step = 0
        val snap = { doubleArrayOf(*snapshot(w), w.time) } // rows include the weather clock
        assertRow(WeatherGoldens.SEQ_TAGS[step++], snap(), WeatherGoldens.SEQ_ROWS[0])
        w.set("rain")
        for (i in 0 until 20) {
            w.update(0.5, gameSeconds); gameSeconds += 15.0
            if (i == 4 || i == 9 || i == 19) assertRow(WeatherGoldens.SEQ_TAGS[step++], snap(), WeatherGoldens.SEQ_ROWS[step - 1])
        }
        w.set("snow")
        for (i in 0 until 20) {
            w.update(0.5, gameSeconds); gameSeconds += 15.0
            if (i == 9 || i == 19) assertRow(WeatherGoldens.SEQ_TAGS[step++], snap(), WeatherGoldens.SEQ_ROWS[step - 1])
        }
        w.set("fog")
        for (i in 0 until 20) {
            w.update(0.5, gameSeconds); gameSeconds += 15.0
            if (i == 9 || i == 19) assertRow(WeatherGoldens.SEQ_TAGS[step++], snap(), WeatherGoldens.SEQ_ROWS[step - 1])
        }
        assertEquals(WeatherGoldens.SEQ_TAGS.size, step)
    }

    @Test
    fun realtimePath_bitParity() {
        val w = Weather(WeatherGoldens.SEED, "cloudy")
        for (i in 0 until 8) w.update(0.25)
        val got = snapshot(w) + doubleArrayOf(w.time)
        assertRow("realtime", got, WeatherGoldens.REALTIME_CLOUDY_8)
    }

    @Test
    fun dryingAfterRain_bitParity() {
        val w = Weather(WeatherGoldens.SEED, "rain")
        w.update(0.5, 3600.0)
        w.set("clear")
        for (i in 0 until 360) w.update(0.5, 3600.0 + i * 0.5)
        assertRow("drying", snapshot(w), WeatherGoldens.DRYING_AFTER_RAIN)
    }

    @Test
    fun derivedGetters_bitParity() {
        val w = Weather(WeatherGoldens.SEED, "cloudy")
        for (i in 0 until 12) w.update(0.5, 43200.0 + i * 15.0)
        val got = doubleArrayOf(
            w.cloudCover, w.sunFactor, w.driftWind, w.turbidity, w.fog, w.milk, w.skyFog, w.precipitation,
        )
        assertRow("derived", got, WeatherGoldens.DERIVED_CLOUDY)
        // driftWind is the PRESET wind, not the damped state (seed+time reproducibility contract)
        assertEquals(WeatherPresets.CLOUDY[WeatherPresets.I_WIND], w.driftWind, 0.0)
    }
}
