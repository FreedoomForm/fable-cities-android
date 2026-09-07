package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Kotlin port of the browser game's environment core:
 *   src/modules/environment/atmosphere.js (CPU single-scattering sky + ephemeris + exposure)
 *   and the clear-weather branch of src/modules/environment/index.js computeFrame /
 *   sampleSkyAverages (the site's lighting key logic).
 *
 * Golden values pinned by EnvironmentParityTest were produced by running the REAL web
 * code in Node (scripts/probe_env.mjs) at the site's defaults:
 *   hour 14.0 (Config.js), month 5 (0-indexed June) + day 1 -> doy 121,
 *   latitude 47.3, clear weather (cover 0.30, turbidity 2.0, sunFactor 1.0,
 *   fog 5.6e-4, milk 0, skyFog 0, precip 0, snow 0).
 *
 * Double math everywhere to match JS semantics; the radiance units are the web's
 * renderer units (a directional light of ~3.5 == the noon sun).
 */
object Environment {

    // ---- atmosphere.js ATMOS constants ----
    const val PLANET_R = 6371e3
    const val ATMO_R = 6471e3
    val BETA_R = doubleArrayOf(5.802e-6, 13.558e-6, 33.1e-6)
    const val BETA_M = 3.996e-6
    const val BETA_MA = 4.4e-6
    val BETA_O = doubleArrayOf(1.95e-6, 5.64e-6, 0.25e-6)
    const val H_R = 8000.0
    const val H_M = 1200.0
    const val MIE_G = 0.80
    const val SUN_E = 4.0
    const val SCATTER_BOOST = 2.3
    const val MS_K = 0.04
    val MS_SPECTRUM = doubleArrayOf(0.6, 0.82, 1.35)
    const val MS_SUN_ATTEN = 0.45
    const val MIE_BOOST = 0.75

    // ---- environment/index.js constants ----
    val MOON_COLOR = doubleArrayOf(0.62, 0.72, 1.0)
    const val MOON_LIGHT = 0.26
    const val MOON_SKY_E = 0.065
    val GROUND_ALBEDO = doubleArrayOf(0.30, 0.29, 0.24)
    val SNOW_ALBEDO = doubleArrayOf(0.78, 0.80, 0.86)
    val TWILIGHT_SKY = doubleArrayOf(0.36, 0.47, 0.85)
    val GOLDEN_SKY = doubleArrayOf(0.40, 0.50, 0.78)
    val COOL_BOUNCE = doubleArrayOf(0.62, 0.70, 0.92)
    val NIGHT_FLOOR = doubleArrayOf(0.0159, 0.0226, 0.0398)
    const val NIGHT_KEY = 0.104 * 3.15
    const val AMBIENT_K = 3.3
    val KEY_WARM = doubleArrayOf(1.0, 0.935, 0.80)
    val NIGHT_GLOW = doubleArrayOf(0.0011, 0.0031, 0.0125) // SkyDome uNightGlow
    const val MIN_SHADOW_ELEV = 2.5 * PI / 180.0

    // clear weather preset (WEATHER_PRESETS.clear) — weather module port is a later slice
    const val CLEAR_COVER = 0.30
    const val CLEAR_TURBIDITY = 2.0
    const val CLEAR_SUN_FACTOR = 1.00
    const val CLEAR_FOG = 0.000560
    const val CLEAR_DIFFUSE = 0.55

    // site defaults (World.js time + Config.js)
    const val DEFAULT_HOUR = 14.0
    const val DEFAULT_MONTH = 5 // 0-indexed June
    const val DEFAULT_DAY = 1
    const val LATITUDE = 47.3

    fun clamp01(v: Double): Double = if (v < 0.0) 0.0 else if (v > 1.0) 1.0 else v
    fun lerp(a: Double, b: Double, t: Double): Double = a + (b - a) * t
    fun smoothstep(a: Double, b: Double, v: Double): Double {
        val t = clamp01((v - a) / (b - a))
        return t * t * (3 - 2 * t)
    }

    fun luminance(c: DoubleArray): Double = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

    // ---------------------------------------------------------------- ephemeris

    /** Day of year (1..365) from the web's raw time.month (0-indexed June = 5) + day.
     *  Web: clamp((time.month||6)-1, 0, 11) → cumulative + clamp(day||1, 1, 31). */
    fun dayOfYear(month0: Int, day: Int): Int {
        val mm = max(0, min(11, month0 - 1))
        val cum = intArrayOf(0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
        return cum[mm] + max(1, min(31, day))
    }

    fun solarDeclination(doy: Int): Double =
        23.44 * PI / 180.0 * sin((2 * PI * (284 + doy)) / 365.0)

    /** Direction toward a body from altitude/azimuth (rad, azimuth from north clockwise, east = +X). */
    fun horizontalToDirection(altitude: Double, azimuth: Double, out: DoubleArray) {
        val ca = cos(altitude)
        out[0] = ca * sin(azimuth)
        out[1] = sin(altitude)
        out[2] = -ca * cos(azimuth)
    }

    /** Altitude & azimuth of a body with declination `dec` at hour angle `H` (rad), latitude `lat` (rad). */
    fun altAz(dec: Double, H: Double, lat: Double): DoubleArray {
        val sinAlt = sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H)
        val alt = asin(max(-1.0, min(1.0, sinAlt)))
        val cosAlt = max(1e-6, cos(alt))
        val cosAz = (sin(dec) - sin(alt) * sin(lat)) / (cosAlt * cos(lat))
        var az = acos(max(-1.0, min(1.0, cosAz)))
        if (sin(H) > 0) az = 2 * PI - az // afternoon -> west
        return doubleArrayOf(alt, az)
    }

    /** Sun and moon geometry (atmosphere.js celestial). out = { sunAltitude, sunAzimuth, sunDir[3],
     *  moonAltitude, moonAzimuth, moonDir[3], moonPhase, moonIllumination, siderealAngle }. */
    fun celestial(hour: Double, doy: Int, latDeg: Double, out: DoubleArray) {
        // out layout: 0 sunAlt, 1 sunAz, 2-4 sunDir, 5 moonAlt, 6 moonAz, 7-9 moonDir,
        //             10 moonPhase, 11 moonIllum, 12 sidereal
        val lat = latDeg * PI / 180.0
        val decS = solarDeclination(doy)
        val H = (hour - 12) * 15 * PI / 180.0
        val sun = altAz(decS, H, lat)
        out[0] = sun[0]; out[1] = sun[1]
        val dir = DoubleArray(3)
        horizontalToDirection(sun[0], sun[1], dir)
        System.arraycopy(dir, 0, out, 2, 3)

        val ageDays = ((doy + hour / 24) * 1.0 + 12.6) % 29.53
        val elong = (ageDays / 29.53) * 2 * PI
        out[10] = ageDays / 29.53
        out[11] = 0.5 * (1 - cos(elong))
        val decM = 23.44 * PI / 180.0 * sin((2 * PI * (284 + doy)) / 365.0 + elong) * 1.1
        val moon = altAz(decM, H - elong, lat)
        out[5] = moon[0]; out[6] = moon[1]
        horizontalToDirection(moon[0], moon[1], dir)
        System.arraycopy(dir, 0, out, 7, 3)

        out[12] = ((hour / 24) * 2 * PI + (doy / 365.25) * 2 * PI + 1.7) % (2 * PI)
    }

    /** Tone-mapping exposure as a function of sun altitude (deg) — eye adaptation curve. */
    fun exposureForSun(sunAltDeg: Double): Double {
        val keys = arrayOf(
            doubleArrayOf(-90.0, 3.15), doubleArrayOf(-14.0, 3.15), doubleArrayOf(-10.0, 3.1), doubleArrayOf(-8.0, 3.0),
            doubleArrayOf(-6.0, 2.82), doubleArrayOf(-5.0, 2.66), doubleArrayOf(-4.0, 2.48), doubleArrayOf(-3.0, 2.25),
            doubleArrayOf(-2.0, 2.02), doubleArrayOf(-1.0, 1.85), doubleArrayOf(0.0, 2.14), doubleArrayOf(2.0, 2.09),
            doubleArrayOf(4.0, 2.03), doubleArrayOf(6.0, 1.93), doubleArrayOf(10.0, 1.75), doubleArrayOf(18.0, 1.52),
            doubleArrayOf(30.0, 1.37), doubleArrayOf(90.0, 1.37))
        for (i in 1 until keys.size) {
            if (sunAltDeg <= keys[i][0]) {
                val t = smoothstep(keys[i - 1][0], keys[i][0], sunAltDeg)
                return lerp(keys[i - 1][1], keys[i][1], t)
            }
        }
        return keys[keys.size - 1][1]
    }

    /** 0 by day, 1 at night (atmosphere.js nightFactorForSun). */
    fun nightFactorForSun(sunAltDeg: Double): Double = clamp01(1 - smoothstep(-1.0, 3.0, sunAltDeg))

    // ---------------------------------------------------------------- optical core

    private fun raySphere(ro: DoubleArray, rd: DoubleArray, R: Double): DoubleArray {
        val b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2]
        val c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - R * R
        var h = b * b - c
        if (h < 0) return doubleArrayOf(-1.0, -1.0)
        h = sqrt(h)
        return doubleArrayOf(-b - h, -b + h)
    }

    private fun densities(h: Double, out: DoubleArray) {
        out[0] = exp(-h / H_R)
        out[1] = exp(-h / H_M)
        out[2] = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0)
    }

    /** Optical depth [R, M, O] from p toward the light + soft planet occlusion. Returns occl; od filled. */
    private fun opticalDepthToLight(p: DoubleArray, L: DoubleArray, steps: Int, od: DoubleArray): Double {
        val tFar = raySphere(p, L, ATMO_R)[1]
        val b = -(p[0] * L[0] + p[1] * L[1] + p[2] * L[2])
        var occl = 1.0
        if (b > 0) {
            val hx = p[0] + L[0] * b
            val hy = p[1] + L[1] * b
            val hz = p[2] + L[2] * b
            val hmin = sqrt(hx * hx + hy * hy + hz * hz) - PLANET_R
            occl = smoothstep(-6000.0, 800.0, hmin)
        }
        od[0] = 0.0; od[1] = 0.0; od[2] = 0.0
        if (occl <= 0) return 0.0
        val ds = tFar / steps
        for (i in 0 until steps) {
            val t = (i + 0.5) * ds
            val px = p[0] + L[0] * t
            val py = p[1] + L[1] * t
            val pz = p[2] + L[2] * t
            val h = max(0.0, sqrt(px * px + py * py + pz * pz) - PLANET_R)
            densities(h, TMP_DENS)
            od[0] += TMP_DENS[0] * ds
            od[1] += TMP_DENS[1] * ds
            od[2] += TMP_DENS[2] * ds
        }
        return occl
    }

    private val TMP_DENS = DoubleArray(3)
    private val OD_L = DoubleArray(3)

    private fun hg(mu: Double, g: Double): Double {
        val g2 = g * g
        return (1 - g2) / (4 * PI * (1 + g2 - 2 * g * mu).pow(1.5))
    }

    /** Sky radiance toward `rd` (unit) from altitude `alt` m (atmosphere.js skyRadiance, N=12/LSTEPS=5 or 10/4).
     *  radiance[3], transmittance[3] filled; returns hitsGround. */
    fun skyRadiance(
        rd: DoubleArray, alt: Double, sunDir: DoubleArray, moonDir: DoubleArray,
        sunE: Double, moonE: Double, turbidity: Double, scatterBoost: Double,
        N: Int, LSTEPS: Int, radiance: DoubleArray, transmittance: DoubleArray,
    ): Boolean {
        val ro = doubleArrayOf(0.0, PLANET_R + max(1.0, alt), 0.0)
        val tAtm = raySphere(ro, rd, ATMO_R)[1]
        var tmax = tAtm
        val tp0 = raySphere(ro, rd, PLANET_R)[0]
        val hitsGround = tp0 > 0
        if (hitsGround) tmax = tp0
        val turb = turbidity
        val bM = BETA_M * turb
        val bME = (BETA_M + BETA_MA) * turb
        val muS = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2]
        val phaseRS = (3.0 / (16 * PI)) * (1 + muS * muS)
        val phaseMS = hg(muS, MIE_G)
        val hasMoon = moonE > 1e-5
        val muM = if (hasMoon) rd[0] * moonDir[0] + rd[1] * moonDir[1] + rd[2] * moonDir[2] else 0.0
        val phaseRM = (3.0 / (16 * PI)) * (1 + muM * muM)
        val phaseMM = hg(muM, MIE_G)
        val sumRS = DoubleArray(3); val sumMS = DoubleArray(3); val sumRM = DoubleArray(3)
        val sumMM = DoubleArray(3); val sumMSR = DoubleArray(3)
        val od = DoubleArray(3)
        val dens = DoubleArray(3)
        for (i in 0 until N) {
            val s0 = i.toDouble() / N; val s1 = (i + 1).toDouble() / N
            val t0 = tmax * s0 * s0; val t1 = tmax * s1 * s1
            val ds = t1 - t0
            val t = 0.5 * (t0 + t1)
            val px = ro[0] + rd[0] * t
            val py = ro[1] + rd[1] * t
            val pz = ro[2] + rd[2] * t
            val h = max(0.0, sqrt(px * px + py * py + pz * pz) - PLANET_R)
            densities(h, dens)
            od[0] += dens[0] * ds; od[1] += dens[1] * ds; od[2] += dens[2] * ds
            var occl = opticalDepthToLight(doubleArrayOf(px, py, pz), sunDir, LSTEPS, OD_L)
            if (occl > 0) {
                for (c in 0 until 3) {
                    val tauCam = BETA_R[c] * od[0] + bME * od[1] + BETA_O[c] * od[2]
                    val tauSun = BETA_R[c] * OD_L[0] + bME * OD_L[1] + BETA_O[c] * OD_L[2]
                    val att = exp(-(tauCam + tauSun)) * occl
                    sumRS[c] += att * dens[0] * ds
                    sumMS[c] += att * dens[1] * ds
                    sumMSR[c] += exp(-tauCam - (BETA_R[c] * OD_L[0] + bME * OD_L[1]) * MS_SUN_ATTEN) * occl * dens[0] * ds
                }
            }
            if (hasMoon) {
                occl = opticalDepthToLight(doubleArrayOf(px, py, pz), moonDir, LSTEPS, OD_L)
                if (occl > 0) {
                    for (c in 0 until 3) {
                        val tau = BETA_R[c] * (od[0] + OD_L[0]) + bME * (od[1] + OD_L[1]) + BETA_O[c] * (od[2] + OD_L[2])
                        val att = exp(-tau) * occl
                        sumRM[c] += att * dens[0] * ds
                        sumMM[c] += att * dens[1] * ds
                    }
                }
            }
        }
        for (c in 0 until 3) {
            transmittance[c] = exp(-(BETA_R[c] * od[0] + bME * od[1] + BETA_O[c] * od[2]))
            var rr = sunE * (sumRS[c] * BETA_R[c] * phaseRS * scatterBoost +
                sumMS[c] * bM * phaseMS * MIE_BOOST +
                sumMSR[c] * BETA_R[c] * MS_SPECTRUM[c] * MS_K)
            if (hasMoon) {
                rr += moonE * (sumRM[c] * BETA_R[c] * phaseRM * scatterBoost +
                    sumMM[c] * bM * phaseMM * MIE_BOOST)
            }
            radiance[c] = rr
        }
        return hitsGround
    }

    /** Transmittance from altitude toward the light (atmosphere.js transmittanceToLight). */
    fun transmittanceToLight(L: DoubleArray, alt: Double, turbidity: Double, out: DoubleArray) {
        val p = doubleArrayOf(0.0, PLANET_R + max(1.0, alt), 0.0)
        val occl = opticalDepthToLight(p, L, 24, OD_L)
        val bME = (BETA_M + BETA_MA) * turbidity
        for (c in 0 until 3) {
            out[c] = occl * exp(-(BETA_R[c] * OD_L[0] + bME * OD_L[1] + BETA_O[c] * OD_L[2]))
        }
    }

    // ---------------------------------------------------------------- lighting key (computeFrame, clear)

    class EnvState {
        val sunDir = DoubleArray(3)      // toward the sun
        val moonDir = DoubleArray(3)     // toward the moon
        val lightDir = DoubleArray(3)    // toward the shadow-casting light (sun or moon)
        var sunAltDeg = 0.0
        var moonAltDeg = 0.0
        var moonIllum = 0.0
        var sunIntensity = 0.0
        val sunColor = DoubleArray(3)
        var moonIntensity = 0.0
        val moonColor = DoubleArray(3)
        var exposure = 1.0
        var nightFactor = 0.0
        var nightAmount = 0.0
        val skyAvg = DoubleArray(3)
        val horizonAvg = DoubleArray(3)
        val sunSideAvg = DoubleArray(3)
        var hemiIntensity = 0.0
        var hemiRaw = 0.0
        var floorMix = 0.0
        val hemiCol = DoubleArray(3)
        val hemiGround = DoubleArray(3)
        val groundRad = DoubleArray(3)
        val fogColor = DoubleArray(3)
        var fogDensity = 0.0
        var fogH = 620.0            // weather.state.fogH — height-fog scale (uFcFogParams / fogHeight)
        var fogFloor = 0.38         // weather.state.fogFloor — uniform-haze floor
        var fogSunGlow = 0.0        // forward-scatter glow of the sun through the fog medium
        var fogMax = 0.80           // fog opacity ceiling
        val fogWarm = DoubleArray(3) // directional aerial perspective, sun side
        val fogCool = DoubleArray(3) // directional aerial perspective, away side
        var wetness = 0.0           // weather.wetness * (1 - snowCover)
        var snowCover = 0.0
        var cloudCover = 0.30
        var sunFactor = 1.0
        var skyFog = 0.0
        var overcastNight = 0.0
        var dayFactor = 1.0 // 1 by day, 0 at night (1 - nightFactor) — drives window lights
        var siderealAngle = 0.0 // celestial[12] — star cube spin (SkyDome.setStarRotation)
    }

    private val CEL = DoubleArray(13)
    private val SUN_T = DoubleArray(3)
    private val SUN_T_HIGH = DoubleArray(3)
    private val MOON_T = DoubleArray(3)
    private val RAD = DoubleArray(3)
    private val TR = DoubleArray(3)

    private fun skySample(dir: DoubleArray, camAlt: Double, sunDir: DoubleArray, moonDir: DoubleArray, moonSkyE: Double, scatter: Double, turb: Double) {
        skyRadiance(dir, camAlt, sunDir, moonDir, SUN_E, moonSkyE, turb, scatter, 10, 4, RAD, TR)
    }

    private fun clampLum(c: DoubleArray, maxLum: Double) {
        val l = luminance(c)
        if (l > maxLum) { val k = maxLum / l; c[0] *= k; c[1] *= k; c[2] *= k }
    }

    /** Transcription of sampleSkyAverages (general weather). fwdXZ = camera forward (horizontal). */
    private fun sampleSkyAverages(camAlt: Double, moonSkyE: Double, nightAmount: Double, scatter: Double, turb: Double, fwdX: Double, fwdZ: Double, st: EnvState) {
        val dir = DoubleArray(3)
        val sky = st.skyAvg; val hor = st.horizonAvg; val sunSide = st.sunSideAvg
        sky[0] = 0.0; sky[1] = 0.0; sky[2] = 0.0
        hor[0] = 0.0; hor[1] = 0.0; hor[2] = 0.0
        sunSide[0] = 0.0; sunSide[1] = 0.0; sunSide[2] = 0.0
        var wSky = 0.0; var wHor = 0.0
        val sunAltDeg = st.sunAltDeg
        val lowSun = 1 - smoothstep(3.0, 20.0, sunAltDeg)
        val ringElev = doubleArrayOf(0.5 * PI, 50.0 * PI / 180.0, 14.0 * PI / 180.0)
        val ringN = intArrayOf(1, 6, 8)
        val ringW = doubleArrayOf(lerp(0.45, 0.6, lowSun), lerp(0.40, 0.32, lowSun), lerp(0.15, 0.08, lowSun))
        var sunHx = st.sunDir[0]; var sunHz = st.sunDir[2]
        val hl = hypot(sunHx, sunHz)
        if (hl > 0) { sunHx /= hl; sunHz /= hl }
        for (r in 0 until 3) {
            val n = ringN[r]
            for (i in 0 until n) {
                val az = (i.toDouble() / n) * PI * 2 + 0.3
                val ce = cos(ringElev[r])
                dir[0] = ce * sin(az); dir[1] = sin(ringElev[r]); dir[2] = -ce * cos(az)
                skySample(dir, camAlt, st.sunDir, st.moonDir, moonSkyE, scatter, turb)
                val dot = dir[0] * sunHx + dir[2] * sunHz
                val w = (ringW[r] / n) * (1 - 0.6 * lowSun * max(0.0, dot))
                clampLum(RAD, 0.4)
                sky[0] += RAD[0] * w; sky[1] += RAD[1] * w; sky[2] += RAD[2] * w
                wSky += w
            }
        }
        val kSky = 1.0 / wSky
        sky[0] *= kSky; sky[1] *= kSky; sky[2] *= kSky
        val nHor = 10
        for (i in 0 until nHor) {
            val az = (i.toDouble() / nHor) * PI * 2 + 0.15
            val elev = 1.6 * PI / 180.0
            val ce = cos(elev)
            dir[0] = ce * sin(az); dir[1] = sin(elev); dir[2] = -ce * cos(az)
            skySample(dir, camAlt, st.sunDir, st.moonDir, moonSkyE, scatter, turb)
            clampLum(RAD, 0.7)
            val w = 0.55 + 0.45 * max(0.0, dir[0] * fwdX + dir[2] * fwdZ)
            hor[0] += RAD[0] * w; hor[1] += RAD[1] * w; hor[2] += RAD[2] * w
            wHor += w
        }
        val kHor = 1.0 / wHor
        hor[0] *= kHor; hor[1] *= kHor; hor[2] *= kHor
        if (hypot(st.sunDir[0], st.sunDir[2]) > 1e-3) {
            val azS = kotlin.math.atan2(sunHx, -sunHz)
            val elev = 5.0 * PI / 180.0
            val ce = cos(elev)
            for (dAz in doubleArrayOf(-30.0 * PI / 180.0, 0.0, 30.0 * PI / 180.0)) {
                val az = azS + dAz
                dir[0] = ce * sin(az); dir[1] = sin(elev); dir[2] = -ce * cos(az)
                skySample(dir, camAlt, st.sunDir, st.moonDir, moonSkyE, scatter, turb)
                clampLum(RAD, 1.4)
                sunSide[0] += RAD[0] / 3; sunSide[1] += RAD[1] / 3; sunSide[2] += RAD[2] / 3
            }
        }
        // night floor consistent with the web sky shader's airglow term
        for (c in 0 until 3) {
            sky[c] += NIGHT_GLOW[c] * nightAmount * 1.4
            hor[c] += NIGHT_GLOW[c] * nightAmount * 2.4
        }
    }

    /** Full-weather transcription of environment/index.js computeFrame. `fwdXZ` is the camera
     *  forward (horizontal components as used by the web horizon weighting). Pass `w` = null for
     *  the clear preset (bit-identical to the original clear-only port; pinned by the existing
     *  EnvironmentParityTest goldens), or a live WeatherState (pinned by EnvWeatherGoldens). */
    fun compute(hour: Double, doy: Int, latDeg: Double, camAlt: Double, fwdX: Double, fwdZ: Double, st: EnvState, w: WeatherState? = null) {
        // weather inputs (clear preset values when w == null — identical literals, bit-exact path)
        val wCover = if (w != null) clamp01(w.keys[WeatherPresets.I_COVER]) else CLEAR_COVER
        val wTurb = if (w != null) w.keys[WeatherPresets.I_TURBIDITY] else CLEAR_TURBIDITY
        val wSunF = if (w != null) w.keys[WeatherPresets.I_SUN] else CLEAR_SUN_FACTOR
        val wFog = if (w != null) w.keys[WeatherPresets.I_FOG] else CLEAR_FOG
        val wDiffuse = if (w != null) w.keys[WeatherPresets.I_DIFFUSE] else CLEAR_DIFFUSE
        val wMilk = if (w != null) w.keys[WeatherPresets.I_MILK] else 0.0
        val wSkyFog = if (w != null) w.keys[WeatherPresets.I_SKYFOG] else 0.0
        val wFogH = if (w != null) w.keys[WeatherPresets.I_FOGH] else 620.0
        val wFogFloor = if (w != null) w.keys[WeatherPresets.I_FOGFLOOR] else 0.38
        val wPrecip = if (w != null) w.precipitation else 0.0
        val wWetness = if (w != null) w.wetness else 0.0
        val wSnow = if (w != null) w.snowCover else 0.0

        celestial(hour, doy, latDeg, CEL)
        st.sunAltDeg = CEL[0] * 180.0 / PI
        st.moonAltDeg = CEL[5] * 180.0 / PI
        st.siderealAngle = CEL[12]
        st.moonIllum = CEL[11]
        System.arraycopy(CEL, 2, st.sunDir, 0, 3)
        System.arraycopy(CEL, 7, st.moonDir, 0, 3)

        val lowSun = 1 - smoothstep(4.0, 20.0, st.sunAltDeg)
        val scatter = lerp(1.95, SCATTER_BOOST, smoothstep(2.0, 22.0, st.sunAltDeg))
        val nightAmount = clamp01(1 - smoothstep(-13.0, -1.0, st.sunAltDeg))
        st.nightAmount = nightAmount

        transmittanceToLight(st.sunDir, camAlt, wTurb, SUN_T)
        transmittanceToLight(st.sunDir, 2600.0, wTurb, SUN_T_HIGH)
        transmittanceToLight(st.moonDir, camAlt, wTurb, MOON_T)
        val sunUp = smoothstep(-1.8, 1.2, st.sunAltDeg)
        val sunMax = max(SUN_T[0], max(SUN_T[1], max(SUN_T[2], 1e-4)))
        st.sunIntensity = SUN_E * sunMax.pow(lerp(1.0, 0.6, lowSun)) * sunUp * wSunF
        val sc = st.sunColor
        sc[0] = SUN_T[0] / sunMax; sc[1] = SUN_T[1] / sunMax; sc[2] = SUN_T[2] / sunMax
        run {
            val l = luminance(sc)
            val k = lerp(0.28, 0.2, lowSun)
            sc[0] += (l - sc[0]) * k; sc[1] += (l - sc[1]) * k; sc[2] += (l - sc[2]) * k
            val m = max(sc[0], max(sc[1], max(sc[2], 1e-4)))
            sc[0] /= m; sc[1] /= m; sc[2] /= m
            sc[0] = max(sc[0], 1.0); sc[1] = max(sc[1], 0.5); sc[2] = max(sc[2], 0.2)
        }
        run {
            val k = 0.55 * (1 - smoothstep(8.0, 46.0, st.sunAltDeg))
            sc[0] += (KEY_WARM[0] - sc[0]) * k; sc[1] += (KEY_WARM[1] - sc[1]) * k; sc[2] += (KEY_WARM[2] - sc[2]) * k
        }
        if (lowSun > 0) {
            val k = 0.55 * lowSun * sunUp
            sc[0] += (1.0 - sc[0]) * k; sc[1] += (0.55 - sc[1]) * k; sc[2] += (0.25 - sc[2]) * k
        }
        val moonUp = smoothstep(-1.0, 6.0, st.moonAltDeg)
        val moonMax = max(MOON_T[0], max(MOON_T[1], max(MOON_T[2], 1e-4)))
        st.moonIntensity = MOON_LIGHT * st.moonIllum * moonMax * moonUp * lerp(1.0, wSunF, 0.85)
        val mc = st.moonColor
        mc[0] = MOON_T[0] / moonMax; mc[1] = MOON_T[1] / moonMax; mc[2] = MOON_T[2] / moonMax
        mc[0] += (1 - mc[0]) * 0.6; mc[1] += (1 - mc[1]) * 0.6; mc[2] += (1 - mc[2]) * 0.6
        mc[0] *= MOON_COLOR[0]; mc[1] *= MOON_COLOR[1]; mc[2] *= MOON_COLOR[2]
        val moonSkyE = MOON_SKY_E * st.moonIllum * moonUp

        val baseNight = nightFactorForSun(st.sunAltDeg)
        // real cities light up under a thick deck: overcast can push nightFactor above the
        // clear-sky base so window lights and street lamps come on during a storm
        val overcastNight = (1 - smoothstep(-2.0, 10.0, st.sunAltDeg)) * clamp01((wCover - 0.55) * 2.2) * 0.7
        st.overcastNight = overcastNight
        st.nightFactor = clamp01(max(baseNight, overcastNight))
        st.dayFactor = 1.0 - st.nightFactor

        var exposure = exposureForSun(st.sunAltDeg)
        exposure *= 1 + 0.10 * smoothstep(0.45, 0.95, wCover) * (1 - st.nightFactor) + 0.06 * wPrecip
        exposure *= lerp(1.0, 0.93, smoothstep(16.0, 42.0, st.sunAltDeg))
        val moonIrr = st.moonIntensity * max(0.0, st.moonDir[1])
        exposure *= 1 - 0.5 * clamp01(moonIrr / 0.12) * nightAmount
        st.exposure = exposure

        sampleSkyAverages(camAlt, moonSkyE, nightAmount, scatter, wTurb, fwdX, fwdZ, st)

        // choose the shadow-casting light
        val lightToward = DoubleArray(3)
        if (st.sunIntensity >= st.moonIntensity) {
            lightToward[0] = st.sunDir[0]; lightToward[1] = st.sunDir[1]; lightToward[2] = st.sunDir[2]
        } else {
            lightToward[0] = st.moonDir[0]; lightToward[1] = st.moonDir[1]; lightToward[2] = st.moonDir[2]
        }
        st.lightDir[0] = -lightToward[0]; st.lightDir[1] = -lightToward[1]; st.lightDir[2] = -lightToward[2]
        if (st.lightDir[1] > -sin(MIN_SHADOW_ELEV)) {
            val h = hypot(st.lightDir[0], st.lightDir[2])
            val hc = if (h == 0.0) 1.0 else h
            val c = cos(MIN_SHADOW_ELEV)
            st.lightDir[0] = (st.lightDir[0] / hc) * c
            st.lightDir[1] = -sin(MIN_SHADOW_ELEV)
            st.lightDir[2] = (st.lightDir[2] / hc) * c
        }
        run {
            val l = sqrt(st.lightDir[0] * st.lightDir[0] + st.lightDir[1] * st.lightDir[1] + st.lightDir[2] * st.lightDir[2])
            st.lightDir[0] /= l; st.lightDir[1] /= l; st.lightDir[2] /= l
        }

        // hemisphere sky: overcast lerp + blocked-sunlight diffuse skylight + moon ambient
        val skyAvg = st.skyAvg
        val skyLum = luminance(skyAvg)
        val overLum = skyLum * 1.15
        val sunIrrClear = SUN_E * sunMax * sunUp * max(0.0, st.sunDir[1])
        val diffuseE = sunIrrClear * (1.0 - wSunF) * wDiffuse / PI
        val diffuseCol = DoubleArray(3)
        for (c in 0 until 3) diffuseCol[c] = sc[c] * diffuseE
        run {
            val l = luminance(diffuseCol)
            for (c in 0 until 3) diffuseCol[c] += (l - diffuseCol[c]) * 0.6
        }
        val hs = DoubleArray(3)
        for (c in 0 until 3) hs[c] = lerp(skyAvg[c], overLum, wCover * 0.85) + diffuseCol[c]
        hs[0] += mc[0] * st.moonIntensity * 0.033
        hs[1] += mc[1] * st.moonIntensity * 0.033
        hs[2] += mc[2] * st.moonIntensity * 0.033
        val snow = wSnow
        val albedo = DoubleArray(3)
        for (c in 0 until 3) albedo[c] = lerp(GROUND_ALBEDO[c], SNOW_ALBEDO[c], snow)
        val sunIrr = st.sunIntensity * max(0.0, st.sunDir[1]) + st.moonIntensity * max(0.0, st.moonDir[1]) * 0.5
        val gr = st.groundRad
        for (c in 0 until 3) gr[c] = albedo[c] * (sc[c] * sunIrr / PI + hs[c] * 0.9)
        for (c in 0 until 3) hs[c] = max(hs[c], NIGHT_FLOOR[c] * nightAmount)
        val hemiMax = max(hs[0], max(hs[1], max(hs[2], 1e-5)))
        val lowSunLift = 1 + 0.45 * lowSun * sunUp
        st.hemiRaw = hemiMax * AMBIENT_K * lowSunLift
        var hemiIntensity = max(0.010, min(0.95, st.hemiRaw))
        val floorKey = NIGHT_KEY * (1 + 1.05 * smoothstep(-13.0, -1.0, st.sunAltDeg) * (1 - smoothstep(0.5, 4.5, st.sunAltDeg)))
        val floorIntensity = floorKey * lerp(1.0, 0.88, nightAmount) / exposure
        var floorMix = 0.0
        if (hemiIntensity < floorIntensity) {
            floorMix = 1 - hemiIntensity / floorIntensity
            hemiIntensity = floorIntensity
        }
        st.hemiIntensity = hemiIntensity
        st.floorMix = floorMix
        val hcol = st.hemiCol
        for (c in 0 until 3) hcol[c] = hs[c] / hemiMax
        run {
            val k = floorMix * (1 - nightAmount * 0.5)
            for (c in 0 until 3) hcol[c] += (TWILIGHT_SKY[c] - hcol[c]) * k
        }
        val goldenCool = lowSun * sunUp * (1 - 0.6 * wCover)
        run {
            val k = 0.45 * goldenCool
            for (c in 0 until 3) hcol[c] += (GOLDEN_SKY[c] - hcol[c]) * k
        }
        val hgr = st.hemiGround
        run {
            val gMax = max(gr[0], max(gr[1], max(gr[2], 1e-5)))
            for (c in 0 until 3) hgr[c] = gr[c] / gMax
            val l = luminance(hgr)
            val d = max(goldenCool, nightAmount)
            val k1 = lerp(0.5, 0.82, d)
            for (c in 0 until 3) hgr[c] += (l - hgr[c]) * k1
            val k2 = 0.42 * d
            for (c in 0 until 3) hgr[c] += (COOL_BOUNCE[c] - hgr[c]) * k2
            val s = lerp(0.34, 0.30, d)
            for (c in 0 until 3) hgr[c] *= s
        }

        // fog: clear air tinted from the sky; the fog/overcast medium is the luminous diffuser
        val lowSunFog = 1 - smoothstep(3.0, 20.0, st.sunAltDeg)
        val fogColor = st.fogColor
        val fm = lerp(0.45, 0.6, lowSunFog)
        for (c in 0 until 3) fogColor[c] = lerp(st.horizonAvg[c], skyAvg[c], fm)
        run {
            val l = luminance(fogColor)
            val k = wCover * 0.45
            for (c in 0 until 3) fogColor[c] += (l - fogColor[c]) * k
        }
        // milky medium: hemisphere sky + diffused sunlight, whitened, never darker than the fog
        val milkC = DoubleArray(3)
        for (c in 0 until 3) milkC[c] = skyAvg[c] * 1.05 + diffuseCol[c]
        run {
            val l = luminance(milkC)
            for (c in 0 until 3) milkC[c] += (l - milkC[c]) * 0.35
            milkC[0] = max(milkC[0], fogColor[0])
            milkC[1] = max(milkC[1], fogColor[1])
            milkC[2] = max(milkC[2], fogColor[2])
            val k = wMilk
            for (c in 0 until 3) fogColor[c] += (milkC[c] - fogColor[c]) * k
        }
        // twilight floor keeps the horizon from going grey-black before the sky
        fogColor[0] = max(fogColor[0], 0.010 * floorMix / exposure)
        fogColor[1] = max(fogColor[1], 0.015 * floorMix / exposure)
        fogColor[2] = max(fogColor[2], 0.034 * floorMix / exposure)
        st.fogDensity = wFog * (1 + 0.25 * st.nightFactor)
        // height fog hugs the water level, settles lower at night
        st.fogH = wFogH * (1 - 0.2 * st.nightFactor)
        st.fogFloor = wFogFloor
        st.fogSunGlow = wMilk * sunUp * 1.6 * smoothstep(0.02, 0.4, wSunF + 0.2)
        st.fogMax = lerp(0.80, 1.0, clamp01(wMilk * 1.1))
        // directional aerial perspective: warm haze sun-side, cool blue away (peaks at golden hour)
        run {
            val amp = lowSun * sunUp * (1 - 0.55 * wMilk)
            st.fogWarm[0] = lerp(1.0, 1.22, amp); st.fogWarm[1] = lerp(1.0, 1.02, amp); st.fogWarm[2] = lerp(1.0, 0.80, amp)
            st.fogCool[0] = lerp(1.0, 0.84, amp); st.fogCool[1] = lerp(1.0, 0.93, amp); st.fogCool[2] = lerp(1.0, 1.16, amp)
        }
        // wetness (rain) for lit materials; snow hides the wet look
        st.wetness = wWetness * (1.0 - wSnow)
        st.snowCover = wSnow
        st.cloudCover = wCover
        st.sunFactor = wSunF
        st.skyFog = wSkyFog
    }
}
