package com.fablecities.android

import com.fablecities.android.worldgen.Traffic
import com.fablecities.android.worldgen.TrafficGoldens
import com.fablecities.android.worldgen.simHashString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser traffic/TrafficSim.js:
 *  - makePoly (Float32 polyline, curvature speed limit + backward smoothing)
 *  - idmAccel (IDM free-flow + gap term)
 *  - the agent sim: seed chain (world 1337 fork hashString('traffic')), 40 spawns on a closed
 *    loop, 400 x 0.05 s IDM integration steps — vehicle types, positions, speeds, brakes.
 * Expected values were produced by running the actual web code in Node (tools/probe_traffic.mjs).
 * The native vehicles must drive the SAME loop with the SAME car-following physics as the site.
 */
class TrafficParityTest {

    private fun near(actual: Double, expected: Double, tol: Double, what: String) {
        assertTrue(
            "$what: expected $expected, got $actual (diff ${actual - expected})",
            kotlin.math.abs(actual - expected) <= tol
        )
    }

    private fun loopNet(): Traffic.LaneNetwork {
        val pts = ArrayList<DoubleArray>()
        for (i in 0 until 16) {
            val a = (i / 16.0) * kotlin.math.PI * 2.0
            pts.add(doubleArrayOf(kotlin.math.cos(a) * 300.0, 2.0 + kotlin.math.sin(a * 3.0) * 1.5, kotlin.math.sin(a) * 300.0))
        }
        return Traffic.loopNet(pts, 50.0)
    }

    @Test
    fun poly_make_matchesWeb() {
        val net = loopNet()
        val poly = net.elements[0].poly
        near(poly.len, TrafficGoldens.polyLen, 1e-6, "polyLen")
        for (i in TrafficGoldens.vmaxProbes.indices) {
            near(poly.vmax[i * 4].toDouble(), TrafficGoldens.vmaxProbes[i], 1e-6, "vmax[${i * 4}]")
        }
    }

    @Test
    fun idmAccel_matchesWeb() {
        val cases = listOf(
            listOf(10.0, 13.0, 1e9, 0.0), listOf(8.0, 13.0, 12.0, -2.0), listOf(5.0, 13.0, 4.5, 3.0),
            listOf(13.0, 13.0, 30.0, 0.0), listOf(2.0, 13.0, 1.2, 1.0), listOf(0.0, 10.0, 1e9, 0.0),
        )
        for ((i, c) in cases.withIndex()) {
            val a = Traffic.idmAccel(c[0], c[1], c[2], c[3], Traffic.A_MAX)
            near(a, TrafficGoldens.idmProbes[i], 1e-9, "idm[$i]")
        }
    }

    @Test
    fun sim_spawnAndDrive_matchesWeb() {
        assertEquals(TrafficGoldens.trafficSeed, simHashString("traffic").toLong() and 0xFFFFFFFFL)
        val net = loopNet()
        val sim = Traffic.TrafficSim(net, 1337, simHashString("traffic"))
        sim.onNetwork()
        val made = sim.spawn(40)
        assertEquals("spawned", TrafficGoldens.spawned.toLong(), made.toLong())
        for (i in 0 until 400) sim.update(0.05)
        assertEquals("fleet", TrafficGoldens.count.toLong(), sim.vehicles.size.toLong())
        for (i in TrafficGoldens.veh.indices) {
            val g = TrafficGoldens.veh[i]
            val v = sim.vehicles[i]
            assertEquals("veh[$i].type", g.typeId, v.typeId)
            near(v.s, g.s, 1e-6, "veh[$i].s")
            near(v.v, g.v, 1e-6, "veh[$i].v")
            near(v.x, g.x, 1e-6, "veh[$i].x")
            near(v.z, g.z, 1e-6, "veh[$i].z")
            near(v.yaw, g.yaw, 1e-6, "veh[$i].yaw")
            near(v.brake, g.brake, 1e-6, "veh[$i].brake")
            assertEquals("veh[$i].ri", g.ri.toLong(), v.ri.toLong())
            assertEquals("veh[$i].route", g.route.toLong(), v.route.size.toLong())
        }
    }
}
