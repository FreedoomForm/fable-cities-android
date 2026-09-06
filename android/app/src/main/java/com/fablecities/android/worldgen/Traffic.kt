package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.asin
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
 *    route extension, spatial buckets, the IDM car-following leader search (same lane + up to 4
 *    route elements ahead, 85 m lookahead), the per-vehicle integration (free-flow + gap term,
 *    curve entry speed, brake lamps, wheel spin, steering, indicators) and element transitions.
 *
 * Junction claims/signals and the pedestrian network are NOT in this slice (the native demo
 * network has no junctions yet — nodes are empty, so the web code takes the same no-control
 * paths). Bit-parity is pinned by TrafficParityTest against tools/probe_traffic.mjs, which runs
 * the REAL web TrafficSim on the same minimal net.
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

    // ------------------------------------------------------------------ lane network (minimal)

    /** One lane element: kind 0 = lane, kind 1 = connector (not used by the demo net yet). */
    class LaneEl(val idx: Int, val kind: Int, val poly: Poly, val speed: Double, val rank: Int, val outs: IntArray)

    /** Minimal routable net: the demo loops have one element per route with no junctions.
     *  randomLane consumes one rng draw (the web calls it as net.randomLane(this.rng()) — the
     *  argument is evaluated — and a real weighted pick would use it; the single-lane fake
     *  discards the value but the draw MUST happen for stream parity). */
    class MiniNet(val elements: List<LaneEl>) {
        val ready = true
        fun randomLane(rng: Rng): Int { rng.next(); return 0 }
        fun route(last: Int, goal: Int): IntArray? = null
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
    }

    private fun cmpS(a: Vehicle, b: Vehicle): Int = if (a.s < b.s) -1 else if (a.s > b.s) 1 else 0

    class TrafficSim(private val net: MiniNet, seed: Int, salt: Int) {
        private val rng = Rng(seed).fork(salt)
        val vehicles = ArrayList<Vehicle>()
        var frame = 0
            private set
        private var nextId = 1
        private var astar = 16
        private val bucket = HashMap<Int, ArrayList<Vehicle>>()
        private var time = 0.0
        private val sample = PolySample(0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 10.0)

        /** The web forks world.rng with hashString('traffic'). */
        companion object {
            fun trafficRng(worldSeed: Int): Rng = Rng(worldSeed).fork(simHashString("traffic"))
        }

        fun onNetwork() {
            vehicles.clear()
            bucket.clear()
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
            var made = 0
            for (i in 0 until count) {
                var placed = false
                var tries = 0
                while (tries < 6 && !placed) {
                    tries++
                    var li = -1
                    if (hintLane >= 0 && rng.next() < 0.55) li = hintLane
                    if (li < 0) li = net.randomLane(rng)
                    if (li < 0) return made
                    val el = net.elements[li]
                    if (el.kind != 0) continue
                    val id = pickType()
                    val spec = id
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
                    val goal = net.randomLane(rng)
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

        fun update(dt: Double) {
            if (dt <= 0) return
            frame++
            time += dt
            astar = 16
            buildBuckets()
            for (v in vehicles) intent(v)
            for (v in vehicles) stepVehicle(v, dt)
            for (i in vehicles.size - 1 downTo 0) if (vehicles[i].dead) vehicles.removeAt(i)
        }

        private fun buildBuckets() {
            bucket.clear()
            for (v in vehicles) {
                var b = bucket[v.elem]
                if (b == null) { b = ArrayList(); bucket[v.elem] = b }
                b.add(v)
            }
            for (b in bucket.values) {
                b.sortWith { a, c -> cmpS(a, c) }
                for (i in b.indices) b[i].bidx = i
            }
        }

        private fun intent(veh: Vehicle) {
            veh.stopDist = Double.POSITIVE_INFINITY
            val el = net.elements.getOrNull(veh.elem)
            if (el == null) { veh.dead = true; return }
            // no junctions in the demo net: nothing to claim or stop for
        }

        private fun leader(veh: Vehicle): DoubleArray? {
            val b = bucket[veh.elem]
            if (b != null && veh.bidx >= 0 && veh.bidx + 1 < b.size) {
                val nb = b[veh.bidx + 1]
                return doubleArrayOf(nb.s - nb.half - (veh.s + veh.half), nb.v)
            }
            val el = net.elements.getOrNull(veh.elem) ?: return null
            var ahead = el.poly.len - veh.s
            for (k in 1..4) {
                if (veh.ri + k >= veh.route.size) break
                val ei = veh.route[veh.ri + k]
                val eb = bucket[ei]
                if (eb != null && eb.isNotEmpty()) {
                    val nb = eb[0]
                    return doubleArrayOf(ahead + nb.s - nb.half - veh.half, nb.v)
                }
                val e2 = net.elements.getOrNull(ei) ?: break
                ahead += e2.poly.len
                if (ahead > LOOKAHEAD) break
            }
            return null
        }

        private fun stepVehicle(veh: Vehicle, dt: Double) {
            val el0 = net.elements.getOrNull(veh.elem)
            if (el0 == null) { veh.dead = true; return }
            val el: Traffic.LaneEl = el0
            val p = polyAt(el.poly, veh.s, sample)
            // target speed: lane limit x driver, curvature, and the entry speed of what comes next
            var v0 = min(el.speed * veh.vf * veh.spec.vmax, p.v)
            val remain = el.poly.len - veh.s
            if (veh.ri + 1 < veh.route.size && remain < 40.0) {
                val nx = net.elements.getOrNull(veh.route[veh.ri + 1])
                if (nx != null) {
                    val entry = min(nx.speed * veh.vf * veh.spec.vmax, nx.poly.vmax[0].toDouble())
                    v0 = min(v0, sqrt(entry * entry + 2.0 * 2.0 * max(0.0, remain - 1.0)))
                }
            }
            var a = idmAccel(veh.v, v0, 1e9, 0.0, A_MAX)
            val lead = leader(veh)
            if (lead != null) a = min(a, idmAccel(veh.v, v0, lead[0], veh.v - lead[1], A_MAX))
            val stop = veh.stopDist
            if (stop < 1e8) a = min(a, idmAccel(veh.v, v0, stop, veh.v, A_MAX))
            a = max(DEC_MAX, min(A_MAX, a))
            veh.v = max(0.0, veh.v + a * dt)
            if (stop < 0.35 && veh.v < 0.6) veh.v = 0.0
            val brakeT = min(1.0, max(0.0, -a / 2.6))
            val hold = if (veh.v < 0.6 && (stop < 1e8 || (lead != null && lead[0] < 9.0))) 0.9 else 0.0
            veh.brake = veh.brake + (max(brakeT, hold) - veh.brake) * min(1.0, dt * 9.0)
            veh.wait = if (veh.v < 0.4) veh.wait + dt else 0.0
            veh.s += veh.v * dt
            veh.dist += veh.v * dt

            // element transitions
            var cur: Traffic.LaneEl = el
            var guard = 0
            while (veh.s > cur.poly.len && guard++ < 6) {
                veh.s -= cur.poly.len
                veh.ri++
                if (veh.ri >= veh.route.size) {
                    if (!extendRoute(veh) || veh.ri >= veh.route.size) { veh.dead = true; return }
                }
                cur = net.elements[veh.route[veh.ri]]
                if (veh.route.size - veh.ri < 3) extendRoute(veh)
                if (veh.ri > 40) {
                    veh.route = veh.route.copyOfRange(veh.ri, veh.route.size)
                    veh.ri = 0
                }
            }
            if (veh.route.size - veh.ri < 3) extendRoute(veh)

            val q = polyAt(cur.poly, veh.s, sample)
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
            veh.speedRatio = if (el.speed > 0.1) min(1.0, veh.v / el.speed) else 1.0
        }
    }
}
