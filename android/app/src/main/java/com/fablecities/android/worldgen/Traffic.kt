package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Traffic — a Kotlin port of the web game's traffic core:
 *
 *  - `traffic/LaneNetwork.js` makePoly/polyAt: arc-length polylines with a curvature speed limit
 *    (LAT_ACC lateral comfort) and backward smoothing so cars brake BEFORE the apex.
 *  - `traffic/VehicleModels.js` VEHICLE_SPECS/VEHICLE_IDS: the six vehicle types and their
 *    spawn weights / dimensions / vmax factors.
 *  - `traffic/TrafficSim.js`: the agent simulation — weighted type picking, clear-check spawning,
 *    route extension with the A* budget, spatial buckets, the IDM car-following leader search,
 *    the per-vehicle integration and element transitions.
 *  - the FULL LaneNetwork: lane elements + Bézier connectors through junctions, junction records
 *    with signal phases (or priority rules), the connector conflict matrix, the rank-weighted
 *    spawn table and the A* router; and the junction control in TrafficSim: red-light stop
 *    distances, per-node first-come-first-served claims ordered by turn priority and rank,
 *    blocked-exit refusal (never enter a junction whose exit is full) and turn indicators.
 *
 * Bit-parity is pinned by TrafficParityTest (single closed-loop lane) and LaneNetworkParityTest
 * (a signalised 4-way + an unsignalised T junction, driven for 900 steps) against the REAL web
 * modules run in Node by tools/probe_traffic.mjs and tools/probe_lanenetwork.mjs.
 */
object Traffic {
    const val KMH = 1.0 / 3.6
    const val LAT_ACC = 3.4 // m/s² lateral comfort → curve speed limit

    // TrafficSim constants
    const val A_MAX = 2.85
    const val B_COMF = 3.30
    const val S0 = 2.05
    const val T_HEAD = 1.05
    const val DEC_MAX = -7.6
    const val CLAIM_DIST = 30.0
    const val LOOKAHEAD = 85.0

    // ------------------------------------------------------------------ polyline (LaneNetwork.js)

    /** Float32 storage like the web's Float32Arrays (render-only data). */
    class Poly(val n: Int, val x: FloatArray, val y: FloatArray, val z: FloatArray,
               val cum: FloatArray, val vmax: FloatArray, val len: Double)

    /** makePoly: curvature-limited per-point speed + backward smoothing (LaneNetwork.js).
     *  JS semantics: Float32Array reads are widened to doubles, arithmetic in double, stores
     *  truncate back to Float32 — reproduced exactly. */
    fun makePoly(pts: List<DoubleArray>, speed: Double): Poly {
        val n = pts.size
        val x = FloatArray(n) { pts[it][0].toFloat() }
        val y = FloatArray(n) { pts[it][1].toFloat() }
        val z = FloatArray(n) { pts[it][2].toFloat() }
        val cum = FloatArray(n)
        for (i in 1 until n) {
            val dx = x[i].toDouble() - x[i - 1].toDouble()
            val dz = z[i].toDouble() - z[i - 1].toDouble()
            val dy = y[i].toDouble() - y[i - 1].toDouble()
            cum[i] = (cum[i - 1].toDouble() + hypot(dx, hypot(dz, dy))).toFloat()
        }
        val vmax = FloatArray(n)
        for (i in 0 until n) {
            var v = speed
            if (i > 0 && i < n - 1) {
                val ax = x[i].toDouble() - x[i - 1].toDouble()
                val az = z[i].toDouble() - z[i - 1].toDouble()
                val bx = x[i + 1].toDouble() - x[i].toDouble()
                val bz = z[i + 1].toDouble() - z[i].toDouble()
                val la = hypot(ax, az); val lb = hypot(bx, bz)
                if (la > 1e-3 && lb > 1e-3) {
                    val cross = abs(ax * bz - az * bx)
                    val cx = x[i + 1].toDouble() - x[i - 1].toDouble()
                    val cz = z[i + 1].toDouble() - z[i - 1].toDouble()
                    val lc = hypot(cx, cz)
                    val lcN = if (lc == 0.0) 1.0 else lc
                    val kappa = (2.0 * cross) / (la * lb * lcN)
                    if (kappa > 1e-4) v = min(v, sqrt(LAT_ACC / kappa))
                }
            }
            vmax[i] = max(2.6, v).toFloat()
        }
        // smooth the limit backwards so cars brake before the apex, not in it
        for (i in n - 2 downTo 0) {
            val vNext = vmax[i + 1].toDouble()
            val vLim = sqrt(vNext * vNext + 2.0 * 1.6 * (cum[i + 1].toDouble() - cum[i].toDouble()))
            vmax[i] = min(vmax[i].toDouble(), vLim).toFloat()
        }
        return Poly(n, x, y, z, cum, vmax, cum[n - 1].toDouble())
    }

    class PolySample(var x: Double, var y: Double, var z: Double,
                     var tx: Double, var ty: Double, var tz: Double, var v: Double)

    /** polyAt: sample the polyline at arc length s (LaneNetwork.js). Float32 reads widened. */
    fun polyAt(poly: Poly, s: Double, out: PolySample): PolySample {
        val d = min(max(s, 0.0), poly.len)
        var lo = 0
        var hi = poly.n - 1
        while (hi - lo > 1) {
            val mid = (lo + hi) shr 1
            if (poly.cum[mid].toDouble() <= d) lo = mid else hi = mid
        }
        val seg = poly.cum[hi].toDouble() - poly.cum[lo].toDouble()
        val segN = if (seg == 0.0) 1.0 else seg
        val t = (d - poly.cum[lo].toDouble()) / segN
        val hiN = min(hi, poly.n - 1)
        out.x = poly.x[lo].toDouble() + (poly.x[hiN].toDouble() - poly.x[lo].toDouble()) * t
        out.y = poly.y[lo].toDouble() + (poly.y[hiN].toDouble() - poly.y[lo].toDouble()) * t
        out.z = poly.z[lo].toDouble() + (poly.z[hiN].toDouble() - poly.z[lo].toDouble()) * t
        val dx = poly.x[hiN].toDouble() - poly.x[lo].toDouble()
        val dy = poly.y[hiN].toDouble() - poly.y[lo].toDouble()
        val dz = poly.z[hiN].toDouble() - poly.z[lo].toDouble()
        val lh = hypot(dx, dz)
        val lhN = if (lh == 0.0) 1.0 else lh
        out.tx = dx / lhN; out.tz = dz / lhN
        out.ty = dy / (if (hypot(dx, hypot(dy, dz)) == 0.0) 1.0 else hypot(dx, hypot(dy, dz)))
        out.v = poly.vmax[lo].toDouble() + (poly.vmax[hiN].toDouble() - poly.vmax[lo].toDouble()) * t
        return out
    }

    // ------------------------------------------------------------------ IDM (TrafficSim.js)

    fun idmAccel(v: Double, v0: Double, gap: Double, dv: Double, aMax: Double): Double {
        val free = 1.0 - (max(0.0, v) / max(0.5, v0)).pow(4.0)
        var inter = 0.0
        if (gap < 1e8) {
            val sStar = S0 + max(0.0, v * T_HEAD + (v * dv) / (2.0 * sqrt(aMax * B_COMF)))
            val g = max(0.4, gap)
            inter = (sStar / g) * (sStar / g)
        }
        return aMax * (free - inter)
    }

    // ------------------------------------------------------------------ vehicle models

    class VehSpec(
        val id: String, val kind: String, val len: Double, val wid: Double,
        val weight: Double, val vmax: Double, val wheelR: Double,
    )

    val SPECS = listOf(
        VehSpec("sedan", "car", 4.62, 1.82, 0.42, 1.02, 0.325),
        VehSpec("hatchback", "car", 4.05, 1.76, 0.20, 1.0, 0.305),
        VehSpec("suv", "car", 4.80, 1.94, 0.20, 0.98, 0.375),
        VehSpec("van", "box", 5.35, 2.02, 0.10, 0.92, 0.345),
        VehSpec("truck", "truck", 8.60, 2.48, 0.05, 0.80, 0.505),
        VehSpec("bus", "bus", 11.80, 2.55, 0.03, 0.78, 0.505),
    )
    val IDS = SPECS.map { it.id }

    // ------------------------------------------------------------------ lane network (LaneNetwork.js)

    private val ROAD_RANK = mapOf("highway" to 4, "avenue" to 3, "local" to 2, "path" to 1)
    private val YIELD_DELAY = doubleArrayOf(0.0, 0.35, 1.5, 2.2)
    private val SPAWN_W = mapOf(1 to 0.30, 2 to 0.75, 3 to 3.6, 4 to 5.2)

    /** One network element: kind 0 = a lane, kind 1 = a Bézier connector through a junction. */
    class LElement(
        val idx: Int, val kind: Int, val poly: Poly, val speed: Double,
        var id: String = "",
        var segmentId: String? = null,
        var dir: Int = 0,
        var from: String? = null,
        var to: String? = null,
        var width: Double = 3.5,
        var rank: Int = 2,
        var node: String? = null,       // connectors: the junction node id
        var fromLane: Int = -1,
        var toLane: Int = -1,
        var turn: Int = 0,              // 0 straight, 1 right, 2 left, 3 u-turn
        var sx: Double = 0.0,
        var sz: Double = 0.0,
        var ex: Double = 0.0,
        var ez: Double = 0.0,
    ) {
        val outs = ArrayList<Int>()
        var localIdx = -1
        var yieldDelay = 0.0
        var approach: Approach? = null  // lanes: the approach this lane feeds at its end node
        var junction: NetNode? = null   // lanes: the node at the end
        var junctionRef: NetNode? = null // connectors: the node the connector crosses
        var crossing = false            // pedestrian connectors: crosses a carriageway
    }

    /** One approach arm at a junction (all lanes of one segment arriving). */
    class Approach(val key: String, val dx: Double, val dz: Double, val rank: Int) {
        val lanes = ArrayList<Int>()
        var green = true
        var amber = false
        var idx = 0
    }

    /** A junction claim: a vehicle asking to cross a controlled node. */
    class Claim(
        val id: Int, val veh: Vehicle?, var local: Int, var key: Double, val ticket: Int,
    ) {
        var state = 0
        var go = false
        var seen = 0
        var blockedExit = false
    }

    /** A junction node: approaches, connectors, signal phases and the conflict matrix. */
    class NetNode(val id: String, val x: Double, val z: Double) {
        val approaches = LinkedHashMap<String, Approach>()
        val conns = ArrayList<Int>()
        var conflict = ByteArray(0)
        var signalized = false
        var phases: List<IntArray> = emptyList()
        var phase = 0
        var timer = 0.0
        var state = 0
        var cycle = 0
        var maxRank = 1
        val claims = LinkedHashMap<Int, Claim>()
        val inLanes = ArrayList<Int>()
        var approachList: List<Approach> = emptyList()
        var greenTime = 0.0
        var needsControl = false
    }

    /** Input graph (the web's roads.api.laneGraph() shape). Speeds are km/h. */
    class GraphLane(
        val id: String, val points: List<DoubleArray>, val speed: Double,
        val segmentId: String, val dir: Int, val from: String?, val to: String?, val width: Double,
    )

    class LaneGraphIn(
        val lanes: List<GraphLane>,
        val connections: LinkedHashMap<String, List<String>>,
        val nodePos: Map<String, DoubleArray>,
        val segType: Map<String, String>,
        val pedestrian: LaneGraphIn? = null,
        // per-segment metadata for writeSegmentLoads(): road length (m) and lane count
        val segLength: Map<String, Double> = emptyMap(),
        val segLaneCount: Map<String, Int> = emptyMap(),
    )

    private class HeapItem(val node: Int, val f: Double)

    /** Binary min-heap keyed by f (LaneNetwork.js Heap). */
    private class Heap {
        val a = ArrayList<HeapItem>()
        val size: Int get() = a.size
        fun clear() = a.clear()
        fun push(node: Int, f: Double) {
            a.add(HeapItem(node, f))
            var i = a.size - 1
            while (i > 0) {
                val p = (i - 1) shr 1
                if (a[p].f <= a[i].f) break
                val t = a[p]; a[p] = a[i]; a[i] = t
                i = p
            }
        }
        fun pop(): HeapItem {
            val top = a[0]
            val last = a.removeAt(a.size - 1)
            if (a.isNotEmpty()) {
                a[0] = last
                var i = 0
                while (true) {
                    val l = 2 * i + 1; val r = l + 1
                    var m = i
                    if (l < a.size && a[l].f < a[m].f) m = l
                    if (r < a.size && a[r].f < a[m].f) m = r
                    if (m == i) break
                    val t = a[m]; a[m] = a[i]; a[i] = t
                    i = m
                }
            }
            return top
        }
    }

    private fun tangentEnd(poly: Poly): DoubleArray {
        val n = poly.n
        val dx = poly.x[n - 1].toDouble() - poly.x[n - 2].toDouble()
        val dz = poly.z[n - 1].toDouble() - poly.z[n - 2].toDouble()
        val l = hypot(dx, dz)
        val ln = if (l == 0.0) 1.0 else l
        return doubleArrayOf(dx / ln, dz / ln)
    }

    private fun tangentStart(poly: Poly): DoubleArray {
        val dx = poly.x[1].toDouble() - poly.x[0].toDouble()
        val dz = poly.z[1].toDouble() - poly.z[0].toDouble()
        val l = hypot(dx, dz)
        val ln = if (l == 0.0) 1.0 else l
        return doubleArrayOf(dx / ln, dz / ln)
    }

    /** Bézier connector between the end of one lane and the start of another (LaneNetwork.js). */
    fun bezierConnector(p0: DoubleArray, t0: DoubleArray, p1: DoubleArray, t1: DoubleArray, speed: Double): Poly {
        val dx = p1[0] - p0[0]; val dz = p1[2] - p0[2]
        val d = hypot(dx, dz)
        if (d < 0.08) return makePoly(listOf(p0, doubleArrayOf(p1[0], p1[1], p1[2])), speed)
        val h = min(d * 0.46, 16.0)
        val c0 = doubleArrayOf(p0[0] + t0[0] * h, p0[1], p0[2] + t0[1] * h)
        val c1 = doubleArrayOf(p1[0] - t1[0] * h, p1[1], p1[2] - t1[1] * h)
        val steps = max(3.0, min(14.0, ceil(d / 1.6))).toInt()
        val pts = ArrayList<DoubleArray>(steps + 1)
        for (i in 0..steps) {
            val t = i.toDouble() / steps
            val u = 1.0 - t
            val a = u * u * u; val b = 3.0 * u * u * t; val c = 3.0 * u * t * t; val e = t * t * t
            pts.add(doubleArrayOf(
                a * p0[0] + b * c0[0] + c * c1[0] + e * p1[0],
                a * p0[1] + b * c0[1] + c * c1[1] + e * p1[1],
                a * p0[2] + b * c0[2] + c * c1[2] + e * p1[2],
            ))
        }
        return makePoly(pts, speed)
    }

    /** Proper (non-degenerate, strictly interior) segment-segment intersection test. */
    private fun segInt(ax: Double, az: Double, bx: Double, bz: Double,
                       cx: Double, cz: Double, dx: Double, dz: Double): Boolean {
        val r1 = bx - ax; val r2 = bz - az; val s1 = dx - cx; val s2 = dz - cz
        val den = r1 * s2 - r2 * s1
        if (abs(den) < 1e-9) return false
        val t = ((cx - ax) * s2 - (cz - az) * s1) / den
        val u = ((cx - ax) * r2 - (cz - az) * r1) / den
        return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98
    }

    private fun polysCross(a: Poly, b: Poly): Boolean {
        for (i in 0 until a.n - 1) {
            for (j in 0 until b.n - 1) {
                if (segInt(a.x[i].toDouble(), a.z[i].toDouble(), a.x[i + 1].toDouble(), a.z[i + 1].toDouble(),
                        b.x[j].toDouble(), b.z[j].toDouble(), b.x[j + 1].toDouble(), b.z[j + 1].toDouble())) return true
            }
        }
        return false
    }

    /** The routable lane network: lanes, connectors, junctions, signals, spawn table, A*. */
    class LaneNetwork {
        /** Per-segment metadata (writeSegmentLoads inputs), copied from the last rebuild. */
        var segLength: Map<String, Double> = emptyMap()
        var segLaneCount: Map<String, Int> = emptyMap()
        val elements = ArrayList<LElement>()
        val laneElems = ArrayList<Int>()
        val pedElements = ArrayList<LElement>() // sidewalk network (kind 0 lanes + crossing connectors)
        val pedLaneElems = ArrayList<Int>()
        val nodes = LinkedHashMap<String, NetNode>()
        var spawnCum = FloatArray(0)
            private set
        var spawnTotal = 0.0
            private set
        var totalLength = 0.0
            private set
        var pedCum = FloatArray(0)
        var pedTotal = 0.0
        var ready = false
            private set
        var version = -1

        // A* working set
        private var g = FloatArray(0)
        private var from = IntArray(0)
        private var stamp = IntArray(0)
        private var epoch = 0
        private val open = Heap()

        /** Rebuild from a lane graph. Returns true when the network changed. */
        fun rebuild(graph: LaneGraphIn, versionIn: Int = 0): Boolean {
            if (versionIn == version && ready) return false
            version = versionIn
            segLength = graph.segLength
            segLaneCount = graph.segLaneCount
            elements.clear()
            laneElems.clear()
            nodes.clear()
            val byId = HashMap<String, Int>()

            for (lane in graph.lanes) {
                if (lane.points.size < 2) continue
                val speedKmh = if (lane.speed != 0.0) lane.speed else 50.0
                val speed = speedKmh * KMH
                val poly = makePoly(lane.points, speed)
                if (!(poly.len > 1.2)) continue
                val idx = elements.size
                val rank = ROAD_RANK[graph.segType[lane.segmentId]] ?: 2
                val el = LElement(
                    idx, 0, poly, speed,
                    id = lane.id, segmentId = lane.segmentId, dir = lane.dir,
                    from = lane.from, to = lane.to, width = lane.width, rank = rank,
                    sx = poly.x[0].toDouble(), sz = poly.z[0].toDouble(),
                    ex = poly.x[poly.n - 1].toDouble(), ez = poly.z[poly.n - 1].toDouble(),
                )
                elements.add(el)
                laneElems.add(idx)
                byId[lane.id] = idx
            }

            // --- connectors through junctions
            for ((laneId, outs) in graph.connections) {
                val ai = byId[laneId] ?: continue
                if (outs.isEmpty()) continue
                val A = elements[ai]
                val pa = doubleArrayOf(A.poly.x[A.poly.n - 1].toDouble(), A.poly.y[A.poly.n - 1].toDouble(), A.poly.z[A.poly.n - 1].toDouble())
                val ta = tangentEnd(A.poly)
                for (outId in outs) {
                    val bi = byId[outId] ?: continue
                    if (bi == ai) continue
                    val B = elements[bi]
                    val pb = doubleArrayOf(B.poly.x[0].toDouble(), B.poly.y[0].toDouble(), B.poly.z[0].toDouble())
                    val tb = tangentStart(B.poly)
                    val speed = min(A.speed, B.speed)
                    val poly = bezierConnector(pa, ta, pb, tb, speed)
                    val idx = elements.size
                    val dot = ta[0] * tb[0] + ta[1] * tb[1]
                    val crossv = ta[0] * tb[1] - ta[1] * tb[0]
                    // +X is the vehicle's left, so crossv < 0 means the connector bends left.
                    val turn = if (dot > 0.86) 0 else if (dot < -0.7) 3 else if (crossv < 0) 2 else 1
                    val el = LElement(
                        idx, 1, poly, speed,
                        id = "${laneId}>${outId}", node = A.to, fromLane = ai, toLane = bi,
                        turn = turn, rank = A.rank,
                        sx = pa[0], sz = pa[2], ex = pb[0], ez = pb[2],
                    )
                    el.outs.add(bi)
                    elements.add(el)
                    A.outs.add(idx)
                }
            }

            buildJunctions(graph)
            buildSpawnTable()
            buildPedestrians(graph.pedestrian)
            g = FloatArray(elements.size)
            from = IntArray(elements.size)
            stamp = IntArray(elements.size)
            epoch = 0
            ready = laneElems.isNotEmpty()
            return true
        }

        private fun buildJunctions(graph: LaneGraphIn) {
            fun ensure(id: String): NetNode {
                var n = nodes[id]
                if (n == null) {
                    val p = graph.nodePos[id]
                    n = NetNode(id, p?.get(0) ?: 0.0, p?.get(1) ?: 0.0)
                    nodes[id] = n
                }
                return n
            }
            for (el in elements) {
                if (el.kind != 0 || el.to == null) continue
                val node = ensure(el.to!!)
                node.inLanes.add(el.idx)
                var ap = node.approaches[el.segmentId]
                if (ap == null) {
                    val t = tangentEnd(el.poly)
                    ap = Approach(el.segmentId!!, t[0], t[1], el.rank)
                    ap.idx = node.approaches.size
                    node.approaches[el.segmentId!!] = ap
                }
                ap.lanes.add(el.idx)
                el.approach = ap
                el.junction = node
                node.maxRank = max(node.maxRank, el.rank)
            }
            for (el in elements) {
                if (el.kind != 1) continue
                val node = nodes[el.node] ?: continue
                el.localIdx = node.conns.size
                node.conns.add(el.idx)
                el.junctionRef = node
                // how long a driver defers to conflicting traffic before taking the gap (seconds).
                // Straight-through and major roads go first; left turns and minor roads yield, but only
                // for a bounded time, so a single left-turner can never lock a single-lane approach.
                el.yieldDelay = YIELD_DELAY[el.turn] + (4 - el.rank) * 0.55
            }
            for (node in nodes.values) {
                val aps = node.approaches.values.toList()
                node.approachList = aps
                // real cities only light up junctions on the major network; local crossings run
                // on priority (right-before-left / straight-before-turning), which keeps a grid flowing.
                node.signalized = node.maxRank >= 3 && aps.size >= 3
                // phase groups: opposite approaches share a green
                val used = BooleanArray(aps.size)
                val phases = ArrayList<IntArray>()
                for (i in aps.indices) {
                    if (used[i]) continue
                    val group = ArrayList<Int>()
                    group.add(i); used[i] = true
                    var best = -1
                    var bestDot = -0.55
                    for (j in i + 1 until aps.size) {
                        if (used[j]) continue
                        val d = aps[i].dx * aps[j].dx + aps[i].dz * aps[j].dz
                        if (d < bestDot) { bestDot = d; best = j }
                    }
                    if (best >= 0) { group.add(best); used[best] = true }
                    phases.add(group.toIntArray())
                }
                node.phases = phases
                if (node.signalized) {
                    node.greenTime = 7.5 + 1.1 * aps.size
                    node.cycle = 0
                    // deterministic desync so a grid does not blink in unison (FNV-1a over node.id)
                    var h = 2166136261.toInt()
                    for (ch in node.id) { h = h xor ch.code; h *= 16777619 }
                    node.timer = ((h.toLong() and 0xFFFFFFFFL) % 1000).toDouble() / 1000.0 * (node.greenTime + 4.4)
                    node.phase = (h ushr 10) % max(1, node.phases.size)
                }
                // conflict matrix between the connectors of this junction
                val k = node.conns.size
                node.conflict = ByteArray(k * k)
                for (a in 0 until k) {
                    val A = elements[node.conns[a]]
                    for (b in a + 1 until k) {
                        val B = elements[node.conns[b]]
                        var c = 0
                        if (A.fromLane != B.fromLane) {
                            c = if (A.toLane == B.toLane) 1 else if (polysCross(A.poly, B.poly)) 1 else 0
                        }
                        node.conflict[a * k + b] = c.toByte()
                        node.conflict[b * k + a] = c.toByte()
                    }
                }
                node.needsControl = false
                var i = 0
                while (i < k * k && !node.needsControl) {
                    if (node.conflict[i].toInt() != 0) node.needsControl = true
                    i++
                }
            }
        }

        private fun buildSpawnTable() {
            var total = 0.0
            var len = 0.0
            val cum = FloatArray(laneElems.size)
            // Weight by road rank. Arterials are weighted hard: in Cities: Skylines II the avenues carry a
            // continuous stream while the back streets are nearly empty, and matching that ratio is what
            // makes a hero frame looking down an avenue read as a busy city rather than a thin trickle.
            for (i in laneElems.indices) {
                val el = elements[laneElems[i]]
                total += el.poly.len * (SPAWN_W[el.rank] ?: 1.0)
                len += el.poly.len
                cum[i] = total.toFloat()
            }
            spawnCum = cum
            spawnTotal = total
            totalLength = len
        }

        /** Pick a lane element index weighted by length (r in [0,1)). */
        fun randomLane(r: Double): Int {
            val cum = spawnCum
            if (cum.isEmpty()) return -1
            val target = r * spawnTotal
            var lo = 0
            var hi = cum.size - 1
            while (lo < hi) {
                val mid = (lo + hi) shr 1
                if (cum[mid].toDouble() < target) lo = mid + 1 else hi = mid
            }
            return laneElems[lo]
        }

        /** Sidewalk network (LaneNetwork.js _buildPedestrians) — 1.45 m/s walk speed. */
        private fun buildPedestrians(ped: LaneGraphIn?) {
            pedElements.clear()
            pedLaneElems.clear()
            if (ped == null) { pedCum = FloatArray(0); pedTotal = 0.0; return }
            val byId = HashMap<String, Int>()
            for (lane in ped.lanes) {
                if (lane.points.size < 2) continue
                val poly = makePoly(lane.points, 1.45)
                if (!(poly.len > 1.0)) continue
                val idx = pedElements.size
                val el = LElement(idx, 0, poly, 1.45, id = lane.id, to = lane.to, from = lane.from)
                pedElements.add(el)
                pedLaneElems.add(idx)
                byId[lane.id] = idx
            }
            for ((laneId, outs) in ped.connections) {
                val ai = byId[laneId] ?: continue
                if (outs.isEmpty()) continue
                val A = pedElements[ai]
                val pa = doubleArrayOf(A.poly.x[A.poly.n - 1].toDouble(), A.poly.y[A.poly.n - 1].toDouble(), A.poly.z[A.poly.n - 1].toDouble())
                val ta = tangentEnd(A.poly)
                for (outId in outs) {
                    val bi = byId[outId] ?: continue
                    if (bi == ai) continue
                    val B = pedElements[bi]
                    val pb = doubleArrayOf(B.poly.x[0].toDouble(), B.poly.y[0].toDouble(), B.poly.z[0].toDouble())
                    val gap = hypot(pb[0] - pa[0], pb[2] - pa[2])
                    if (gap > 34.0) continue
                    val poly = bezierConnector(pa, ta, pb, tangentStart(B.poly), 1.45)
                    val idx = pedElements.size
                    val el = LElement(idx, 1, poly, 1.45, id = "${laneId}>${outId}", to = B.to, from = A.to)
                    el.crossing = gap > 5.5
                    el.outs.add(bi)
                    el.node = A.to
                    pedElements.add(el)
                    A.outs.add(idx)
                }
            }
            var total = 0.0
            val cum = FloatArray(pedLaneElems.size)
            for (i in pedLaneElems.indices) {
                total += pedElements[pedLaneElems[i]].poly.len
                cum[i] = total.toFloat()
            }
            pedCum = cum
            pedTotal = total
        }

        fun randomPedLane(r: Double): Int {
            val cum = pedCum
            if (cum.isEmpty()) return -1
            val target = r * pedTotal
            var lo = 0
            var hi = cum.size - 1
            while (lo < hi) {
                val mid = (lo + hi) shr 1
                if (cum[mid].toDouble() < target) lo = mid + 1 else hi = mid
            }
            return pedLaneElems[lo]
        }

        /**
         * A* from lane element [startIdx] to lane element [goalIdx].
         * Returns the element index path (lanes and connectors), or null.
         */
        fun route(startIdx: Int, goalIdx: Int, maxExpand: Int = 900): IntArray? {
            if (startIdx == goalIdx) return intArrayOf(startIdx)
            val els = elements
            val gArr = g
            val fromArr = from
            val stampArr = stamp
            epoch++
            val ep = epoch
            open.clear()
            val goal = els[goalIdx]
            val inv = 1.0 / 22.0
            fun h(el: LElement): Double = hypot(el.ex - goal.sx, el.ez - goal.sz) * inv
            gArr[startIdx] = 0f
            fromArr[startIdx] = -1
            stampArr[startIdx] = ep
            open.push(startIdx, h(els[startIdx]))
            var expanded = 0
            while (open.size > 0) {
                val top = open.pop()
                val cur = top.node
                if (cur == goalIdx) break
                if (++expanded > maxExpand) return null
                val curG = gArr[cur].toDouble()
                if (top.f - h(els[cur]) > curG + 1e-3) continue
                for (nx in els[cur].outs) {
                    val el = els[nx]
                    val cost = el.poly.len / max(3.0, el.speed) + (if (el.kind == 1) 1.2 + el.turn * 0.9 else 0.0)
                    val ng = curG + cost
                    if (stampArr[nx] == ep && gArr[nx].toDouble() <= ng) continue
                    stampArr[nx] = ep
                    gArr[nx] = ng.toFloat()
                    fromArr[nx] = cur
                    open.push(nx, ng + h(el))
                }
            }
            if (stampArr[goalIdx] != ep) return null
            val path = ArrayList<Int>()
            var n = goalIdx
            while (n >= 0 && path.size < 400) { path.add(n); n = fromArr[n] }
            path.reverse()
            return path.toIntArray()
        }

        /** Advance every signal cycle. */
        fun updateSignals(dt: Double) {
            for (node in nodes.values) {
                if (!node.signalized || node.phases.isEmpty()) continue
                node.timer += dt
                val green = node.greenTime
                val amber = 2.6
                val allRed = 1.1
                val total = green + amber + allRed
                if (node.timer >= total) {
                    node.timer -= total
                    node.phase = (node.phase + 1) % node.phases.size
                }
                node.state = if (node.timer < green) 0 else if (node.timer < green + amber) 1 else 2
                val active = node.phases[node.phase]
                for (i in node.approachList.indices) {
                    var on = false
                    for (v in active) if (v == i) { on = true; break }
                    node.approachList[i].green = on && node.state == 0
                    node.approachList[i].amber = on && node.state == 1
                }
            }
        }
    }

    /** Convenience: a single closed-loop lane with no junctions (the pre-junction demo net). */
    fun loopNet(pts: List<DoubleArray>, speedKmh: Double = 50.0): LaneNetwork {
        val graph = LaneGraphIn(
            lanes = listOf(GraphLane("lane0", pts, speedKmh, "seg0", 1, null, null, 3.5)),
            connections = linkedMapOf(),
            nodePos = emptyMap(),
            segType = mapOf("seg0" to "local"),
        )
        val net = LaneNetwork()
        net.rebuild(graph)
        // the pre-junction demo net was a closed loop: the single lane's one out is itself
        if (net.elements.isNotEmpty()) net.elements[0].outs.add(0)
        return net
    }

    // ------------------------------------------------------------------ the simulation

    class Vehicle {
        var id = 0
        var typeId = "sedan"
        var spec: VehSpec = SPECS[0]
        var elem = 0
        var s = 0.0
        var v = 0.0
        var route = IntArray(1)
        var ri = 0
        var half = 0.0
        var x = 0.0; var y = 0.0; var z = 0.0; var yaw = 0.0; var pitch = 0.0
        var brake = 0.0; var wait = 0.0; var vf = 0.0
        var paint = 0; var box = 0
        var stopDist = Double.POSITIVE_INFINITY
        var bidx = -1
        var dead = false
        var seed = 0.0
        var blink = 0.0; var blinkSide = 0
        var sl = 1.0; var sw = 1.0; var sh = 1.0
        var spin = 0.0; var steer = 0.0; var yawRate = 0.0
        var speedRatio = 1.0
        var dist = 0.0
        var speed = 0.0; var vx = 0.0; var vz = 0.0
        var segmentId: String? = null
    }

    private fun cmpS(a: Vehicle, b: Vehicle): Int = if (a.s < b.s) -1 else if (a.s > b.s) 1 else 0
    private fun cmpPed(a: Ped, b: Ped): Int = if (a.s < b.s) -1 else if (a.s > b.s) 1 else 0

    class Ped {
        var id = 0
        var elem = 0
        var s = 0.0
        var v = 0.0
        var vmax = 1.0
        var phase = 0.0
        var x = 0.0; var y = 0.0; var z = 0.0; var yaw = 0.0
        var shirt = 0; var pants = 0
        var seed = 0.0
        var bidx = -1
        var dist = 0.0
        var nextElem: Int? = null
    }

    class TrafficSim(private val net: LaneNetwork, seed: Int, salt: Int) {
        private val rng = Rng(seed).fork(salt)
        val vehicles = ArrayList<Vehicle>()
        val peds = ArrayList<Ped>()
        var target = 0
        var pedTarget = 0
        var frame = 0
            private set
        var ticket = 1
            private set
        var time = 0.0
            private set
        var nextId = 1
            private set
        var camX = 0.0; var camZ = 0.0
        var congestion = 0.0
        var avgSpeedRatio = 1.0
        /** Per-segment traffic load 0..1 (the web's seg.traffic), for the HUD / road tinting. */
        val segLoad = HashMap<String, Double>()

        /** Per-segment load 0..1 + a global congestion figure (TrafficSim.writeSegmentLoads,
         *  called once per sim tick). */
        fun writeSegmentLoads() {
            val segs = net.segLength
            if (segs.isEmpty()) { congestion = 0.0; return }
            val load = HashMap<String, DoubleArray>()
            var ratioSum = 0.0; var ratioN = 0
            for (v in vehicles) {
                val sid = v.segmentId ?: continue
                var rec = load[sid]
                if (rec == null) { rec = doubleArrayOf(0.0, 0.0); load[sid] = rec }
                rec[0]++
                rec[1] += 1.0 - v.speedRatio
                ratioSum += v.speedRatio; ratioN++
            }
            var weighted = 0.0; var total = 0.0
            for ((id, len) in segs) {
                val rec = load[id]
                val lanes = max(1, net.segLaneCount[id] ?: 2)
                val cap = max(1.0, (len / 22.0) * lanes)
                var t = 0.0
                if (rec != null) {
                    // a grid with lights is never at free flow, so only the slow-down *beyond*
                    // the normal stop-and-go of an urban street counts as congestion
                    val density = min(1.4, rec[0] / cap)
                    val slow = if (rec[0] > 0.0) rec[1] / rec[0] else 0.0
                    t = min(1.0, 0.45 * density + 1.10 * max(0.0, slow - 0.52))
                }
                segLoad[id] = t
                weighted += t * len; total += len
            }
            avgSpeedRatio = if (ratioN > 0) ratioSum / ratioN else 1.0
            congestion = if (total > 0) min(1.0, weighted / total) else 0.0
        }
        private var astar = 16
        private var bucket = Array<ArrayList<Vehicle>>(0) { ArrayList() }
        private var bstamp = IntArray(0)
        private val touched = ArrayList<Int>()
        private var pbucket = Array<ArrayList<Ped>>(0) { ArrayList() }
        private var pstamp = IntArray(0)
        private val ptouched = ArrayList<Int>()
        private val sample = PolySample(0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 10.0)

        /** The web forks world.rng with hashString('traffic'). */
        companion object {
            fun trafficRng(worldSeed: Int): Rng = Rng(worldSeed).fork(simHashString("traffic"))
        }

        fun onNetwork() {
            vehicles.clear()
            peds.clear()
            val n = net.elements.size
            bucket = Array(n) { ArrayList() }
            bstamp = IntArray(n)
            touched.clear()
            val p = net.pedElements.size
            pbucket = Array(p) { ArrayList() }
            pstamp = IntArray(p)
            ptouched.clear()
            for (node in net.nodes.values) node.claims.clear()
        }

        private fun pickType(): VehSpec {
            var sum = 0.0
            for (s in SPECS) sum += s.weight
            val r = rng.next() * sum
            var cum = 0.0
            for (s in SPECS) { cum += s.weight; if (r <= cum) return s }
            return SPECS[0]
        }

        private fun clear(elemIdx: Int, s: Double, half: Double): Boolean {
            for (v in vehicles) {
                if (v.elem != elemIdx) continue
                if (abs(v.s - s) < half + v.half + 3.5) return false
            }
            return true
        }

        fun spawn(count: Int, hintLane: Int = -1): Int {
            if (!net.ready) return 0
            var made = 0
            for (i in 0 until count) {
                var placed = false
                var tries = 0
                while (tries < 6 && !placed) {
                    tries++
                    var li = -1
                    if (hintLane >= 0 && rng.next() < 0.55) li = hintLane
                    if (li < 0) li = net.randomLane(rng.next())
                    if (li < 0) return made
                    val el = net.elements.getOrNull(li)
                    if (el == null || el.kind != 0) continue
                    val spec = pickType()
                    if ((spec.id == "bus" || spec.id == "truck") && el.rank < 2) continue
                    if (el.poly.len < spec.len * 2.2) continue
                    val s = 1.0 + rng.next() * (el.poly.len - spec.len - 2.0)
                    if (!clear(li, s, spec.len * 0.5)) continue
                    val v = makeVehicle(spec.id, spec, li, s)
                    vehicles.add(v)
                    made++
                    placed = true
                }
            }
            return made
        }

        /** Sidewalk agents (web spawnPeds). */
        fun spawnPeds(count: Int): Int {
            if (net.pedLaneElems.isEmpty()) return 0
            var made = 0
            for (i in 0 until count) {
                val li = net.randomPedLane(rng.next())
                if (li < 0) break
                val el = net.pedElements.getOrNull(li)
                if (el == null || el.poly.len < 3.0) continue
                val ped = Ped()
                ped.id = nextId++
                ped.elem = li
                ped.s = rng.next() * el.poly.len
                ped.v = 1.0 + rng.next() * 0.45
                ped.vmax = 1.05 + rng.next() * 0.55
                ped.phase = rng.next() * 6.283
                ped.shirt = (rng.next() * 1e6).toInt()
                ped.pants = (rng.next() * 1e6).toInt()
                ped.seed = rng.next()
                peds.add(ped)
                made++
            }
            return made
        }

        private fun makeVehicle(id: String, spec: VehSpec, elemIdx: Int, s: Double): Vehicle {
            val veh = Vehicle()
            veh.id = nextId++
            veh.typeId = id
            veh.spec = spec
            veh.elem = elemIdx
            veh.s = s
            veh.v = net.elements[elemIdx].speed * 0.55
            veh.route = intArrayOf(elemIdx)
            veh.ri = 0
            veh.half = spec.len * 0.5
            veh.vf = 0.86 + rng.next() * 0.24
            veh.paint = (rng.next() * 1e6).toInt()
            veh.box = (rng.next() * 1e6).toInt()
            veh.seed = rng.next()
            veh.sl = 1.0 + (rng.next() - 0.5) * 0.055
            veh.sw = 1.0 + (rng.next() - 0.5) * 0.040
            veh.sh = 1.0 + (rng.next() - 0.5) * 0.045
            veh.half = spec.len * 0.5 * veh.sl
            extendRoute(veh)
            return veh
        }

        private fun extendRoute(veh: Vehicle): Boolean {
            val last = veh.route[veh.route.size - 1]
            val lastEl = net.elements.getOrNull(last) ?: return false
            if (lastEl.outs.isEmpty()) return false
            if (astar > 0) {
                astar--
                for (t in 0 until 3) {
                    val goal = net.randomLane(rng.next())
                    if (goal < 0 || goal == last) continue
                    val path = net.route(last, goal)
                    if (path != null && path.size > 1) {
                        for (i in 1 until path.size) veh.route = veh.route + intArrayOf(path[i])
                        return true
                    }
                }
            }
            // fallback: random legal step
            val c = lastEl.outs[(rng.next() * lastEl.outs.size).toInt()]
            veh.route = veh.route + intArrayOf(c)
            val conn = net.elements.getOrNull(c)
            if (conn != null && conn.outs.isNotEmpty()) veh.route = veh.route + intArrayOf(conn.outs[0])
            return true
        }

        /** Remove up to n vehicles, farthest-from-camera first (web despawnFar). */
        fun despawnFar(n: Int): Int {
            var removed = 0
            var i = vehicles.size - 1
            while (i >= 0 && removed < n) {
                val v = vehicles[i]
                val d = hypot(v.x - camX, v.z - camZ)
                if (d > 170.0) { release(v); vehicles.removeAt(i); removed++ }
                i--
            }
            i = vehicles.size - 1
            while (i >= 0 && removed < n) {
                release(vehicles[i]); vehicles.removeAt(i); removed++
                i--
            }
            return removed
        }

        private fun release(veh: Vehicle) {
            val el = net.elements.getOrNull(veh.elem)
            if (el != null && el.kind == 1 && el.junctionRef != null) el.junctionRef!!.claims.remove(veh.id)
            if (veh.ri + 1 < veh.route.size) {
                val nx = net.elements.getOrNull(veh.route[veh.ri + 1])
                if (nx != null && nx.kind == 1 && nx.junctionRef != null) nx.junctionRef!!.claims.remove(veh.id)
            }
        }

        fun update(dt: Double, camX: Double = 0.0, camZ: Double = 0.0) {
            if (!net.ready || dt <= 0) return
            this.camX = camX; this.camZ = camZ
            frame++
            time += dt
            astar = 16
            net.updateSignals(dt)
            buildBuckets()
            for (v in vehicles) intent(v)
            resolveClaims()
            for (v in vehicles) stepVehicle(v, dt)
            for (p in peds) stepPed(p, dt)
            for (i in vehicles.size - 1 downTo 0) {
                if (vehicles[i].dead) { release(vehicles[i]); vehicles.removeAt(i) }
            }
        }

        private fun buildBuckets() {
            val f = frame
            for (e in touched) bucket[e].clear()
            touched.clear()
            for (v in vehicles) {
                val e = v.elem
                if (bstamp[e] != f) { bstamp[e] = f; bucket[e].clear(); touched.add(e) }
                bucket[e].add(v)
            }
            for (e in touched) {
                val b = bucket[e]
                b.sortWith { a, c -> cmpS(a, c) }
                for (i in b.indices) b[i].bidx = i
            }
            // pedestrian buckets (same method in the web)
            for (e in ptouched) pbucket[e].clear()
            ptouched.clear()
            for (p in peds) {
                val e = p.elem
                if (pstamp[e] != f) { pstamp[e] = f; pbucket[e].clear(); ptouched.add(e) }
                pbucket[e].add(p)
            }
            for (e in ptouched) {
                val b = pbucket[e]
                b.sortWith { a, c -> cmpPed(a, c) }
                for (i in b.indices) b[i].bidx = i
            }
        }

        /** Register (or drop) a junction claim and record a red-light stop distance (web _intent). */
        private fun intent(veh: Vehicle) {
            val els = net.elements
            veh.stopDist = Double.POSITIVE_INFINITY
            val el = els.getOrNull(veh.elem)
            if (el == null) { veh.dead = true; return }
            if (el.kind == 1) {
                val node = el.junctionRef
                if (node != null) {
                    val c = node.claims[veh.id]
                    if (c != null) { c.state = 1; c.seen = frame }
                }
                return
            }
            if (veh.ri + 1 >= veh.route.size) return
            val next = els.getOrNull(veh.route[veh.ri + 1])
            if (next == null || next.kind != 1) return
            val node = next.junctionRef ?: return
            val remain = el.poly.len - veh.s
            if (remain > CLAIM_DIST) return

            val ap = el.approach
            if (node.signalized && ap != null && !ap.green) {
                val stopNeed = (veh.v * veh.v) / (2.0 * 4.2) + 1.0
                val mustRun = ap.amber && remain < stopNeed
                if (!mustRun) {
                    node.claims.remove(veh.id)
                    veh.stopDist = max(0.0, remain - 0.7)
                    return
                }
            }
            if (!node.needsControl) return
            var c = node.claims[veh.id]
            if (c == null) {
                c = Claim(veh.id, veh, next.localIdx, time + next.yieldDelay, ticket)
                ticket++
                node.claims[veh.id] = c
            } else {
                c.local = next.localIdx; c.state = 0
            }
            c.seen = frame
            // don't block the box: refuse to enter when the exit lane has no room
            if (next.outs.isNotEmpty()) {
                val exit = els.getOrNull(next.outs[0])
                if (exit != null) {
                    val b = bucket[exit.idx]
                    if (bstamp[exit.idx] == frame && b.isNotEmpty()) {
                        val first = b[0]
                        c.blockedExit = first.s < veh.spec.len + first.half + 2.5 && first.v < 1.6
                    } else c.blockedExit = false
                }
            }
        }

        /** FCFS claim resolution per node, gated by the connector conflict matrix (web _resolveClaims). */
        private fun resolveClaims() {
            val f = frame
            for (node in net.nodes.values) {
                val claims = node.claims
                if (claims.isEmpty()) continue
                val it = claims.entries.iterator()
                while (it.hasNext()) { if (it.next().value.seen != f) it.remove() }
                if (claims.isEmpty()) continue
                val list = ArrayList<Claim>(claims.values)
                list.sortWith { a, b ->
                    val ai = if (a.state == 1) 0 else 1
                    val bi = if (b.state == 1) 0 else 1
                    if (ai != bi) ai - bi
                    else if (a.key != b.key) (if (a.key < b.key) -1 else 1)
                    else a.ticket - b.ticket
                }
                val k = node.conns.size
                val taken = ArrayList<Int>()
                for (c in list) {
                    val stale = time - c.key > 7.0 // nobody waits for ever
                    var ok = c.state == 1 || !c.blockedExit
                    if (ok && !stale) {
                        for (j in taken.indices) {
                            if (node.conflict[taken[j] * k + c.local].toInt() != 0) { ok = false; break }
                        }
                    }
                    c.go = ok
                    // a claim that is only waiting for room beyond the junction must not hold up cross traffic
                    if (ok || !c.blockedExit) taken.add(c.local)
                }
            }
        }

        private fun leader(veh: Vehicle): DoubleArray? {
            val els = net.elements
            val b = bucket[veh.elem]
            if (bstamp[veh.elem] == frame && veh.bidx >= 0) {
                val nb = b.getOrNull(veh.bidx + 1)
                if (nb != null) return doubleArrayOf(nb.s - nb.half - (veh.s + veh.half), nb.v)
            }
            val el0 = els.getOrNull(veh.elem) ?: return null
            var ahead = el0.poly.len - veh.s
            for (k in 1..4) {
                if (veh.ri + k >= veh.route.size) break
                val ei = veh.route[veh.ri + k]
                if (bstamp[ei] == frame) {
                    val bb = bucket[ei]
                    if (bb.isNotEmpty()) {
                        val nb = bb[0]
                        return doubleArrayOf(ahead + nb.s - nb.half - veh.half, nb.v)
                    }
                }
                val e2 = els.getOrNull(ei) ?: break
                ahead += e2.poly.len
                if (ahead > LOOKAHEAD) break
            }
            return null
        }

        /** Walk the sidewalk lanes; wait at the kerb until the crossing is clear (web _stepPed). */
        private fun stepPed(ped: Ped, dt: Double) {
            val els = net.pedElements
            val el0 = els.getOrNull(ped.elem)
            if (el0 == null) { ped.elem = net.randomPedLane(rng.next()); ped.s = 0.0; ped.nextElem = null; return }
            var el: LElement = el0
            var target = ped.vmax
            // personal space
            val b = pbucket[ped.elem]
            if (pstamp[ped.elem] == frame && ped.bidx >= 0) {
                val nb = b.getOrNull(ped.bidx + 1)
                if (nb != null) {
                    val gap = nb.s - ped.s
                    if (gap < 1.5) target = min(target, max(0.0, nb.v * 0.85 + (gap - 0.7) * 0.9))
                }
            }
            // wait at the kerb
            val remain = el.poly.len - ped.s
            if (el.kind == 0 && remain < 1.4) {
                if (ped.nextElem == null) ped.nextElem = pickPedNext(el)
                val nx = ped.nextElem?.let { els.getOrNull(it) }
                if (nx != null && nx.crossing && !crossingClear(nx)) target = 0.0
            }
            ped.v += (target - ped.v) * min(1.0, dt * 3.5)
            if (ped.v < 0.02) ped.v = 0.0
            ped.s += ped.v * dt
            ped.phase += ped.v * dt * 4.6
            ped.dist += ped.v * dt
            var guard = 0
            while (ped.s > el.poly.len && guard++ < 4) {
                ped.s -= el.poly.len
                var nxt = ped.nextElem
                ped.nextElem = null
                if (nxt == null) nxt = pickPedNext(el)
                val nxE = nxt?.let { els.getOrNull(it) }
                if (nxE == null) { ped.elem = net.randomPedLane(rng.next()); ped.s = 0.0; ped.nextElem = null; return }
                ped.elem = nxt!!
                el = nxE
            }
            val q = polyAt(el.poly, ped.s, sample)
            ped.x = q.x; ped.y = q.y; ped.z = q.z
            ped.yaw = atan2(q.tx, q.tz)
        }

        /** Avoid immediately turning back the way we came (web _pickPedNext). */
        private fun pickPedNext(el: LElement): Int? {
            if (el.kind == 1) return if (el.outs.isNotEmpty()) el.outs[0] else null
            if (el.outs.isEmpty()) return null
            val els = net.pedElements
            var pick: Int? = null
            var tries = 0
            while (tries++ < 4) {
                val c = el.outs[(rng.next() * el.outs.size).toInt()]
                val conn = els.getOrNull(c) ?: continue
                val back = conn.outs.isNotEmpty() && els.getOrNull(conn.outs[0])?.to == el.from
                if (!back || rng.next() < 0.2) { pick = c; break }
                pick = c
            }
            return pick
        }

        /** A crossing is clear when no vehicle is entering the junction below 26 m out (web _crossingClear). */
        private fun crossingClear(conn: LElement): Boolean {
            val node = conn.node?.let { net.nodes[it] } ?: return true
            val els = net.elements
            for (li in node.inLanes) {
                val b = bucket[li]
                if (bstamp[li] != frame || b.isEmpty()) continue
                val el = els.getOrNull(li) ?: continue
                for (i in b.indices.reversed()) {
                    val v = b[i]
                    val d = el.poly.len - v.s
                    if (d > 26.0) break
                    if (v.v > 1.2) return false
                }
            }
            for (c in node.claims.values) if (c.state == 1) return false
            return true
        }

        private fun stepVehicle(veh: Vehicle, dt: Double) {
            val els = net.elements
            val elStart = els.getOrNull(veh.elem)
            if (elStart == null) { veh.dead = true; return }
            var el: LElement = elStart
            var p = polyAt(el.poly, veh.s, sample)
            // target speed: lane limit x driver, curvature, and the entry speed of what comes next
            var v0 = min(el.speed * veh.vf * veh.spec.vmax, p.v)
            val remain0 = el.poly.len - veh.s
            if (veh.ri + 1 < veh.route.size && remain0 < 40.0) {
                val nx = els.getOrNull(veh.route[veh.ri + 1])
                if (nx != null) {
                    val entry = min(nx.speed * veh.vf * veh.spec.vmax, nx.poly.vmax[0].toDouble())
                    v0 = min(v0, sqrt(entry * entry + 2.0 * 2.0 * max(0.0, remain0 - 1.0)))
                }
            }
            var a = idmAccel(veh.v, v0, 1e9, 0.0, A_MAX)
            val lead = leader(veh)
            if (lead != null) a = min(a, idmAccel(veh.v, v0, lead[0], veh.v - lead[1], A_MAX))

            // junction stop (red light, or not our turn)
            var stop = veh.stopDist
            if (el.kind == 0 && veh.ri + 1 < veh.route.size) {
                val nx = els.getOrNull(veh.route[veh.ri + 1])
                if (nx != null && nx.kind == 1 && nx.junctionRef != null && nx.junctionRef!!.needsControl) {
                    val c = nx.junctionRef!!.claims[veh.id]
                    if (c != null && !c.go) stop = min(stop, max(0.0, remain0 - 0.7))
                }
            }
            if (stop < 1e8) a = min(a, idmAccel(veh.v, v0, stop, veh.v, A_MAX))

            val aClamped = max(DEC_MAX, min(A_MAX, a))
            veh.v = max(0.0, veh.v + aClamped * dt)
            if (stop < 0.35 && veh.v < 0.6) veh.v = 0.0
            // brake lamps: braking, plus held on while stopped at a light or in a queue
            val brakeT0 = min(1.0, max(0.0, -aClamped / 2.6))
            var brakeT = brakeT0
            if (veh.v < 0.6 && (stop < 1e8 || (lead != null && lead[0] < 9.0))) brakeT = max(brakeT, 0.9)
            veh.brake = veh.brake + (brakeT - veh.brake) * min(1.0, dt * 9.0)
            veh.wait = if (veh.v < 0.4) veh.wait + dt else 0.0
            veh.s += veh.v * dt
            veh.dist += veh.v * dt

            // element transitions
            var guard = 0
            while (veh.s > el.poly.len && guard++ < 6) {
                veh.s -= el.poly.len
                val wasConn = el.kind == 1
                val prevNode = if (wasConn) el.junctionRef else null
                veh.ri++
                if (veh.ri >= veh.route.size) {
                    if (!extendRoute(veh) || veh.ri >= veh.route.size) { veh.dead = true; return }
                }
                veh.elem = veh.route[veh.ri]
                el = els[veh.elem]
                if (el == null) { veh.dead = true; return }
                if (prevNode != null) prevNode.claims.remove(veh.id)
                if (veh.route.size - veh.ri < 3) extendRoute(veh)
                if (veh.ri > 40) { veh.route = veh.route.copyOfRange(veh.ri, veh.route.size); veh.ri = 0 }
            }
            if (veh.route.size - veh.ri < 3) extendRoute(veh)

            val q = polyAt(el.poly, veh.s, sample)
            veh.x = q.x; veh.y = q.y; veh.z = q.z
            val yaw = atan2(q.tx, q.tz)
            var d = yaw - veh.yaw
            while (d > PI) d -= PI * 2.0
            while (d < -PI) d += PI * 2.0
            veh.yawRate = if (dt > 0) d / dt else 0.0
            veh.yaw = yaw
            veh.pitch = -asin(max(-0.5, min(0.5, q.ty)))
            veh.spin += (veh.v / veh.spec.wheelR) * dt
            val targetSteer = max(-0.55, min(0.55, veh.yawRate * 0.85))
            veh.steer += (targetSteer - veh.steer) * min(1.0, dt * 8.0)
            // turn indicators: on from ~26 m before a turn until the connector is finished
            var side = 0
            if (el.kind == 1) side = if (el.turn == 2) 1 else if (el.turn == 1) -1 else 0
            else if (veh.ri + 1 < veh.route.size) {
                val nx2 = els.getOrNull(veh.route[veh.ri + 1])
                if (nx2 != null && nx2.kind == 1 && el.poly.len - veh.s < 26.0) {
                    side = if (nx2.turn == 2) 1 else if (nx2.turn == 1) -1 else 0
                }
            }
            veh.blinkSide = side
            veh.blink = if (side == 0) 0.0 else side * ((if (((time + veh.seed) % 0.94) < 0.52) 1.0 else 0.0))
            veh.speedRatio = if (el.speed > 0.1) min(1.0, veh.v / el.speed) else 1.0
            veh.segmentId = if (el.kind == 0) el.segmentId else null
            // published for the audio module (m/s + planar velocity)
            veh.speed = veh.v
            veh.vx = sin(yaw) * veh.v
            veh.vz = cos(yaw) * veh.v
        }
    }
}
