package com.fablecities.android.worldgen

import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Bit-exact Kotlin port of the web game's src/modules/effects/WetLights.js — the analytic
 * emitter feed for the wet-road mirror (GroundFXPass): the nearest/ranked street lamps and
 * vehicle head- and tail-lights published as a 12-slot uniform array (vec4 xyzw = position +
 * intensity, plus radiance colour).
 *
 * The ranking logic is the web's, verbatim (p6-p13 fixes included):
 *  - lamps carry the warm colour (1.0, 0.80, 0.58) at intensity 3.2, harvested from the road
 *    network's lamp list (the native renderer's lamp instances) at most ~2x/s,
 *  - vehicle glares come from the traffic sim's lit lamps each frame: position = the lamp world
 *    position, radiance = the display-unit value the traffic renderer authors (head 1.32·hI,
 *    tail 1.0·tI) with the tone-mapping exposure division RECOVERED (rec = max(0.6, exposure)),
 *  - candidates rank by the angular deviation of the emitter seen from the camera MIRRORED
 *    about the road plane (plane-relative), times the p13 near-field locus prominence,
 *  - cosA < 0.2 stays outside any framing; the last 4 of the 12 slots are reserved for
 *    red-dominant (tail) emitters so queued traffic always paints the road behind it.
 */
class WetLights {

    class Emitter {
        var x = 0.0; var y = 0.0; var z = 0.0
        var r = 1.0; var g = 1.0; var b = 1.0
        var i = 0.0
        var d2 = 0.0
        var cosA = 0.0
        var redDom = false
        var prom = 0.0
    }

    /** Uniform-side storage: vec4(x, y, z, intensity) + radiance colour, MAX_LIGHTS entries. */
    val posX = DoubleArray(MAX_LIGHTS)
    val posY = DoubleArray(MAX_LIGHTS)
    val posZ = DoubleArray(MAX_LIGHTS)
    val posI = DoubleArray(MAX_LIGHTS)
    val colR = DoubleArray(MAX_LIGHTS)
    val colG = DoubleArray(MAX_LIGHTS)
    val colB = DoubleArray(MAX_LIGHTS)
    var count = 0
        private set

    /** static lamp heads (x, y, z) — the bulb positions from the native road lamp instances */
    private val lamps = ArrayList<DoubleArray>()
    private var lampTimer = -1.0

    private val candidates = ArrayList<Emitter>()

    /** Re-read the street-lamp instances (the set only changes when the road network changes). */
    fun setLamps(heads: List<DoubleArray>) {
        lamps.clear()
        for (l in heads) {
            if (l[1] < -5000.0) continue
            lamps.add(doubleArrayOf(l[0], l[1], l[2]))
        }
    }

    class VehicleGlares {
        val x = ArrayList<Double>()
        val y = ArrayList<Double>()
        val z = ArrayList<Double>()
        val r = ArrayList<Double>()
        val g = ArrayList<Double>()
        val b = ArrayList<Double>()

        fun clear() { x.clear(); y.clear(); z.clear(); r.clear(); g.clear(); b.clear() }
        fun add(px: Double, py: Double, pz: Double, pr: Double, pg: Double, pb: Double) {
            x.add(px); y.add(py); z.add(pz); r.add(pr); g.add(pg); b.add(pb)
        }
    }

    val glares = VehicleGlares()

    /**
     * Refresh the uniform array. `glareExposure` is the tone-mapping exposure the traffic
     * renderer divided its glare radiance by when it wrote the instance colours; `planeY` is the
     * road plane height under the camera (terrain under the camera; roads conform).
     * @return how many emitters were published
     */
    fun update(
        dt: Double,
        camX: Double, camY: Double, camZ: Double,
        fwdX: Double, fwdY: Double, fwdZ: Double,
        glareExposure: Double,
        planeY: Double,
    ): Int {
        // lamps only change with the network; re-scan at most ~2x/s (harvest timing only)
        lampTimer -= dt
        if (lampTimer < 0.0) lampTimer = 0.5

        val rec = maxOf(0.6, if (glareExposure != 0.0) glareExposure else 1.0)
        val mcY = planeY - (camY - planeY) // mirrored camera (absolute y) — plane-relative height
        val cand = candidates
        cand.clear()

        val locusProm = { h: Double, d2v: Double ->
            val d = sqrt(max(d2v, 1.0))
            // locus = where the mirrored-ray family touches the plane, from the camera footprint
            val locusD = (max(camY - planeY, 0.05) / (max(camY - planeY, 0.05) + max(h - planeY, 0.15))) * d
            0.30 + 0.70 * exp(-locusD / 40.0)
        }

        for (l in lamps) {
            val dx = l[0] - camX; val dy = l[1] - camY; val dz = l[2] - camZ
            val d2v = dx * dx + dy * dy + dz * dz
            if (d2v > 62500.0) continue // 250 m: past that the smear is sub-pixel
            val rx = l[0] - camX; val ry = l[1] - mcY; val rz = l[2] - camZ
            val rl = sqrt(rx * rx + ry * ry + rz * rz).let { if (it == 0.0) 1.0 else it }
            val cosA = (rx * fwdX + ry * fwdY + rz * fwdZ) / rl
            val e = Emitter()
            e.x = l[0]; e.y = l[1]; e.z = l[2]
            e.r = 1.00; e.g = 0.80; e.b = 0.58
            e.i = 3.2
            e.d2 = d2v; e.cosA = cosA; e.prom = locusProm(l[1], d2v)
            cand.add(e)
        }
        // vehicle glares: radiance in display units (head 1.32·hI / tail 1.0·tI written by the
        // traffic side), exposure division already recovered by the writer — read as-is
        val n = min(glares.x.size, 900)
        for (i in 0 until n) {
            val px = glares.x[i]; val py = glares.y[i]; val pz = glares.z[i]
            val r = glares.r[i]; val g = glares.g[i]; val b = glares.b[i]
            val maxC = maxOf(r, g, b)
            if (maxC < 0.02) continue
            val dxv = px - camX; val dyv = py - camY; val dzv = pz - camZ
            val d2v = dxv * dxv + dyv * dyv + dzv * dzv
            if (d2v > 40000.0) continue // 200 m
            val rx = px - camX; val ry = py - mcY; val rz = pz - camZ
            val rl = sqrt(rx * rx + ry * ry + rz * rz).let { if (it == 0.0) 1.0 else it }
            val cosA = (rx * fwdX + ry * fwdY + rz * fwdZ) / rl
            val redDom = r > 2.5 * maxOf(g, 0.02)
            val e = Emitter()
            e.x = px; e.y = py; e.z = pz
            e.r = r / maxC; e.g = g / maxC; e.b = b / maxC
            e.i = maxC * (if (redDom) 2.6 else 1.5) * rec
            e.d2 = d2v; e.cosA = cosA; e.redDom = redDom; e.prom = locusProm(py, d2v)
            cand.add(e)
        }

        // in-frustum wins — rank by the mirrored-camera angular deviation x p13 near-field
        // prominence; cosA < 0.2 (~78° off-axis) stays outside any framing
        cand.sortWith(compareByDescending<Emitter> { it.cosA * it.prom }.thenBy { it.d2 })
        for (i in cand.size - 1 downTo 0) if (cand[i].cosA < 0.2) cand.removeAt(i)
        // the 12 slots: reserve the last 4 for red-dominant (tail) emitters — promote the best
        // ranked tails that did not make the cut; lamps and heads keep competing for 8
        var tailsIn = 0
        for (i in 0 until min(cand.size, MAX_LIGHTS)) if (cand[i].redDom) tailsIn++
        if (tailsIn < 4) {
            val promoted = ArrayList<Emitter>()
            var i = MAX_LIGHTS
            while (i < cand.size && promoted.size < 4 - tailsIn) {
                if (cand[i].redDom) promoted.add(cand[i])
                i++
            }
            for (p in promoted) {
                var ev = -1
                for (i in MAX_LIGHTS - 1 downTo 0) if (!cand[i].redDom) { ev = i; break }
                if (ev < 0) ev = MAX_LIGHTS - 1
                cand.add(ev, p)
                cand.removeAt(MAX_LIGHTS)
            }
        }
        count = min(cand.size, MAX_LIGHTS)
        for (i in 0 until count) {
            val s = cand[i]
            posX[i] = s.x; posY[i] = s.y; posZ[i] = s.z; posI[i] = s.i
            colR[i] = s.r; colG[i] = s.g; colB[i] = s.b
        }
        for (i in count until MAX_LIGHTS) posI[i] = 0.0
        return count
    }

    companion object {
        const val MAX_LIGHTS = 12
    }
}
