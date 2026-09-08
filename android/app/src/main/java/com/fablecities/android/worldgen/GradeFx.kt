package com.fablecities.android.worldgen

/**
 * Bit-exact port of the effects/index.js post-chain driver: the weather-state damp chains
 * (rainAmt / snowAmt / wetness / snowCover), the colour-grade uniform transitions, and the
 * sun-glare / auto-exposure screen terms that feed ColorGradingPass. Pinned by
 * GradeParityTest against tools/probe_grade.mjs running the REAL web modules.
 *
 * All arithmetic follows the JS operation order (Double math) so values match bit-for-bit.
 */
object GradeFx {
    // shared/math.js
    fun clamp01(v: Double): Double = if (v < 0.0) 0.0 else if (v > 1.0) 1.0 else v
    fun lerp(a: Double, b: Double, t: Double): Double = a + (b - a) * t
    fun smoothstep(x: Double, y: Double, t0: Double): Double {
        val t = if (t0 < x) 0.0 else if (t0 > y) 1.0 else (t0 - x) / (y - x)
        return t * t * (3.0 - 2.0 * t)
    }
    fun damp(current: Double, target: Double, lambda: Double, dt: Double): Double =
        lerp(current, target, 1.0 - Math.exp(-lambda * dt))

    /** The per-frame environment inputs (the pinned computeFrame fields). */
    class EnvIn(
        @JvmField val weather: String,
        @JvmField val sunIntensity: Double,
        @JvmField val sunColor: DoubleArray,   // unit sun colour
        @JvmField val nightFactor: Double,
        @JvmField val sunToward: DoubleArray,  // direction TOWARD the sun (env.sunDirection = -this)
        @JvmField val precipitation: Double,
        @JvmField val wetness: Double,         // env wetness (weather.wetness × (1-snowCover))
        @JvmField val snow: Double,            // env snow cover
        @JvmField val cloudCover: Double,
    )

    /** Full driver state (effects/index.js S + ColorGradingPass uniforms). */
    class State {
        @JvmField var warmed = false
        @JvmField var time = 0.0
        // effects weather-state chain
        @JvmField var rainAmt = 0.0
        @JvmField var snowAmt = 0.0
        @JvmField var wetness = 0.0
        @JvmField var snowCover = 0.0
        // grade uniforms (ColorGradingPass constructor defaults)
        @JvmField var uContrast = 1.35
        @JvmField var uToe = 0.2
        @JvmField var uShoulder = 0.34
        @JvmField var uBlack = 0.0012
        @JvmField var uSaturation = 1.0
        @JvmField var uMidSat = 0.18
        @JvmField var uHiDesat = 0.15
        @JvmField var uExposure = 1.0
        @JvmField var adaptBlend = 1.0
        @JvmField var uTint = doubleArrayOf(1.0, 1.0, 1.0)
        @JvmField var uShadowTint = doubleArrayOf(0.93, 0.965, 1.07)
        @JvmField var uHighlightTint = doubleArrayOf(1.06, 1.0, 0.93)
        @JvmField var uLift = doubleArrayOf(0.0, 0.0, 0.0)
        @JvmField var uGain = doubleArrayOf(1.0, 1.0, 1.0)
        @JvmField var uVignette = doubleArrayOf(0.14, 0.52)
        @JvmField var uAuto = doubleArrayOf(2.5, 0.9, 1.85, 0.0)
        @JvmField var uSun = doubleArrayOf(0.0, 0.0, 0.0, 0.0)
        @JvmField var uSunColor = doubleArrayOf(1.0, 0.95, 0.85)
        @JvmField var uGlare = 1.0
        @JvmField var probeActive = false
    }

    /** One driver step. `project` maps a world point to NDC (x, y, z<1 on screen) — the
     *  renderer passes the real camera; the parity test passes the probe's replica. */
    fun step(
        S: State, dt: Double, env: EnvIn,
        camPos: DoubleArray, project: (DoubleArray) -> DoubleArray,
    ) {
        S.time += dt
        val travelY = -env.sunToward[1]      // effects sunDir = travel direction; -sunDir.y = elevation term
        val sunUp = smoothstep(-0.04, 0.10, travelY)
        val night = clamp01(env.nightFactor)
        val cloud = clamp01(env.cloudCover)
        val w = env.weather
        val snowing = w == "snow"
        val raining = w == "rain" || w == "storm"
        val precip = clamp01(env.precipitation)
        val rainTarget = if (snowing) 0.0 else if (raining) precip else 0.0
        val snowTarget = if (snowing) precip else 0.0
        if (!S.warmed) {
            S.warmed = true
            S.rainAmt = rainTarget
            S.snowAmt = snowTarget
            S.wetness = if (rainTarget > 0.02) maxOf(clamp01(env.wetness), Math.min(rainTarget + 0.3, 1.0)) else clamp01(env.wetness)
            S.snowCover = if (snowTarget > 0.02) 1.0 else clamp01(env.snow)
        }
        S.rainAmt = damp(S.rainAmt, rainTarget, 2.5, dt)
        S.snowAmt = damp(S.snowAmt, snowTarget, 2.5, dt)
        val envWet = clamp01(env.wetness)
        val wetTarget = if (S.rainAmt > 0.02) Math.max(envWet, Math.min(S.rainAmt + 0.3, 1.0)) else envWet
        if (wetTarget >= S.wetness) S.wetness = damp(S.wetness, wetTarget, 1.5, dt)
        else S.wetness = Math.max(wetTarget, S.wetness - dt / 300.0 * (0.3 + 0.7 * sunUp * (1.0 - 0.6 * cloud)))
        val envSnow = clamp01(env.snow)
        val snowTargetC = Math.max(envSnow, if (S.snowAmt > 0.02) 1.0 else 0.0)
        if (snowTargetC >= S.snowCover) S.snowCover = damp(S.snowCover, snowTargetC, 3.0, dt)
        else S.snowCover = Math.max(snowTargetC, S.snowCover - dt / 600.0 * (0.2 + 0.8 * sunUp))
        if (S.wetness < 0.002) S.wetness = 0.0
        if (S.snowCover < 0.002) S.snowCover = 0.0

        // ---------- colour grading block ----------
        val wet = S.wetness
        val snow = S.snowCover
        val snowAmt = S.snowAmt
        val rainAmt = S.rainAmt
        val lowSun = (1.0 - smoothstep(0.06, 0.42, travelY)) * sunUp * (1.0 - night)
        val L = 5.0
        val k = 1.0 - Math.exp(-L * dt)
        val dayA = 1.0 - night
        S.uContrast = damp(S.uContrast, (1.52 - night * 0.26 - cloud * 0.05 - wet * 0.03 - snowAmt * 0.08 - snow * 0.06) * 1.0, L, dt)
        S.uToe = damp(S.uToe, -0.58 * dayA * (1.0 - 0.15 * cloud) * (1.0 - 0.12 * wet) * (1.0 - 0.6 * snow) + 0.18 * night + 0.10 * snow * dayA, L, dt)
        S.uShoulder = damp(S.uShoulder, 0.34 + snow * 0.06 + lowSun * 0.20, L, dt)
        S.uBlack = damp(S.uBlack, 0.0072 * dayA * (1.0 - 0.15 * cloud) * (1.0 - snow * 0.7) + 0.0026 * night, L, dt)
        run {
            val highSun = smoothstep(0.35, 0.75, travelY)
            val wPost = 3.60 + 0.55 * snow + 0.15 * cloud
            val sh = S.uShoulder
            val ct = Math.max(S.uContrast, 0.5)
            var lcp = Math.log(wPost / 0.18) / Math.log(2.0)
            if (lcp > 2.9) lcp = (lcp - 2.9 * 0.3 * sh) / (1.0 - 0.3 * sh)
            val wPre = 0.18 * Math.pow(2.0, lcp / ct)
            val gMax = (1.22 + 0.32 * cloud + 0.14 * wet - 0.10 * highSun) * dayA + 1.14 * night
            S.uAuto[0] = wPre
            S.uAuto[1] = 0.72 * dayA + 0.9 * night
            S.uAuto[2] = gMax
            S.uAuto[3] = 0.5 + 0.2 * dayA
        }
        S.adaptBlend = Math.exp(-1.5 * Math.min(dt, 0.1))
        S.uExposure = damp(S.uExposure, 1.0, L, dt)
        S.uSaturation = damp(S.uSaturation, (1.16 - night * 0.10 - wet * 0.08 - cloud * 0.03 - snowAmt * 0.06 - snow * 0.02 + lowSun * 0.03) * 1.0, L, dt)
        S.uMidSat = damp(S.uMidSat, 0.17 * (1.0 - night * 0.6) * (1.0 - wet * 0.5) * (1.0 - snowAmt * 0.4), L, dt)
        S.uHiDesat = damp(S.uHiDesat, 0.11 + lowSun * 0.06 + snowAmt * 0.06 + night * 0.05, L, dt)
        run {
            fun mix3(a: DoubleArray, b: DoubleArray, t: Double): DoubleArray =
                doubleArrayOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
            var v = doubleArrayOf(1.0, 1.0, 1.0)
            v = mix3(v, doubleArrayOf(0.96, 0.98, 1.04), night * 0.5)
            v = mix3(v, doubleArrayOf(1.06, 1.0, 0.93), lowSun * 0.6)
            v = mix3(v, doubleArrayOf(0.965, 0.985, 1.03), clamp01(wet * 0.8))
            v = mix3(v, doubleArrayOf(0.985, 0.995, 1.025), snowAmt * 0.6)
            S.uTint = mix3(S.uTint, v, k)
            var shv = doubleArrayOf(0.85, 0.94, 1.20)
            shv = mix3(shv, doubleArrayOf(0.94, 0.97, 1.08), night)
            shv = mix3(shv, doubleArrayOf(0.85, 0.93, 1.20), snow * 0.7)
            S.uShadowTint = mix3(S.uShadowTint, shv, k)
            var hiv = doubleArrayOf(1.08, 1.0, 0.90)
            hiv = mix3(hiv, doubleArrayOf(1.04, 1.0, 0.96), night)
            hiv = mix3(hiv, doubleArrayOf(1.0, 1.0, 1.0), clamp01(wet + snowAmt))
            S.uHighlightTint = mix3(S.uHighlightTint, hiv, k)
            var lv = doubleArrayOf(0.0058, 0.0064, 0.0082)
            lv = mix3(lv, doubleArrayOf(0.0028, 0.0032, 0.0044), night)
            lv = mix3(lv, doubleArrayOf(0.0068, 0.0074, 0.0094), snow * 0.5 * (1.0 - night))
            S.uLift = mix3(S.uLift, lv, k)
            val gain = 1.0 - wet * 0.04 + snow * 0.03
            S.uGain = mix3(S.uGain, doubleArrayOf(gain, gain, gain), k)
        }
        S.uVignette[0] = if ((0.105 - night * 0.03 + wet * 0.02) * 1.0 < 0.0) 0.0 else Math.min((0.105 - night * 0.03 + wet * 0.02) * 1.0, 0.2)
        S.uVignette[1] = 0.52

        // ---------- sun glare screen terms ----------
        val p = project(doubleArrayOf(camPos[0] - env.sunToward[0] * 3000.0, camPos[1] - env.sunToward[1] * 3000.0, camPos[2] - env.sunToward[2] * 3000.0))
        if (p[2] < 1.0 && !java.lang.Double.isNaN(p[0])) {
            val edge = Math.max(Math.abs(p[0]), Math.abs(p[1]))
            val highSun = smoothstep(0.12, 0.55, travelY)
            val vis = sunUp * (1.0 - night) * (1.0 - 0.8 * cloud) * (1.0 - rainAmt) * (1.0 - snowAmt) *
                clamp01(env.sunIntensity / 2.5) * (1.0 - smoothstep(1.1, 1.8, edge)) * (1.0 - 0.4 * highSun)
            S.uSun[0] = p[0]; S.uSun[1] = p[1]; S.uSun[2] = vis; S.uSun[3] = 0.0
            S.probeActive = vis > 0.001
        } else {
            S.uSun[2] = 0.0
            S.probeActive = false
        }
        run {
            val sc = env.sunColor
            // the web: sqrt(clamp(sunIntensity / 3.5, 0.15, 1.2)) — asymmetric bounds
            val x = env.sunIntensity / 3.5
            val cx = if (x < 0.15) 0.15 else if (x > 1.2) 1.2 else x
            val s2 = Math.sqrt(cx)
            S.uSunColor[0] = sc[0] * s2; S.uSunColor[1] = sc[1] * s2; S.uSunColor[2] = sc[2] * s2
        }
        S.uGlare = 1.0
    }
}
