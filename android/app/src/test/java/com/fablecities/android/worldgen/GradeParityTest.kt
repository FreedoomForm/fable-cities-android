package com.fablecities.android.worldgen

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Pins the effects/index.js post-chain driver port (GradeFx) against tools/probe_grade.mjs,
 * which runs the REAL web Weather.js + atmosphere primitives and transcribes the real
 * effects-module grade block. Bit-exact on the damp chains and uniforms.
 */
class GradeParityTest {

    // the probe's vpProject replica (50 deg fov, 16:9, look-at target (-284, 8, -180))
    val camPos = GradeGoldens.CAM_POS
    val target = doubleArrayOf(-284.0, 8.0, -180.0)
    val fov = 50.0 * Math.PI / 180.0
    val aspect = 16.0 / 9.0

    fun project(p: DoubleArray): DoubleArray {
        val tx = target[0] - camPos[0]; val ty = target[1] - camPos[1]; val tz = target[2] - camPos[2]
        val tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
        val fz = doubleArrayOf(tx / tl, ty / tl, tz / tl)
        val up0 = doubleArrayOf(0.0, 1.0, 0.0)
        var rx = doubleArrayOf(fz[1] * up0[2] - fz[2] * up0[1], fz[2] * up0[0] - fz[0] * up0[2], fz[0] * up0[1] - fz[1] * up0[0])
        val rl = Math.sqrt(rx[0] * rx[0] + rx[1] * rx[1] + rx[2] * rx[2])
        rx = doubleArrayOf(rx[0] / rl, rx[1] / rl, rx[2] / rl)
        val ux = doubleArrayOf(rx[1] * fz[2] - rx[2] * fz[1], rx[2] * fz[0] - rx[0] * fz[2], rx[0] * fz[1] - rx[1] * fz[0])
        val dx = p[0] - camPos[0]; val dy = p[1] - camPos[1]; val dz = p[2] - camPos[2]
        val vx = dx * rx[0] + dy * rx[1] + dz * rx[2]
        val vy = dx * ux[0] + dy * ux[1] + dz * ux[2]
        val vz = -(dx * fz[0] + dy * fz[1] + dz * fz[2])
        val f = 1.0 / Math.tan(fov / 2.0)
        val cw = -vz
        if (abs(cw) < 1e-9) return doubleArrayOf(0.0, 0.0, 2.0)
        return doubleArrayOf((f / aspect) * vx / cw, f * vy / cw, if (vz < 0) 0.0 else 1.0)
    }

    fun arrEq(a: DoubleArray, b: DoubleArray, tol: Double, what: String) {
        assertTrue("${what}: len ${a.size} vs ${b.size}", a.size == b.size)
        for (i in a.indices) {
            val d = abs(a[i] - b[i])
            val scale = maxOf(1.0, abs(b[i]))
            assertTrue("${what}[$i]: got ${a[i]} want ${b[i]} (d=$d)", d <= tol * scale)
        }
    }

    @Test
    fun gradeDriverMatchesWeb() {
        assertTrue(GradeGoldens.rows.isNotEmpty())
        for ((key, r) in GradeGoldens.rows) {
            val S = GradeFx.State()
            val env = GradeFx.EnvIn(
                r.preset, r.sunIntensity, r.sunColor, r.nightFactor, r.sunDir,
                r.precipitation, r.wetness, r.snow, r.cloudCover,
            )
            repeat(240) { GradeFx.step(S, GradeGoldens.DT, env, camPos, ::project) }
            assertTrue("$key rainAmt", abs(S.rainAmt - r.rainAmt) <= 1e-12 * maxOf(1.0, r.rainAmt))
            assertTrue("$key snowAmt", abs(S.snowAmt - r.snowAmt) <= 1e-12 * maxOf(1.0, r.snowAmt))
            assertTrue("$key fxWetness", abs(S.wetness - r.fxWetness) <= 1e-12 * maxOf(1.0, r.fxWetness))
            assertTrue("$key fxCover", abs(S.snowCover - r.fxCover) <= 1e-12 * maxOf(1.0, r.fxCover))
            arrEq(doubleArrayOf(S.uContrast, S.uToe, S.uShoulder, S.uBlack), doubleArrayOf(r.uContrast, r.uToe, r.uShoulder, r.uBlack), 1e-12, "$key curve")
            arrEq(doubleArrayOf(S.uSaturation, S.uMidSat, S.uHiDesat, S.uExposure), doubleArrayOf(r.uSaturation, r.uMidSat, r.uHiDesat, r.uExposure), 1e-12, "$key sat")
            arrEq(S.uTint, r.uTint, 1e-12, "$key tint")
            arrEq(S.uShadowTint, r.uShadowTint, 1e-12, "$key shadowTint")
            arrEq(S.uHighlightTint, r.uHighlightTint, 1e-12, "$key highlightTint")
            arrEq(S.uLift, r.uLift, 1e-12, "$key lift")
            arrEq(S.uGain, r.uGain, 1e-12, "$key gain")
            arrEq(S.uVignette, r.uVignette, 1e-12, "$key vignette")
            arrEq(S.uAuto, r.uAuto, 1e-12, "$key auto")
            arrEq(S.uSun, r.uSun, 1e-12, "$key sun")
            arrEq(S.uSunColor, r.uSunColor, 1e-12, "$key sunColor")
            assertTrue("$key adaptBlend", abs(S.adaptBlend - r.adaptBlend) <= 1e-12)
        }
    }
}
