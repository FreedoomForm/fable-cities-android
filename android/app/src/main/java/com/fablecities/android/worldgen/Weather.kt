package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.sin

/**
 * Kotlin port of src/modules/environment/Weather.js — weather state: presets per weather
 * type, smooth transitions, wetness / snow accumulation and a slowly wandering wind.
 * Everything is driven by real seconds and is deterministic per seed.
 *
 * Bit-exactness notes:
 *  - the JS `seed ^ 0x77ea` is a 32-bit int XOR, reproduced with Int XOR before SimplexNoise
 *  - damp() is the web shared/math.js damp: lerp(current, target, 1 - exp(-lambda*dt))
 *  - wind starts as THREE.Vector2(0.7, 0.3).normalize() — same component math here
 *  - all state keys are smoothed in the web's SMOOTHED array order (irrelevant numerically —
 *    each key is independent — but kept for review parity)
 *
 * Pinned by WeatherParityTest against tools/probe_weather.mjs running the REAL web Weather.js.
 */
object WeatherPresets {
    //  cover    cumulus coverage 0..1          type     0 stratus .. 1 cumulus
    //  cirrus   high-altitude veil coverage    fog      exp2 density (1/m)        fogH  height-fog scale (m)
    //  fogFloor uniform-haze floor 0..1        turbidity aerosol load             sun   direct-sun fraction between the clouds
    //  diffuse  fraction of the blocked sunlight re-emitted downward as diffuse skylight
    //  milk     how much the fog medium is the luminous overcast diffuser
    //  skyFog   how much the sky dome dissolves into the fog colour
    /** [cover, type, cirrus, fog, fogH, fogFloor, turbidity, sun, diffuse, milk, skyFog, wind, rain, snow, temp, density] */
    val CLEAR = doubleArrayOf(0.30, 0.88, 0.26, 0.000560, 620.0, 0.38, 2.0, 1.00, 0.55, 0.00, 0.00, 0.35, 0.0, 0.0, 22.0, 0.040)
    val CLOUDY = doubleArrayOf(0.60, 0.72, 0.45, 0.000720, 560.0, 0.42, 3.0, 0.72, 0.55, 0.35, 0.18, 0.55, 0.0, 0.0, 16.0, 0.042)
    val RAIN = doubleArrayOf(0.96, 0.30, 0.20, 0.001050, 420.0, 0.46, 5.0, 0.08, 0.38, 0.60, 0.55, 0.85, 1.0, 0.0, 12.0, 0.045)
    val FOG = doubleArrayOf(0.55, 0.35, 0.00, 0.002300, 150.0, 0.42, 5.5, 0.26, 0.62, 1.00, 0.92, 0.10, 0.0, 0.0, 9.0, 0.035)
    val SNOW = doubleArrayOf(0.93, 0.35, 0.10, 0.001150, 400.0, 0.46, 5.5, 0.13, 0.50, 0.80, 0.65, 0.50, 0.0, 1.0, -3.0, 0.040)

    // web SMOOTHED key indices into the preset row
    const val I_COVER = 0
    const val I_TYPE = 1
    const val I_CIRRUS = 2
    const val I_FOG = 3
    const val I_FOGH = 4
    const val I_FOGFLOOR = 5
    const val I_TURBIDITY = 6
    const val I_SUN = 7
    const val I_DIFFUSE = 8
    const val I_MILK = 9
    const val I_SKYFOG = 10
    const val I_DENSITY = 15
    const val I_WIND = 11
    const val I_RAIN = 12
    const val I_SNOW = 13
    const val I_TEMP = 14

    val SMOOTHED = intArrayOf(I_COVER, I_TYPE, I_CIRRUS, I_FOG, I_FOGH, I_FOGFLOOR, I_TURBIDITY, I_SUN, I_DIFFUSE, I_MILK, I_SKYFOG, I_DENSITY)

    fun preset(name: String): DoubleArray? = when (name) {
        "clear" -> CLEAR
        "cloudy" -> CLOUDY
        "rain" -> RAIN
        "fog" -> FOG
        "snow" -> SNOW
        else -> null
    }
}

fun weatherDamp(current: Double, target: Double, lambda: Double, dt: Double): Double {
    val t = 1.0 - exp(-lambda * dt)
    return current + (target - current) * t
}

class WeatherState {
    @JvmField val keys = DoubleArray(16) // preset row layout, smoothed
    @JvmField var precipitation = 0.0
    @JvmField var wetness = 0.0
    @JvmField var snowCover = 0.0
    @JvmField var windX = 0.0
    @JvmField var windZ = 0.0
    @JvmField var windStrength = 0.0
}

class Weather(seed: Int, initial: String = "clear") {
    /** The seed actually handed to SimplexNoise (web: `seed ^ 0x77ea`), exposed for tests. */
    val seedForTest: Int = seed xor 0x77ea
    val noise: SimplexNoise = SimplexNoise(seed xor 0x77ea)
    var name: String = if (WeatherPresets.preset(initial) != null) initial else "clear"
    val state = WeatherState()
    var wetness: Double
        get() = state.wetness
        set(v) { state.wetness = v }
    var snowCover: Double
        get() = state.snowCover
        set(v) { state.snowCover = v }
    var windStrength: Double
        get() = state.windStrength
        set(v) { state.windStrength = v }
    var time: Double = 0.0
        private set
    private val windAngleBase: Double = noise.noise2D(0.5, 0.5) * PI

    init {
        val p = WeatherPresets.preset(name)!!
        System.arraycopy(p, 0, state.keys, 0, 16)
        state.precipitation = if (p[WeatherPresets.I_RAIN] != 0.0) p[WeatherPresets.I_RAIN] else p[WeatherPresets.I_SNOW]
        state.wetness = if (p[WeatherPresets.I_RAIN] != 0.0) 1.0 else 0.0
        state.snowCover = if (p[WeatherPresets.I_SNOW] != 0.0) 1.0 else 0.0
        // THREE.Vector2(0.7, 0.3).normalize()
        val h = hypot(0.7, 0.3)
        state.windX = 0.7 / h
        state.windZ = 0.3 / h
        state.windStrength = p[WeatherPresets.I_WIND]
    }

    /** Switch weather. `instant` snaps all smoothed values. */
    fun set(name: String, instant: Boolean = false): Boolean {
        if (WeatherPresets.preset(name) == null) return false
        this.name = name
        if (instant) snap()
        return true
    }

    fun snap() {
        val p = WeatherPresets.preset(name)!!
        System.arraycopy(p, 0, state.keys, 0, 16)
        state.precipitation = if (p[WeatherPresets.I_RAIN] != 0.0) p[WeatherPresets.I_RAIN] else p[WeatherPresets.I_SNOW]
        state.wetness = if (p[WeatherPresets.I_RAIN] != 0.0) 1.0 else 0.0
        state.snowCover = if (p[WeatherPresets.I_SNOW] != 0.0) 1.0 else 0.0
        state.windStrength = p[WeatherPresets.I_WIND]
    }

    /** dt: real seconds (transitions); gameSeconds: game clock for the deterministic wind wander. */
    fun update(dt: Double, gameSeconds: Double? = null) {
        time = if (gameSeconds != null) gameSeconds / 180.0 else time + dt // 180 game-s per real-s at speed 1
        val p = WeatherPresets.preset(name)!!
        val s = state.keys
        val k = 0.32 // ~10 s transitions
        for (key in WeatherPresets.SMOOTHED) s[key] = weatherDamp(s[key], p[key], k, dt)
        s[WeatherPresets.I_TEMP] = weatherDamp(s[WeatherPresets.I_TEMP], p[WeatherPresets.I_TEMP], 0.1, dt)
        val precipTarget = if (p[WeatherPresets.I_RAIN] != 0.0) p[WeatherPresets.I_RAIN] else p[WeatherPresets.I_SNOW]
        state.precipitation = weatherDamp(state.precipitation, precipTarget, k, dt)
        // wetness rises fast in rain, dries slowly afterwards
        val rainTarget = p[WeatherPresets.I_RAIN]
        state.wetness = if (rainTarget > state.wetness) minOf(1.0, state.wetness + dt / 18.0) else maxOf(0.0, state.wetness - dt / 120.0)
        val snowTarget = p[WeatherPresets.I_SNOW]
        state.snowCover = if (snowTarget > state.snowCover) minOf(1.0, state.snowCover + dt / 45.0) else maxOf(0.0, state.snowCover - dt / 240.0)
        // wind wanders slowly
        state.windStrength = weatherDamp(
            state.windStrength,
            p[WeatherPresets.I_WIND] * (0.85 + 0.3 * (0.5 + 0.5 * noise.noise2D(time * 0.02, 3.7))),
            0.2, dt,
        )
        val ang = windAngleBase + noise.noise2D(time * 0.004, 11.3) * 1.2
        state.windX = cos(ang)
        state.windZ = sin(ang)
    }

    /** Deterministic cloud-drift speed: the preset's nominal wind, never the per-frame wander. */
    val driftWind: Double
        get() = WeatherPresets.preset(name)!![WeatherPresets.I_WIND]

    /** Cloud-cover fraction 0..1 (smoothed). */
    val cloudCover: Double
        get() = Environment.clamp01(state.keys[WeatherPresets.I_COVER])

    /** Fraction of direct sunlight passing the cloud deck (smoothed). */
    val sunFactor: Double
        get() = Environment.lerp(1.0, state.keys[WeatherPresets.I_SUN], 1.0)

    // convenience accessors used by the renderer / env
    val turbidity: Double get() = state.keys[WeatherPresets.I_TURBIDITY]
    val fog: Double get() = state.keys[WeatherPresets.I_FOG]
    val fogH: Double get() = state.keys[WeatherPresets.I_FOGH]
    val fogFloor: Double get() = state.keys[WeatherPresets.I_FOGFLOOR]
    val diffuse: Double get() = state.keys[WeatherPresets.I_DIFFUSE]
    val milk: Double get() = state.keys[WeatherPresets.I_MILK]
    val skyFog: Double get() = state.keys[WeatherPresets.I_SKYFOG]
    val precipitation: Double get() = state.precipitation
}
