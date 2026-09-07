package com.fablecities.android

import com.fablecities.android.worldgen.WetLights
import com.fablecities.android.worldgen.WetLightsGoldens
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Bit-parity golden test against the REAL browser WetLights.js update(): the synthetic camera +
 * lamp mesh + traffic-lamp-glare mesh from tools/probe_wetlights.mjs (exposure 1.0, planeY 0).
 * Pins the mirrored-plane locus ranking, the cosA < 0.2 cull, the red-tail slot reservation and
 * the published 12-slot emitter array.
 */
class WetLightsParityTest {

    @Test
    fun ranking_bitParity() {
        val wl = WetLights()
        wl.setLamps(listOf(
            doubleArrayOf(-2.0, 9.0, -24.0),
            doubleArrayOf(30.0, 9.0, -40.0),
            doubleArrayOf(-30.0, 9.0, -44.0),
            doubleArrayOf(60.0, 9.0, -26.0),
            doubleArrayOf(0.0, 9.0, -2600.0), // beyond the 250 m range gate
        ))
        val gl = wl.glares
        gl.add(2.0, 0.66, -26.0, 1.00, 0.075, 0.030)      // tail (red dominant)
        gl.add(16.0, 0.66, -28.0, 0.60, 0.045, 0.018)     // tail (red dominant)
        gl.add(4.0, 0.62, -44.0, 1.32, 1.18, 0.94)        // headlamp
        gl.add(-4.0, 0.62, -46.0, 1.32, 1.18, 0.94)       // headlamp
        gl.add(10.0, 0.66, -30.0, 0.01, 0.01, 0.01)       // below the 0.02 floor
        // camera at (0, 22, 0) pitched 26.6° down; forward = (0, -0.447, -0.894)
        val n = wl.update(0.016, 0.0, 22.0, 0.0, 0.0, -0.447, -0.894, 1.0, 0.0)
        assertEquals("published", WetLightsGoldens.published.toLong(), n.toLong())
        assertEquals("stats lamps", WetLightsGoldens.statsLamps.toLong(), wl.statsLamps.toLong())
        assertEquals("stats vehicles", WetLightsGoldens.statsVehicles.toLong(), wl.statsVehicles.toLong())
        var tails = 0
        for (i in 0 until n) if (wl.colR[i] > 2.5 * maxOf(wl.colG[i], 0.02)) tails++
        assertEquals("tails in slots", WetLightsGoldens.tailsInSlots.toLong(), tails.toLong())
        for (i in 0 until WetLightsGoldens.published) {
            val g = WetLightsGoldens.slots[i]
            assertEquals("slot[$i].x", g[0], wl.posX[i], 1e-9)
            assertEquals("slot[$i].y", g[1], wl.posY[i], 1e-9)
            assertEquals("slot[$i].z", g[2], wl.posZ[i], 1e-9)
            assertEquals("slot[$i].i", g[3], wl.posI[i], 1e-9)
            assertEquals("slot[$i].r", g[4], wl.colR[i], 1e-9)
            assertEquals("slot[$i].g", g[5], wl.colG[i], 1e-9)
            assertEquals("slot[$i].b", g[6], wl.colB[i], 1e-9)
        }
        for (i in WetLightsGoldens.published until 12) {
            assertEquals("unused[$i] intensity", 0.0, wl.posI[i], 0.0)
        }
    }
}
