package com.fablecities.android.worldgen

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Bit-exact Kotlin port of the street-furniture half of the web game's
 * src/modules/props/PropScatter.js — the per-segment scatter (bus stops, street trees in pits,
 * benches + bins, litter bins, hydrants, avenue planters/cycle stands/news boxes, regulatory
 * signs, utility cabinets, kerbside parked cars and the park-path furniture), driven by the same
 * rng chain `makeRng(hash2(seed, hashString('props:' + seg.id)))` and the same per-(segment,
 * side, channel) 1-D arc-length occupancy, so the SAME seed puts the SAME bench on the SAME
 * kerb. The native segment adapter wraps the demo road polylines (id "d<idx>", the demo
 * halfWidth as the kerb line, the site's ROAD_TYPES sidewalk/cwHalf values).
 *
 * The procedural prop GEOMETRY stays native (simple box compositions in the site's palette);
 * the web's PropGeometry/PropTextures are baked GLTF+canvas assets that a GLES renderer draws
 * with its own primitives at the same footprints (the CONTACT table's r[] ellipses).
 */
object Props {

    class Item(
        val kind: String,
        val x: Double, val y: Double, val z: Double,
        val yaw: Double, val s: Double,
        val tint: DoubleArray? = null,
        val tintHex: Double? = null,   // the parked cars carry a web carPalette hex
    )

    /** The native adapter for a web road segment (PropScatter's `seg`). */
    class Seg(
        val id: String,
        val type: String,
        val pts: List<DoubleArray>,       // dense [x, z] centreline
        val half: Double,                 // kerb-line offset from the centreline (seg.width * 0.5)
        val cwHalf: Double,               // carriageway half (RoadTypes.js)
        val sidewalk: Double,             // sidewalk width (RoadTypes.js)
    ) {
        val length: Double
        val acc: DoubleArray

        init {
            val a = DoubleArray(pts.size)
            for (i in 1 until pts.size) {
                a[i] = a[i - 1] + hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
            }
            acc = a
            length = a[pts.size - 1]
        }
    }

    class Result(val items: List<Item>, val counts: Map<String, Int>)

    private val slots = HashMap<String, ArrayList<DoubleArray>>()

    /** PropScatter CAR_COLORS — the parked-car paint palette (hex). */
    val CAR_PALETTE = doubleArrayOf(
        0xf2f3f4.toDouble(), 0xe8e9ea.toDouble(), 0xd8dade.toDouble(), 0xb9bdc0.toDouble(),
        0x9aa0a5.toDouble(), 0x6d7377.toDouble(), 0x2f3438.toDouble(), 0x1b1e21.toDouble(),
        0x2d4a72.toDouble(), 0x38607f.toDouble(), 0x6b2f33.toDouble(), 0x8f3b2c.toDouble(),
        0x35513c.toDouble(), 0x7a6a4f.toDouble(), 0xc9a227.toDouble(), 0x1f4a3c.toDouble(),
    )

    private fun claim(seg: Seg, side: Int, s: Double, half: Double, ch: String = "k"): Boolean {
        val key = "${seg.id}:$side:$ch"
        val list = slots.getOrPut(key) { ArrayList() }
        val a = s - half
        val b = s + half
        for (iv in list) if (a < iv[1] && b > iv[0]) return false
        list.add(doubleArrayOf(a, b))
        return true
    }

    /** Sidewalk edge sample (RoadNetwork.sampleEdge adapted to the polyline adapter). */
    private fun edge(
        seg: Seg, s: Double, side: Int,
        heightFn: (Double, Double) -> Double,
    ): DoubleArray? {
        if (s < 0.0 || s > seg.length) return null
        var lo = 0
        var hi = seg.acc.size - 1
        while (lo < hi - 1) {
            val mid = (lo + hi) / 2
            if (seg.acc[mid] <= s) lo = mid else hi = mid
        }
        val segLen = seg.acc[lo + 1] - seg.acc[lo]
        val t = if (segLen > 1e-9) (s - seg.acc[lo]) / segLen else 0.0
        val a = seg.pts[lo]; val b = seg.pts[lo + 1]
        val px = a[0] + (b[0] - a[0]) * t
        val pz = a[1] + (b[1] - a[1]) * t
        val tgx = (b[0] - a[0]) / segLen
        val tgz = (b[1] - a[1]) / segLen
        val rx = -tgz
        val rz = tgx
        val lat = side * seg.half
        val x = px + rx * lat
        val z = pz + rz * lat
        val y = heightFn(x, z) + 0.20 // hasCurb kerb offset (surfaceOffset(cwHalf) folds into the conform)
        val nx = side * rx
        val nz = side * rz
        // PropScatter.edge(): e.tx = e.nz * side; e.tz = -e.nx * side — the side multiplies AGAIN
        val etx = nz * side
        val etz = -nx * side
        return doubleArrayOf(x, y, z, nx, nz, etx, etz)
    }

    /** Point `d` metres inside the road from an edge sample (negative = beyond the edge). */
    private fun inset(e: DoubleArray, d: Double): DoubleArray = doubleArrayOf(e[0] - e[3] * d, e[4], e[2] - e[4] * d)

    // PropScatter: faceRoad(e) = atan2(-e.nx, -e.nz); alongRoad(e) = atan2(e.tx, e.tz) — where
    // tx/tz are the side-refolded tangents (e.tx = e.nz·side; e.tz = -e.nx·side)
    private fun faceRoad(e: DoubleArray): Double = atan2(-e[3], -e[4])
    private fun alongRoad(e: DoubleArray): Double = atan2(e[5], e[6])

    /** Per-instance foliage albedo: no two shrubs or hedges the same green. */
    private fun leafTint(rng: Rng): DoubleArray {
        val t = 0.62 + rng.next() * 0.46
        return doubleArrayOf(t * (0.94 + rng.next() * 0.2), t * (1.0 + rng.next() * 0.08), t * (0.86 + rng.next() * 0.2))
    }

    fun crownTint(rng: Rng, species: String): DoubleArray {
        // PropScatter.crownTint — the exact hue classes; the flowering ornamental never takes gold
        val t = 0.74 + rng.next() * 0.40
        val r = rng.next()
        val h = if (species == "conifer") {
            if (r < 0.55) doubleArrayOf(0.70, 0.94, 0.84) else doubleArrayOf(0.80, 1.00, 0.72)
        } else if (species == "blossom") {
            if (r < 0.5) doubleArrayOf(0.96, 0.98, 0.90) else doubleArrayOf(0.88, 0.96, 0.84)
        } else {
            if (r < 0.38) doubleArrayOf(0.90, 1.02, 0.74)          // mid green
            else if (r < 0.62) doubleArrayOf(0.74, 1.02, 0.66)     // deep green
            else if (r < 0.84) doubleArrayOf(1.10, 0.98, 0.56)     // olive
            else if (r < 0.94) doubleArrayOf(1.20, 1.00, 0.50)     // gold / turning
            else doubleArrayOf(0.70, 0.96, 0.86)                   // blue-green
        }
        return doubleArrayOf(
            t * h[0] * (0.93 + rng.next() * 0.14),
            t * h[1] * (0.95 + rng.next() * 0.10),
            t * h[2] * (0.93 + rng.next() * 0.14),
        )
    }

    fun crownSpecies(id: String): String =
        if (id == "tree_conifer") "conifer" else if (id == "tree_small") "blossom" else "broad"

    /** The street furniture scatter over the demo road polylines (PropScatter.segment). */
    fun scatterStreet(
        seed: Int,
        segs: List<Seg>,
        density: Double,
        heightFn: (Double, Double) -> Double,
        isWater: (Double, Double) -> Boolean,
        inBuilding: (Double, Double, Double) -> Boolean,
    ): Result {
        slots.clear()
        val items = ArrayList<Item>(512)
        val counts = HashMap<String, Int>()
        val D = density

        fun add(kind: String, it: Item) {
            items.add(it)
            counts[kind] = (counts[kind] ?: 0) + 1
        }

        for ((idx, seg) in segs.withIndex()) {
            val rng = Rng(hash2Signed(seed, simHashString("props:${seg.id}")))
            val L = seg.length
            val s0 = 0.0
            val s1 = L
            val usable = s1 - s0
            if (usable < 6.0) continue
            val half = seg.half
            val isAvenue = seg.type == "avenue"

            // the road's own lamps hold their kerb slots (RoadMesher places them at (i+0.5)·spacing)
            val lampSpacing = if (seg.type == "highway") 46.0 else if (seg.type == "path") 0.0 else 32.0
            val lampAlt = seg.type != "highway"
            if (lampSpacing > 0.0) {
                val iMin = kotlin.math.ceil((0.0 + 3.0) / lampSpacing - 0.5).toInt()
                val iMax = kotlin.math.floor((L - 3.0) / lampSpacing - 0.5).toInt()
                for (i in iMin..iMax) {
                    // roadLamps: alternate sides for street lamps, masts claim the +1 kerb
                    val side = if (lampAlt) (if (((i % 2) + 2) % 2 == 0) 1 else -1) else 1
                    claim(seg, side, (i + 0.5) * lampSpacing, 1.1)
                }
            }

            if (seg.type == "highway") continue // roads owns the motorway furniture
            if (seg.type == "path") { pathSegment(seg, rng, heightFn, isWater, inBuilding, ::add); continue }

            val sidewalk = seg.sidewalk
            val treeStep = if (isAvenue) 11.5 else 14.0
            val treeIn = (sidewalk * 0.32).coerceIn(0.55, 1.0)
            val endClear = 8.0
            val hydrantSide = if (rng.next() < 0.5) 1 else -1
            val parkSide = if (rng.next() < 0.5) 1 else -1

            for (side in intArrayOf(-1, 1)) {
                // --- bus stop first: it is the biggest thing on the kerb
                if (usable > 90.0 && rng.next() < (if (isAvenue) 0.7 else 0.34) * D) {
                    val s = s0 + 26.0 + rng.next() * (usable - 56.0)
                    if (claim(seg, side, s, if (isAvenue) 2.4 else 0.9) && claim(seg, side, s, 7.5, "p")) {
                        val e = edge(seg, s, side, heightFn)
                        if (e != null) {
                            if (isAvenue) {
                                val p = inset(e, 1.6)
                                add("bus_shelter", Item("bus_shelter", p[0], e[1], p[2], faceRoad(e), 1.0))
                            }
                            val f = if (isAvenue) edge(seg, s + 3.2, side, heightFn) else e
                            if (f != null) {
                                val q = inset(f, max(0.4, half - (seg.cwHalf + 0.85)))
                                add("sign_post", Item("sign_post", q[0], f[1], q[2], faceRoad(f), 1.0))
                                add("sign_busstop", Item("sign_busstop", q[0], f[1], q[2], faceRoad(f), 1.0))
                            }
                        }
                    }
                }

                // --- street trees in a regular rhythm, skipping the slots the lamps already hold
                if (sidewalk >= 1.15) {
                    val narrow = sidewalk < 1.6
                    val phase = rng.next() * treeStep
                    var s = s0 + endClear + phase
                    while (s < s1 - endClear) {
                        if (rng.next() > 0.94 * D) { s += treeStep; continue }
                        val js = s + (rng.next() - 0.5) * 1.2
                        if (!claim(seg, side, js, 1.25)) { s += treeStep; continue }
                        val e = edge(seg, js, side, heightFn)
                        if (e == null) { s += treeStep; continue }
                        val p = inset(e, treeIn)
                        if (isWater(p[0], p[2])) { s += treeStep; continue }
                        if (inBuilding(p[0], p[2], 0.6)) { s += treeStep; continue }
                        val r = rng.next()
                        val kindId = if (narrow) {
                            if (r < 0.5) "tree_upright" else if (r < 0.82) "tree_upright_b" else "tree_small"
                        } else {
                            if (r < 0.26) "tree_broad" else if (r < 0.48) "tree_broad_b"
                            else if (r < 0.64) "tree_upright" else if (r < 0.78) "tree_upright_b"
                            else if (r < 0.90) "tree_small" else "tree_conifer"
                        }
                        val sc = (if (narrow) 0.74 else 0.84) + rng.next() * 0.36
                        val species = crownSpecies(kindId)
                        add(kindId, Item(kindId, p[0], e[1] - 0.02, p[2], rng.next() * PI * 2.0, sc, crownTint(rng, species)))
                        add("tree_pit", Item("tree_pit", p[0], e[1] - 0.035, p[2], rng.next() * 3.0, (sc * 0.9).coerceIn(0.8, 1.05)))
                        s += treeStep
                    }
                }

                // --- benches facing the carriageway, usually with a bin beside them
                val benchStep = if (isAvenue) 21.0 else 30.0
                var s = s0 + 14.0 + rng.next() * benchStep
                while (s < s1 - 10.0) {
                    if (sidewalk < 1.9 || rng.next() > 0.86 * D) { s += benchStep; continue }
                    if (!claim(seg, side, s, 1.1)) { s += benchStep; continue }
                    val e = edge(seg, s, side, heightFn)
                    if (e == null) { s += benchStep; continue }
                    val p = inset(e, (sidewalk * 0.46).coerceIn(0.7, 1.2))
                    add("bench", Item("bench", p[0], e[1], p[2], faceRoad(e), 1.0))
                    if (rng.next() < 0.78 && claim(seg, side, s + 2.3, 0.5)) {
                        val b = edge(seg, s + 2.3, side, heightFn)
                        if (b != null) {
                            val q = inset(b, (sidewalk * 0.34).coerceIn(0.5, 0.95))
                            val binKind = if (rng.next() < 0.75) "bin" else "bin_rust"
                            add(binKind, Item(binKind, q[0], b[1], q[2], rng.next() * 6.28, 1.0))
                        }
                    }
                    s += benchStep
                }

                // --- litter bins mid-block
                val binStep = 19.0
                s = s0 + 20.0 + rng.next() * binStep
                while (s < s1 - 8.0) {
                    if (sidewalk < 1.4 || rng.next() > 0.78 * D) { s += binStep; continue }
                    if (!claim(seg, side, s, 0.5)) { s += binStep; continue }
                    val e = edge(seg, s, side, heightFn)
                    if (e == null) { s += binStep; continue }
                    val p = inset(e, (sidewalk * 0.33).coerceIn(0.45, 0.9))
                    val binKind = if (rng.next() < 0.7) "bin" else "bin_rust"
                    add(binKind, Item(binKind, p[0], e[1], p[2], rng.next() * 6.28, 1.0))
                    s += binStep
                }

                // --- hydrants (one side only, deterministic per segment)
                if (side == hydrantSide && sidewalk >= 1.4) {
                    s = s0 + 16.0 + rng.next() * 40.0
                    while (s < s1 - 12.0) {
                        if (!claim(seg, side, s, 0.45)) { s += 42.0 + rng.next() * 18.0; continue }
                        val e = edge(seg, s, side, heightFn)
                        if (e == null) { s += 42.0 + rng.next() * 18.0; continue }
                        val p = inset(e, max(0.35, half - (seg.cwHalf + 0.7)))
                        val hydKind = if (rng.next() < 0.65) "hydrant" else "hydrant_aged"
                        add(hydKind, Item(hydKind, p[0], e[1], p[2], rng.next() * 6.28, 1.0))
                        s += 42.0 + rng.next() * 18.0
                    }
                }

                // --- kerbside clutter: planters and cycle stands on the avenue, news boxes downtown
                if (isAvenue) {
                    s = s0 + 18.0 + rng.next() * 20.0
                    while (s < s1 - 14.0) {
                        if (rng.next() > 0.82 * D) { s += 17.0; continue }
                        if (!claim(seg, side, s, 1.0)) { s += 17.0; continue }
                        val e = edge(seg, s, side, heightFn)
                        if (e == null) { s += 17.0; continue }
                        val r = rng.next()
                        if (r < 0.45) {
                            val p = inset(e, 1.05)
                            add("planter", Item("planter", p[0], e[1], p[2], alongRoad(e), 1.0))
                        } else if (r < 0.78) {
                            for (k in -1..1) {
                                val b = edge(seg, s + k * 0.95, side, heightFn)
                                if (b == null) continue
                                val q = inset(b, 1.0)
                                add("cycle_stand", Item("cycle_stand", q[0], b[1], q[2], alongRoad(b), 1.0))
                            }
                        } else {
                            val p = inset(e, 0.95)
                            add("news_box", Item("news_box", p[0], e[1], p[2], faceRoad(e) + (rng.next() - 0.5) * 0.3, 1.0))
                        }
                        s += 17.0
                    }
                }

                // --- mid-block regulatory signs
                val signStep = if (isAvenue) 58.0 else 46.0
                s = s0 + 30.0 + rng.next() * signStep
                while (s < s1 - 16.0) {
                    if (rng.next() > 0.75 * D) { s += signStep; continue }
                    if (!claim(seg, side, s, 0.5)) { s += signStep; continue }
                    val e = edge(seg, s, side, heightFn)
                    if (e == null) { s += signStep; continue }
                    val p = inset(e, max(0.35, half - (seg.cwHalf + 0.75)))
                    val r = rng.next()
                    val id = if (isAvenue) {
                        if (r < 0.45) "sign_speed50" else if (r < 0.75) "sign_priority" else "sign_noparking"
                    } else {
                        if (r < 0.35) "sign_speed30" else if (r < 0.62) "sign_noparking" else if (r < 0.85) "sign_parking" else "sign_crossing"
                    }
                    val yaw = faceRoad(e) + (rng.next() - 0.5) * 0.1
                    add("sign_post", Item("sign_post", p[0], e[1], p[2], yaw, 1.0))
                    add(id, Item(id, p[0], e[1], p[2], yaw, 1.0))
                    s += signStep
                }

                // --- utility cabinets against the building line
                if (sidewalk >= 2.0) {
                    s = s0 + 34.0 + rng.next() * 60.0
                    while (s < s1 - 20.0) {
                        if (rng.next() > 0.72 * D) { s += 78.0 + rng.next() * 46.0; continue }
                        if (!claim(seg, side, s, 0.85)) { s += 78.0 + rng.next() * 46.0; continue }
                        val e = edge(seg, s, side, heightFn)
                        if (e == null) { s += 78.0 + rng.next() * 46.0; continue }
                        val p = inset(e, 0.6)
                        add("utility_box", Item("utility_box", p[0], e[1], p[2], faceRoad(e), 1.0))
                        s += 78.0 + rng.next() * 46.0
                    }
                }
            }

            // --- kerbside parked cars: one side of a local street, tight against the kerb
            if (seg.type == "local" && usable > 42.0) {
                val slot = 6.4
                val side = parkSide
                var gap = 0
                var s = s0 + 13.0 + rng.next() * 5.0
                while (s < s1 - 13.0) {
                    if (gap > 0) { gap--; s += slot; continue }
                    if (rng.next() > 0.72 * D) {
                        gap = 1 + floor(rng.next() * 3).toInt()
                        s += slot; continue
                    }
                    if (!claim(seg, side, s, 2.55, "p")) { s += slot; continue }
                    val e = edge(seg, s, side, heightFn)
                    if (e == null) { s += slot; continue }
                    // outer flank 0.15 m off the kerb face — the car never overhangs the sidewalk
                    val p = inset(e, half - seg.cwHalf + 1.12 + (rng.next() - 0.5) * 0.1)
                    val r = rng.next()
                    val id = if (r < 0.34) "car_sedan" else if (r < 0.62) "car_hatch" else if (r < 0.85) "car_estate" else "car_van"
                    val flip = if (rng.next() < 0.5) 0.0 else PI
                    val yaw = alongRoad(e) + flip + (rng.next() - 0.5) * 0.04
                    // PropScatter carPalette: 16 fixed paints, picked AFTER the yaw draw
                    val hex = CAR_PALETTE[floor(rng.next() * CAR_PALETTE.size).toInt().coerceAtMost(CAR_PALETTE.size - 1)]
                    val item = Item(id, p[0], e[1] - 0.21, p[2], yaw, 1.0, null, hex)
                    add(id, item)
                    s += slot
                }
            }
        }
        return Result(items, counts)
    }

    /** Park paths: classic lamps, benches, bins and shrubs along the verge (PropScatter.pathSegment). */
    private fun pathSegment(
        seg: Seg, rng: Rng,
        heightFn: (Double, Double) -> Double,
        isWater: (Double, Double) -> Boolean,
        inBuilding: (Double, Double, Double) -> Boolean,
        add: (String, Item) -> Unit,
    ) {
        val L = seg.length
        val s0 = 0.0
        val s1 = L
        if (s1 - s0 < 10.0) return
        var i = 0
        var s = s0 + 6.0 + rng.next() * 6.0
        while (s < s1 - 5.0) {
            val side = if (i % 2 == 0) 1 else -1
            val e = edge(seg, s, side, heightFn)
            if (e != null) {
                val p = inset(e, -0.6)
                if (!isWater(p[0], p[2])) {
                    val y = min(e[1] + 0.25, max(e[1] - 0.5, heightFn(p[0], p[2])))
                    add("lamp_classic", Item("lamp_classic", p[0], y, p[2], rng.next() * 6.28, 1.0))
                    if (rng.next() < 0.55) {
                        val b = edge(seg, s + 4.0, -side, heightFn)
                        if (b != null) {
                            val q = inset(b, -0.85)
                            add("bench", Item("bench", q[0], heightFn(q[0], q[2]), q[2], faceRoad(b), 1.0))
                            if (rng.next() < 0.5) {
                                val r2 = edge(seg, s + 6.2, -side, heightFn)
                                if (r2 != null) {
                                    val q2 = inset(r2, -0.8)
                                    val binKind = if (rng.next() < 0.7) "bin" else "bin_rust"
                                    add(binKind, Item(binKind, q2[0], heightFn(q2[0], q2[2]), q2[2], rng.next() * 6.28, 1.0))
                                }
                            }
                        }
                    }
                    // shade trees set back from the path, then shrubs filling the verge
                    if (rng.next() < 0.62) {
                        val b = edge(seg, s + (rng.next() - 0.5) * 12.0, if (rng.next() < 0.5) 1 else -1, heightFn)
                        if (b != null) {
                            val q = inset(b, -2.4 - rng.next() * 3.4)
                            if (!isWater(q[0], q[2]) && !inBuilding(q[0], q[2], 2.0)) {
                                val r = rng.next()
                                val id = if (r < 0.30) "tree_broad" else if (r < 0.52) "tree_broad_b" else if (r < 0.66) "tree_upright"
                                else if (r < 0.78) "tree_small" else "tree_conifer"
                                add(id, Item(id, q[0], heightFn(q[0], q[2]) - 0.05, q[2], rng.next() * 6.28, 0.9 + rng.next() * 0.45,
                                    crownTint(rng, crownSpecies(id))))
                            }
                        }
                    }
                    for (k in 0 until 4) {
                        if (rng.next() > 0.62) continue
                        val b = edge(seg, s + (rng.next() - 0.5) * 16.0, if (rng.next() < 0.5) 1 else -1, heightFn)
                        if (b == null) continue
                        val q = inset(b, -1.3 - rng.next() * 2.6)
                        if (isWater(q[0], q[2]) || inBuilding(q[0], q[2], 1.0)) continue
                        val bushKind = if (rng.next() < 0.5) "bush_a" else "bush_b"
                        add(bushKind, Item(bushKind, q[0], heightFn(q[0], q[2]) - 0.05, q[2], rng.next() * 6.28, 0.85 + rng.next() * 0.55, leafTint(rng)))
                    }
                }
            }
            i++
            s += 21.0
        }
    }
}
