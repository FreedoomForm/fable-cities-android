package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * Builds a routable [Traffic.LaneGraphIn] from the demo city's road polylines — the native
 * stand-in for the web's roads/RoadNetwork.js laneGraph(). The web builds its lane graph from
 * an interactive segment/node road module; the native demo city owns plain polylines, so this
 * builder reproduces the same topology rules on them:
 *
 *  - nodes where road endpoints meet (snapped) or where roads cross / T into each other
 *    (polylines are split at the intersection),
 *  - per-direction lanes offset to the right of travel with the site's ROAD_TYPES offsets
 *    (local 1×1.9 m @ 50 km/h · avenue 2×3.375/7.125 m @ 60 · highway 3 lanes @ 110),
 *  - lane connections via the site's classify() rules: straight-through connects matched by
 *    lane rank, left turns from the innermost lane, right turns from the outermost, U-turns
 *    only at dead ends, with the web's connectMatched rank fan-out.
 *
 * The resulting graph feeds Traffic.LaneNetwork (junctions, signals, conflict matrix, A*),
 * whose port is pinned bit-exactly against the real web modules by LaneNetworkParityTest.
 */
object RoadNetBuilder {

    private class TypeDef(val lanes: Int, val offsets: DoubleArray, val speed: Double, val width: Double, val rank: Int, val pedOffsets: DoubleArray)

    // src/modules/roads/RoadTypes.js cross-sections (per-direction offsets, inner → outer)
    private val TYPES = mapOf(
        "local" to TypeDef(1, doubleArrayOf(1.9), 50.0, 3.8, 2, doubleArrayOf(5.0)),
        "avenue" to TypeDef(2, doubleArrayOf(3.375, 7.125), 60.0, 3.75, 3, doubleArrayOf(10.6)),
        "highway" to TypeDef(3, doubleArrayOf(3.35, 6.85, 10.35), 110.0, 3.5, 4, doubleArrayOf()),
    )

    private class Pt(val x: Double, val z: Double)
    private class Split(val s: Double, val nodeId: Int)

    private class Edge(val roadIdx: Int, val type: String, val a: Int, val b: Int, val pts: List<Pt>)

    /** headingOf from roads/curves.js — 0 = north (−Z), clockwise positive. */
    private fun headingOf(dx: Double, dz: Double): Double = atan2(dx, -dz)

    private fun wrapPi(aIn: Double): Double {
        var a = aIn % (PI * 2.0)
        if (a > PI) a -= PI * 2.0
        if (a < -PI) a += PI * 2.0
        return a
    }

    fun build(roads: List<DemoCity.RoadPoly>): Traffic.LaneGraphIn {
        // ---- 1. nodes: snapped endpoints, then interior crossing / T points
        val nodeX = ArrayList<Double>()
        val nodeZ = ArrayList<Double>()
        fun nodeAt(x: Double, z: Double): Int {
            for (i in nodeX.indices) {
                if (hypot(nodeX[i] - x, nodeZ[i] - z) < 2.0) return i
            }
            nodeX.add(x); nodeZ.add(z)
            return nodeX.size - 1
        }

        // dense world polylines with arc length
        val polys = ArrayList<List<Pt>>()
        val types = ArrayList<String>()
        for (r in roads) {
            if (r.world.size < 2) { polys.add(emptyList()); types.add(r.type); continue }
            val pts = ArrayList<Pt>(r.world.size)
            for (p in r.world) pts.add(Pt(p[0], p[1]))
            polys.add(pts); types.add(r.type)
        }

        // endpoints become nodes first
        val endNodes = Array(polys.size) { intArrayOf(-1, -1) }
        for (i in polys.indices) {
            val p = polys[i]
            if (p.isEmpty()) continue
            endNodes[i][0] = nodeAt(p[0].x, p[0].z)
            endNodes[i][1] = nodeAt(p[p.size - 1].x, p[p.size - 1].z)
        }

        // ---- 2. split points: proper intersections + endpoints landing on another road
        val splits = Array(polys.size) { ArrayList<Split>() }
        for (i in polys.indices) splits[i].add(Split(0.0, endNodes[i][0]))
        for (i in polys.indices) {
            val pi = polys[i]
            if (pi.size < 2) continue
            for (j in polys.indices) {
                if (i == j) continue
                val pj = polys[j]
                if (pj.size < 2) continue
                // endpoint of j on the body of i?
                for (end in 0..1) {
                    val e = if (end == 0) pj[0] else pj[pj.size - 1]
                    val sj = projectOnPolyline(pi, e)
                    if (sj != null && sj > 1.0 && sj < polyLen(pi) - 1.0) {
                        splits[i].add(Split(sj, endNodes[j][end]))
                    }
                }
                // proper crossings between i and j (only when j > i to emit once — both get the split)
                if (j > i) {
                    for (a in 0 until pi.size - 1) {
                        for (b in 0 until pj.size - 1) {
                            val hit = segX(pi[a], pi[a + 1], pj[b], pj[b + 1]) ?: continue
                            val s = arcTo(pi, a, hit[0])
                            if (s < 1.0 || s > polyLen(pi) - 1.0) continue
                            val nodeId = nodeAt(hit[1], hit[2])
                            splits[i].add(Split(s, nodeId))
                            val sj = arcTo(pj, b, hit[1])
                            if (sj > 1.0 && sj < polyLen(pj) - 1.0) splits[j].add(Split(sj, nodeId))
                        }
                    }
                }
            }
        }
        for (i in polys.indices) {
            val p = polys[i]
            if (p.isNotEmpty()) splits[i].add(Split(polyLen(p), endNodes[i][1]))
        }

        // ---- 3. edges between consecutive split points
        val edges = ArrayList<Edge>()
        for (i in polys.indices) {
            val p = polys[i]
            if (p.size < 2) continue
            val list = splits[i].sortedBy { it.s }
            val cum = cumulative(p)
            for (k in 0 until list.size - 1) {
                val s0 = list[k].s
                val s1 = list[k + 1].s
                if (s1 - s0 < 6.0) continue
                val piece = ArrayList<Pt>()
                piece.add(pointAt(p, cum, s0))
                for (v in p) {
                    val sv = distAlong(p, cum, v)
                    if (sv > s0 + 0.5 && sv < s1 - 0.5) piece.add(v)
                }
                piece.add(pointAt(p, cum, s1))
                edges.add(Edge(i, types[i], list[k].nodeId, list[k + 1].nodeId, piece))
            }
        }

        // ---- 4. lanes per edge, both directions (right-hand traffic)
        class LaneG(val id: String, val points: List<DoubleArray>, val speed: Double,
                    val segmentId: String, val dir: Int, val from: String, val to: String,
                    val width: Double, val rank: Int)
        val lanes = ArrayList<LaneG>()
        for ((ei, e) in edges.withIndex()) {
            val td = TYPES[e.type] ?: TYPES["local"]!!
            val segId = "e$ei"
            for (dir in intArrayOf(1, -1)) {
                for (rank in 0 until td.lanes) {
                    val lat = td.offsets[rank] * dir
                    // right of a→b travel: right = (−dz, dx) of the local segment direction
                    val pts = ArrayList<DoubleArray>(e.pts.size)
                    for (v in 0 until e.pts.size) {
                        val p0 = e.pts[maxOf(0, v - 1)]
                        val p1 = e.pts[minOf(e.pts.size - 1, v + 1)]
                        val dx = p1.x - p0.x
                        val dz = p1.z - p0.z
                        val l = hypot(dx, dz)
                        val ln = if (l < 1e-6) 1.0 else l
                        val rx = -dz / ln
                        val rz = dx / ln
                        pts.add(doubleArrayOf(e.pts[v].x + rx * lat, 0.0, e.pts[v].z + rz * lat))
                    }
                    lanes.add(LaneG(
                        "$segId:$dir:$rank", pts, td.speed, segId, dir,
                        if (dir == 1) "n${e.a}" else "n${e.b}",
                        if (dir == 1) "n${e.b}" else "n${e.a}",
                        td.width, rank,
                    ))
                }
            }
        }

        // ---- 5. connections: the site's laneGraph() rules (roads/RoadNetwork.js)
        val bySeg = HashMap<String, ArrayList<LaneG>>()
        for (l in lanes) bySeg.getOrPut(l.segmentId) { ArrayList() }.add(l)
        val outDirBy = HashMap<String, DoubleArray>() // "$segId@$nodeId" -> away-from-node unit dir
        for ((ei, e) in edges.withIndex()) {
            val segId = "e$ei"
            val a = e.pts[0]
            val b = e.pts[e.pts.size - 1]
            val dx = b.x - a.x
            val dz = b.z - a.z
            val l = hypot(dx, dz)
            val ln = if (l < 1e-6) 1.0 else l
            outDirBy["$segId@n${e.a}"] = doubleArrayOf(dx / ln, dz / ln)
            outDirBy["$segId@n${e.b}"] = doubleArrayOf(-dx / ln, -dz / ln)
        }

        val connections = LinkedHashMap<String, List<String>>()
        for (l in lanes) connections[l.id] = ArrayList()
        val nodeEdges = HashMap<Int, ArrayList<String>>()
        for ((ei, e) in edges.withIndex()) {
            nodeEdges.getOrPut(e.a) { ArrayList() }.add("e$ei")
            if (e.b != e.a) nodeEdges.getOrPut(e.b) { ArrayList() }.add("e$ei")
        }
        for ((nodeId, segIds) in nodeEdges) {
            val node = "n$nodeId"
            class End(val segId: String, val dx: Double, val dz: Double, val cls: Char)
            val ends = segIds.map { segId ->
                val d = outDirBy["$segId@$node"]!!
                End(segId, d[0], d[1], 'S')
            }
            for (e in ends) {
                val segLs = bySeg[e.segId] ?: continue
                val incoming = segLs.filter { it.to == node }
                if (incoming.isEmpty()) continue
                val n = incoming.size
                val travelX = -e.dx
                val travelZ = -e.dz
                data class Other(val segId: String, val cls: Char, val out: List<LaneG>)
                val others = ends.filter { it.segId != e.segId }.map { o ->
                    val rel = wrapPi(headingOf(o.dx, o.dz) - headingOf(travelX, travelZ))
                    val a = abs(rel)
                    val cls = if (a <= PI / 6.0) 'S' else if (a >= 5.0 * PI / 6.0) 'U' else if (rel > 0) 'R' else 'L'
                    Other(o.segId, cls, (bySeg[o.segId] ?: emptyList()).filter { it.from == node }.sortedBy { it.rank })
                }
                for (lane in incoming) {
                    val r = lane.rank
                    val conn = connections[lane.id] as ArrayList<String>
                    fun connectMatched(out: List<LaneG>) {
                        if (out.isEmpty()) return
                        val m = out.size
                        conn.add(out[minOf(r, m - 1)].id)
                        if (r == n - 1) for (k in r + 1 until m) conn.add(out[k].id)
                    }
                    if (ends.size == 1) {
                        val back = segLs.filter { it.from == node }.sortedBy { it.rank }
                        if (back.isNotEmpty()) conn.add(back[minOf(r, back.size - 1)].id)
                    } else if (ends.size == 2) {
                        connectMatched(others[0].out)
                    } else {
                        for (o in others) {
                            if (o.cls == 'S') connectMatched(o.out)
                            else if (o.cls == 'L' && (r == 0 || n == 1) && o.out.isNotEmpty()) conn.add(o.out[0].id)
                            else if (o.cls == 'R' && (r == n - 1 || n == 1) && o.out.isNotEmpty()) conn.add(o.out[o.out.size - 1].id)
                        }
                        if (conn.isEmpty()) for (o in others) if (o.cls != 'U') connectMatched(o.out)
                        if (conn.isEmpty()) for (o in others) connectMatched(o.out)
                    }
                }
            }
        }

        val segType = HashMap<String, String>()
        val segLength = HashMap<String, Double>()
        val segLaneCount = HashMap<String, Int>()
        for ((ei, e) in edges.withIndex()) {
            val segId = "e$ei"
            segType[segId] = e.type
            var len = 0.0
            for (v in 1 until e.pts.size) {
                len += hypot(e.pts[v].x - e.pts[v - 1].x, e.pts[v].z - e.pts[v - 1].z)
            }
            segLength[segId] = len
        }
        for (l in lanes) {
            segLaneCount[l.segmentId] = (segLaneCount[l.segmentId] ?: 0) + 1
        }
        val nodePos = HashMap<String, DoubleArray>()
        for (i in nodeX.indices) nodePos["n$i"] = doubleArrayOf(nodeX[i], nodeZ[i])

        val graphLanes = lanes.map { l ->
            Traffic.GraphLane(l.id, l.points, l.speed, l.segmentId, l.dir, l.from, l.to, l.width)
        }
        val graphConns = LinkedHashMap<String, List<String>>()
        for (l in lanes) graphConns[l.id] = connections[l.id] ?: emptyList()

        // ---- pedestrian sidewalks (roads/RoadNetwork.js pedestrian block):
        //      one lane per side at the type's pedestrianOffsets, any-in -> any-out at nodes
        val pedLanes = ArrayList<Traffic.GraphLane>()
        val pedConns = LinkedHashMap<String, List<String>>()
        for ((ei, e) in edges.withIndex()) {
            val td = TYPES[e.type] ?: TYPES["local"]!!
            if (td.pedOffsets.isEmpty()) continue
            val segId = "e$ei"
            for (dir in intArrayOf(1, -1)) {
                for (rank in td.pedOffsets.indices) {
                    val lat = td.pedOffsets[rank] * dir
                    val pts = ArrayList<DoubleArray>(e.pts.size)
                    for (v in 0 until e.pts.size) {
                        val p0 = e.pts[maxOf(0, v - 1)]
                        val p1 = e.pts[minOf(e.pts.size - 1, v + 1)]
                        val dx = p1.x - p0.x
                        val dz = p1.z - p0.z
                        val l = hypot(dx, dz)
                        val ln = if (l < 1e-6) 1.0 else l
                        val rx = -dz / ln
                        val rz = dx / ln
                        pts.add(doubleArrayOf(e.pts[v].x + rx * lat, 0.2, e.pts[v].z + rz * lat))
                    }
                    pedLanes.add(Traffic.GraphLane(
                        "${segId}:p${if (dir == 1) "f" else "r"}$rank", pts, 5.0, segId, dir,
                        if (dir == 1) "n${e.a}" else "n${e.b}",
                        if (dir == 1) "n${e.b}" else "n${e.a}", 1.5,
                    ))
                }
            }
        }
        for (l in pedLanes) pedConns[l.id] = emptyList()
        val nodePed = HashMap<String?, ArrayList<Traffic.GraphLane>>()
        for (l in pedLanes) {
            nodePed.getOrPut(l.from) { ArrayList() }.add(l)
            if (l.to != l.from) nodePed.getOrPut(l.to) { ArrayList() }.add(l)
        }
        for ((nodeId, list) in nodePed) {
            val pIn = list.filter { it.to == nodeId }
            val pOut = list.filter { it.from == nodeId }
            for (l in pIn) pedConns[l.id] = pOut.map { it.id }
        }
        val graphPedLanes = pedLanes.map { l -> Traffic.GraphLane(l.id, l.points, l.speed, l.segmentId, l.dir, l.from, l.to, l.width) }
        val graphPedConns = LinkedHashMap<String, List<String>>()
        for (l in pedLanes) graphPedConns[l.id] = pedConns[l.id] ?: emptyList()

        return Traffic.LaneGraphIn(graphLanes, graphConns, nodePos, segType,
            Traffic.LaneGraphIn(graphPedLanes, graphPedConns, nodePos, segType),
            segLength, segLaneCount)
    }

    // ------------------------------------------------------------------ polyline helpers

    private fun polyLen(p: List<Pt>): Double {
        var s = 0.0
        for (i in 1 until p.size) s += hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z)
        return s
    }

    private fun cumulative(p: List<Pt>): DoubleArray {
        val c = DoubleArray(p.size)
        for (i in 1 until p.size) c[i] = c[i - 1] + hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z)
        return c
    }

    private fun distAlong(p: List<Pt>, cum: DoubleArray, v: Pt): Double {
        for (i in p.indices) if (p[i] === v || (p[i].x == v.x && p[i].z == v.z)) return cum[i]
        return 0.0
    }

    private fun pointAt(p: List<Pt>, cum: DoubleArray, s: Double): Pt {
        for (i in 1 until p.size) {
            if (cum[i] >= s) {
                val seg = cum[i] - cum[i - 1]
                val t = if (seg <= 1e-9) 0.0 else (s - cum[i - 1]) / seg
                return Pt(p[i - 1].x + (p[i].x - p[i - 1].x) * t, p[i - 1].z + (p[i].z - p[i - 1].z) * t)
            }
        }
        return p[p.size - 1]
    }

    private fun arcTo(p: List<Pt>, segIdx: Int, t: Double): Double {
        val cum = cumulative(p)
        val seg = cum[segIdx + 1] - cum[segIdx]
        return cum[segIdx] + seg * t
    }

    /** Arc length of the point on the polyline nearest to q (null when > 2 m away). */
    private fun projectOnPolyline(p: List<Pt>, q: Pt): Double? {
        val cum = cumulative(p)
        var best = Double.MAX_VALUE
        var bestS = 0.0
        for (i in 0 until p.size - 1) {
            val ax = p[i].x; val az = p[i].z
            val bx = p[i + 1].x; val bz = p[i + 1].z
            val dx = bx - ax; val dz = bz - az
            val l2 = dx * dx + dz * dz
            var t = if (l2 < 1e-9) 0.0 else ((q.x - ax) * dx + (q.z - az) * dz) / l2
            t = t.coerceIn(0.0, 1.0)
            val px = ax + dx * t
            val pz = az + dz * t
            val d = hypot(q.x - px, q.z - pz)
            if (d < best) { best = d; bestS = cum[i] + kotlin.math.sqrt(l2) * t }
        }
        return if (best <= 2.0) bestS else null
    }

    /** Proper segment-segment intersection returning [t, x, z] on a→b. */
    private fun segX(a0: Pt, a1: Pt, b0: Pt, b1: Pt): DoubleArray? {
        val r1 = a1.x - a0.x
        val r2 = a1.z - a0.z
        val s1 = b1.x - b0.x
        val s2 = b1.z - b0.z
        val den = r1 * s2 - r2 * s1
        if (abs(den) < 1e-9) return null
        val t = ((b0.x - a0.x) * s2 - (b0.z - a0.z) * s1) / den
        val u = ((b0.x - a0.x) * r2 - (b0.z - a0.z) * r1) / den
        if (t < 0.02 || t > 0.98 || u < 0.02 || u > 0.98) return null
        return doubleArrayOf(t, a0.x + r1 * t, a0.z + r2 * t)
    }
}
