package com.fablecities.android

import com.fablecities.android.worldgen.Traffic
import com.fablecities.android.worldgen.LaneNetGoldens
import com.fablecities.android.worldgen.simHashString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bit-parity golden tests against the REAL browser traffic/LaneNetwork.js + TrafficSim.js:
 *  - the full element graph (lanes + Bézier connectors) on a synthetic junction world with a
 *    signalised avenue 4-way, a signalised avenue T, a priority local crossing and dead ends
 *  - junction records: approaches, signal phases, the FNV desync timer, the conflict matrix
 *  - the rank-weighted spawn table, weighted picks and explicit A* routes
 *  - 600 standalone signal frames + a 900-frame driven simulation with claims, red-light
 *    stops, despawning and turn indicators
 * Expected values were produced by running the actual web code in Node
 * (tools/probe_lanenetwork.mjs). The native network must route, signal and drive like the site.
 */
class LaneNetworkParityTest {

    private fun near(actual: Double, expected: Double, tol: Double, what: String) {
        assertTrue(
            "$what: expected $expected, got $actual (diff ${actual - expected})",
            kotlin.math.abs(actual - expected) <= tol
        )
    }

    private fun buildNet(): Traffic.LaneNetwork {
        val pedGraph = Traffic.LaneGraphIn(
            lanes = LaneNetGoldens.graphPedLanes.map { l ->
                Traffic.GraphLane(l.id, l.points, l.speed, l.segmentId, l.dir, l.from, l.to, l.width)
            },
            connections = LaneNetGoldens.graphPedConnections,
            nodePos = LaneNetGoldens.graphNodePos,
            segType = LaneNetGoldens.graphSegType,
        )
        val graph = Traffic.LaneGraphIn(
            lanes = LaneNetGoldens.graphLanes.map { l ->
                Traffic.GraphLane(l.id, l.points, l.speed, l.segmentId, l.dir, l.from, l.to, l.width)
            },
            connections = LaneNetGoldens.graphConnections,
            nodePos = LaneNetGoldens.graphNodePos,
            segType = LaneNetGoldens.graphSegType,
            pedestrian = pedGraph,
        )
        val net = Traffic.LaneNetwork()
        assertTrue(net.rebuild(graph, LaneNetGoldens.graphVersion))
        return net
    }

    @Test
    fun elementGraph_matchesWeb() {
        val net = buildNet()
        assertEquals(LaneNetGoldens.elements.toLong(), net.elements.size.toLong())
        assertEquals(LaneNetGoldens.laneElems.toLong(), net.laneElems.size.toLong())
        assertEquals(LaneNetGoldens.nodes.toLong(), net.nodes.size.toLong())
        for ((i, g) in LaneNetGoldens.elG.withIndex()) {
            val el = net.elements[i]
            assertEquals("el[$i].kind", g.kind.toLong(), el.kind.toLong())
            assertEquals("el[$i].id", g.id, el.id)
            assertEquals("el[$i].turn", g.turn.toLong(), el.turn.toLong())
            assertEquals("el[$i].rank", g.rank.toLong(), el.rank.toLong())
            assertEquals("el[$i].fromLane", g.fromLane.toLong(), el.fromLane.toLong())
            assertEquals("el[$i].toLane", g.toLane.toLong(), el.toLane.toLong())
            assertEquals("el[$i].localIdx", g.localIdx.toLong(), el.localIdx.toLong())
            near(el.yieldDelay, g.yieldDelay, 1e-6, "el[$i].yieldDelay")
            near(el.speed, g.speed, 1e-6, "el[$i].speed")
            near(el.poly.len, g.len, 1e-6, "el[$i].len")
            near(el.poly.vmax[0].toDouble(), g.vmax0, 1e-6, "el[$i].vmax0")
            near(el.poly.vmax[el.poly.n / 2].toDouble(), g.vmaxM, 1e-6, "el[$i].vmaxM")
            near(el.poly.vmax[el.poly.n - 1].toDouble(), g.vmaxL, 1e-6, "el[$i].vmaxL")
            near(el.sx, g.sx, 1e-6, "el[$i].sx")
            near(el.sz, g.sz, 1e-6, "el[$i].sz")
            near(el.ex, g.ex, 1e-6, "el[$i].ex")
            near(el.ez, g.ez, 1e-6, "el[$i].ez")
            assertEquals("el[$i].outs", g.outs.joinToString(","), el.outs.joinToString(","))
        }
        assertEquals("laneElemList", LaneNetGoldens.laneElemList.joinToString(","), net.laneElems.joinToString(","))
    }

    @Test
    fun junctionsAndSignals_matchWeb() {
        val net = buildNet()
        assertEquals(LaneNetGoldens.nodeG.size.toLong(), net.nodes.size.toLong())
        for ((i, g) in LaneNetGoldens.nodeG.withIndex()) {
            val n = net.nodes[g.id] ?: throw AssertionError("node ${g.id} missing")
            assertEquals("node[$i].signalized", g.signalized, n.signalized)
            assertEquals("node[$i].phases", g.phases.joinToString(";") { p -> p.joinToString(",") }, n.phases.joinToString(";") { p -> p.joinToString(",") })
            assertEquals("node[$i].phase", g.phase.toLong(), n.phase.toLong())
            near(n.timer, g.timer, 1e-6, "node[$i].timer")
            near(n.greenTime, g.greenTime, 1e-6, "node[$i].greenTime")
            assertEquals("node[$i].needsControl", g.needsControl, n.needsControl)
            assertEquals("node[$i].maxRank", g.maxRank.toLong(), n.maxRank.toLong())
            assertEquals("node[$i].approachKeys", g.approaches.joinToString(",") { it.key }, n.approaches.values.joinToString(",") { it.key })
            for ((j, ga) in g.approaches.withIndex()) {
                val a = n.approachList[j]
                assertEquals("node[$i].ap[$j].idx", ga.idx.toLong(), a.idx.toLong())
                near(a.dx, ga.dx, 1e-6, "node[$i].ap[$j].dx")
                near(a.dz, ga.dz, 1e-6, "node[$i].ap[$j].dz")
                assertEquals("node[$i].ap[$j].rank", ga.rank.toLong(), a.rank.toLong())
                assertEquals("node[$i].ap[$j].lanes", ga.lanes.joinToString(","), a.lanes.joinToString(","))
            }
            assertEquals("node[$i].conns", g.conns.joinToString(","), n.conns.joinToString(","))
            assertEquals("node[$i].conflict", g.conflict, n.conflict.joinToString("") { it.toInt().toString() })
            assertEquals("node[$i].inLanes", g.inLanes.joinToString(","), n.inLanes.joinToString(","))
        }
        // rank-weighted spawn table
        assertEquals(LaneNetGoldens.spawnCum.size, net.spawnCum.size)
        for (i in net.spawnCum.indices) near(net.spawnCum[i].toDouble(), LaneNetGoldens.spawnCum[i].toDouble(), 1e-6, "spawnCum[$i]")
        near(net.spawnTotal, LaneNetGoldens.spawnTotal, 1e-6, "spawnTotal")
        near(net.totalLength, LaneNetGoldens.totalLength, 1e-6, "totalLength")
        for ((i, r) in listOf(0.0, 0.13, 0.26, 0.39, 0.5, 0.62, 0.75, 0.88, 0.97, 0.999).withIndex()) {
            assertEquals("randomLane[$i]", LaneNetGoldens.randomLaneProbes[i].toLong(), net.randomLane(r).toLong())
        }
        for ((i, pr) in listOf(0 to 5, 2 to 9, 12 to 1, 7 to 3).withIndex()) {
            val p = net.route(pr.first, pr.second)
            val g = LaneNetGoldens.routeProbes[i]
            assertEquals("route[$i]", if (g == null) "null-path" else g.joinToString(","), p?.joinToString(",") ?: "null-path")
        }
        // pedestrian network structure
        assertEquals("pedElements", LaneNetGoldens.pedElementCount.toLong(), net.pedElements.size.toLong())
        assertEquals("pedLaneElems", LaneNetGoldens.pedLaneElemCount.toLong(), net.pedLaneElems.size.toLong())
        assertEquals("pedLaneElemList", LaneNetGoldens.pedLaneElemList.joinToString(","), net.pedLaneElems.joinToString(","))
        for ((i, g) in LaneNetGoldens.pedG.withIndex()) {
            val el = net.pedElements[i]
            assertEquals("ped[$i].kind", g.kind.toLong(), el.kind.toLong())
            assertEquals("ped[$i].id", g.id, el.id)
            assertEquals("ped[$i].crossing", g.crossing == 1, el.crossing)
            near(el.poly.len, g.len, 1e-6, "ped[$i].len")
            assertEquals("ped[$i].node", g.node, el.node ?: "")
            assertEquals("ped[$i].outs", g.outs.joinToString(","), el.outs.joinToString(","))
        }
        for ((i, r) in listOf(0.0, 0.17, 0.34, 0.51, 0.68, 0.85, 0.99).withIndex()) {
            assertEquals("randomPedLane[$i]", LaneNetGoldens.randomPedLaneProbes[i].toLong(), net.randomPedLane(r).toLong())
        }
        assertEquals(LaneNetGoldens.pedCum.size, net.pedCum.size)
        for (i in net.pedCum.indices) near(net.pedCum[i].toDouble(), LaneNetGoldens.pedCum[i].toDouble(), 1e-6, "pedCum[$i]")
        near(net.pedTotal, LaneNetGoldens.pedTotal, 1e-6, "pedTotal")
    }

    @Test
    fun signalEvolution_matchesWeb() {
        val net = buildNet()
        repeat(600) { net.updateSignals(1.0 / 30.0) }
        val signalized = net.nodes.values.filter { it.signalized }.toList()
        assertEquals(LaneNetGoldens.signalSnap.size.toLong(), signalized.size.toLong())
        for ((i, g) in LaneNetGoldens.signalSnap.withIndex()) {
            val n = signalized[i]
            assertEquals("sig[$i].id", g.id, n.id)
            assertEquals("sig[$i].state", g.state.toLong(), n.state.toLong())
            assertEquals("sig[$i].phase", g.phase.toLong(), n.phase.toLong())
            near(n.timer, g.timer, 1e-6, "sig[$i].timer")
            assertEquals("sig[$i].green", g.green.joinToString(","), n.approachList.joinToString(",") { if (it.green) "1" else "0" })
            assertEquals("sig[$i].amber", g.amber.joinToString(","), n.approachList.joinToString(",") { if (it.amber) "1" else "0" })
        }
    }

    private class VehSnap(
        val id: Int, val t: String, val e: Int, val ri: Int, val s: Double, val v: Double,
        val x: Double, val y: Double, val z: Double, val yaw: Double, val brake: Double, val wait: Double,
        val bl: Int, val speedRatio: Double, val dist: Double,
    )

    private class PedSnap(
        val id: Int, val e: Int, val s: Double, val v: Double, val x: Double, val y: Double,
        val z: Double, val yaw: Double, val ph: Double, val d: Double,
    )

    private data class ClaimS(val id: Int, val state: Int, val go: Boolean, val local: Int)

    private data class Snap(val f: Int, val fleet: Int, val veh: List<VehSnap>, val claims: Map<String, List<ClaimS>>, val peds: List<PedSnap>)

    private fun snapVeh(v: Traffic.Vehicle) = VehSnap(
        v.id, v.typeId, v.elem, v.ri, v.s, v.v, v.x, v.y, v.z, v.yaw, v.brake, v.wait,
        v.blinkSide, v.speedRatio, v.dist,
    )

    private fun snapPed(p: Traffic.Ped) = PedSnap(
        p.id, p.elem, p.s, p.v, p.x, p.y, p.z, p.yaw, p.phase, p.dist,
    )

    @Test
    fun drivenSim_matchesWeb() {
        val net = buildNet()
        repeat(600) { net.updateSignals(1.0 / 30.0) }
        val sim = Traffic.TrafficSim(net, 1337, simHashString("traffic"))
        sim.onNetwork()
        val made = sim.spawn(14)
        assertEquals("spawned", LaneNetGoldens.spawned.toLong(), made.toLong())
        val pedsMade = sim.spawnPeds(10)
        assertEquals("pedsSpawned", LaneNetGoldens.pedsSpawned.toLong(), pedsMade.toLong())
        var despawned = -1
        val snaps = ArrayList<Snap>()
        for (f in 1..900) {
            sim.update(1.0 / 30.0, 12.0, -20.0)
            if (f == 480) despawned = sim.despawnFar(2)
            if (f == 150 || f == 300 || f == 480 || f == 620 || f == 900) {
                // immutable copy: the live Vehicle objects keep moving in later frames
                val claims = net.nodes.values.filter { it.claims.isNotEmpty() }.associate { n ->
                    n.id to n.claims.values.map { c -> ClaimS(c.id, c.state, c.go, c.local) }
                }
                snaps.add(Snap(f, sim.vehicles.size, sim.vehicles.map { snapVeh(it) }, claims, sim.peds.map { snapPed(it) }))
            }
        }
        for ((i, g) in LaneNetGoldens.checkpoints.withIndex()) {
            val (f, fleet, veh, claims, peds) = snaps[i]
            assertEquals("cp[$i].f", g.f.toLong(), f.toLong())
            assertEquals("cp[$i].despawned", (if (g.despawned >= 0) g.despawned else despawned).toLong(), despawned.toLong())
            assertEquals("cp[$i].fleet", g.fleet.toLong(), fleet.toLong())
            assertEquals("cp[$i].nveh", g.veh.size.toLong(), veh.size.toLong())
            for ((j, gv) in g.veh.withIndex()) {
                val v = veh[j]
                assertEquals("cp[$i].veh[$j].id", gv.id.toLong(), v.id.toLong())
                assertEquals("cp[$i].veh[$j].type", gv.t, v.t)
                assertEquals("cp[$i].veh[$j].elem", gv.e.toLong(), v.e.toLong())
                assertEquals("cp[$i].veh[$j].ri", gv.ri.toLong(), v.ri.toLong())
                near(v.s, gv.s, 1e-6, "cp[$i].veh[$j].s")
                near(v.v, gv.v, 1e-6, "cp[$i].veh[$j].v")
                near(v.x, gv.x, 1e-6, "cp[$i].veh[$j].x")
                near(v.y, gv.y, 1e-6, "cp[$i].veh[$j].y")
                near(v.z, gv.z, 1e-6, "cp[$i].veh[$j].z")
                near(v.yaw, gv.yaw, 1e-6, "cp[$i].veh[$j].yaw")
                near(v.brake, gv.br, 1e-6, "cp[$i].veh[$j].brake")
                near(v.wait, gv.w, 1e-6, "cp[$i].veh[$j].wait")
                assertEquals("cp[$i].veh[$j].blinkSide", gv.bl.toLong(), v.bl.toLong())
                near(v.speedRatio, gv.sr, 1e-6, "cp[$i].veh[$j].speedRatio")
                near(v.dist, gv.d, 1e-6, "cp[$i].veh[$j].dist")
            }
            assertEquals("cp[$i].claimNodes", g.claims.size, claims.size)
            for ((nodeId, cs) in g.claims) {
                val list = claims[nodeId] ?: throw AssertionError("cp[$i] claims node $nodeId missing")
                assertEquals("cp[$i].claims[$nodeId].size", cs.size.toLong(), list.size.toLong())
                for ((k, gc) in cs.withIndex()) {
                    val c = list[k]
                    assertEquals("cp[$i].claims[$nodeId][$k].id", gc.id.toLong(), c.id.toLong())
                    assertEquals("cp[$i].claims[$nodeId][$k].state", gc.state.toLong(), c.state.toLong())
                    assertEquals("cp[$i].claims[$nodeId][$k].go", gc.go, c.go)
                    assertEquals("cp[$i].claims[$nodeId][$k].local", gc.local.toLong(), c.local.toLong())
                }
            }
            assertEquals("cp[$i].npeds", g.peds.size.toLong(), peds.size.toLong())
            for ((j, gp) in g.peds.withIndex()) {
                val p = peds[j]
                assertEquals("cp[$i].ped[$j].id", gp.id.toLong(), p.id.toLong())
                assertEquals("cp[$i].ped[$j].elem", gp.e.toLong(), p.e.toLong())
                near(p.s, gp.s, 1e-6, "cp[$i].ped[$j].s")
                near(p.v, gp.v, 1e-6, "cp[$i].ped[$j].v")
                near(p.x, gp.x, 1e-6, "cp[$i].ped[$j].x")
                near(p.y, gp.y, 1e-6, "cp[$i].ped[$j].y")
                near(p.z, gp.z, 1e-6, "cp[$i].ped[$j].z")
                near(p.yaw, gp.yaw, 1e-6, "cp[$i].ped[$j].yaw")
                near(p.ph, gp.ph, 1e-6, "cp[$i].ped[$j].phase")
                near(p.d, gp.d, 1e-6, "cp[$i].ped[$j].dist")
            }
        }
    }
}
