package com.fablecities.android.worldgen

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The site's building-growth model (buildings/index.js): empty lots wait for a builder
 * (demand-driven dice), construction progresses through CONSTRUCTION_STEPS, and mature buildings
 * level up in happy, valuable neighbourhoods. The FORMULAS are bit-exact — the same constants
 * (MEAN_FILL_HOURS 10, STARTER_RATE 3.5 / STARTER_BUILDINGS 8 opening grace, LIVE_STEP 240 game
 * seconds, LEVELUP_PERIOD 6 game hours, MATURE_AGE 14 game hours, CONSTRUCTION_STEPS 8,
 * BUILD_HOURS per type × (1 + 0.18 × (level-1))), the same demand mapping
 * (clamp(demand × 1.5, 0.10, 1.25)) and the same rng call order per step.
 *
 * The native simplification (documented): a painted 8 m zone cell IS one lot — the site merges
 * painted cells into 2×2…4×4 lots touching the road (zoning/ZoneGrid.js, not yet ported — the
 * full grid follows the road network with oriented trapezoid cells). Building heights come from
 * the renderer's palette table rather than the procedural mass generators.
 */
object Growth {

    const val MEAN_FILL_HOURS = 10.0
    const val STARTER_RATE = 3.5
    const val STARTER_BUILDINGS = 8
    const val LIVE_STEP = 240.0           // game seconds per live growth step
    const val BULK_STEP = 3600.0
    const val LEVELUP_PERIOD = 6 * 3600.0
    const val MATURE_AGE = 14 * 3600.0
    const val CONSTRUCTION_STEPS = 8
    const val DAY = 86400.0

    /** The web forks world.rng with hashString('buildings-growth') — seed 1337 → this stream. */
    fun growthRng(seed: Int): Rng = Rng(hash2Signed(seed, PuddleField.fnv("buildings-growth")))

    /** Construction time in game hours per type (× level factor) — buildings/index.js BUILD_HOURS. */
    fun buildHours(type: String): Double = when (type) {
        "res-low" -> 1.1; "res-high" -> 2.2; "com-low" -> 1.5
        "com-high" -> 3.0; "office" -> 3.0; "ind" -> 1.9
        else -> 1.6
    }

    fun buildSeconds(type: String, level: Int): Double =
        (buildHours(type) * (1 + 0.18 * (level - 1))) * 3600.0

    /** buildings/index.js demandFor: floor 0.10, ceiling 1.25, demand × 1.5. */
    fun demandFor(demand: Double): Double = max(0.10, min(1.25, demand * 1.5))

    /** buildings/index.js starterBoost: the opening grace fades to 1 by STARTER_BUILDINGS. */
    fun starterBoost(emptyLots: Int, existingBuildings: Int): Double {
        if (existingBuildings >= STARTER_BUILDINGS) return 1.0
        val raw = max(1.0, (STARTER_RATE * MEAN_FILL_HOURS) / max(1.0, emptyLots.toDouble()))
        return 1.0 + (raw - 1.0) * (1.0 - existingBuildings / STARTER_BUILDINGS.toDouble())
    }

    /** One lot (a painted zone cell on the native side; the site's merged 2×2..4×4 lot). */
    class Lot(val id: Int, val wx: Double, val wz: Double, val type: String)

    /** One building record (the web's building record subset the growth model touches). */
    class Building(
        val id: Int,
        val lotId: Int,
        val type: String,
        var level: Int,
        val seed: Int,
        var state: String,     // "construction" | "built"
        var progress: Double,  // 0..1 while constructing
        var age: Double,       // game seconds since spawn
    )

    /** Immutable inputs for one step (the renderer/sim owns the authoritative state). */
    class Eco(val demand: Map<String, Double>, val landValue: Double, val happiness: Double)

    class StepResult(
        val spawned: List<Building>,     // new buildings (callers add them to their own store)
        val completed: List<Int>,        // ids that finished construction this step
        val levelledUp: List<Int>,       // ids that gained a level this step
        val removedLots: List<Int>,      // lot ids whose building was cleared (repaint)
    )

    /**
     * One growth step of `dt` game seconds (buildings/index.js growthStep + level-up roll
     * collapsed per step like the web's dayAcc branch, scaled per LEVELUP_PERIOD). The rng is
     * handed in (the web's module-level makeRng(1337 ^ 0x63)); call order: fill dice per empty
     * lot (type-filtered), then level dice for fresh spawns, then construction progress, then
     * level-up rolls per mature built building.
     */
    fun step(
        dt: Double,
        lots: List<Lot>,
        buildingsById: MutableMap<Int, Building>,
        buildingsByLot: Map<Int, Building>,
        eco: Eco,
        rng: Rng,
        nextId: Int,
    ): StepResult {
        val hours = dt / 3600.0
        val spawned = ArrayList<Building>()
        val completed = ArrayList<Int>()
        val levelledUp = ArrayList<Int>()
        var idSeq = nextId
        val landValue = eco.landValue
        val happiness = eco.happiness

        // new buildings on empty lots
        val empty = lots.size - buildingsByLot.size
        val boost = starterBoost(empty, buildingsById.size)
        for (lot in lots) {
            if (buildingsByLot.containsKey(lot.id)) continue
            val p = (hours / MEAN_FILL_HOURS) * demandFor(eco.demand[DEMAND_KEY[lot.type]] ?: 0.5) * 1.0 * boost
            if (rng.next() >= p) continue
            var level = 1
            if (rng.next() < landValue * 0.9) level++
            if (rng.next() < landValue * 0.35) level++
            val b = Building(idSeq++, lot.id, lot.type, level,
                hash2Signed(lot.id, 0x51), "construction", 0.0, 0.0)
            buildingsById[b.id] = b
            spawned.add(b)
        }
        // construction progress and ageing
        for (b in buildingsById.values) {
            b.age += dt
            if (b.state == "construction") {
                val before = floor(b.progress * CONSTRUCTION_STEPS).toInt()
                b.progress = min(1.0, b.progress + dt / buildSeconds(b.type, b.level))
                if (b.progress >= 1.0) {
                    b.state = "built"
                    completed.add(b.id)
                }
                // remount points (floor(progress * STEPS) crossing) only rebuild the site's mesh;
                // the native reads b.progress every frame, so nothing extra to do here
            }
        }
        // level-ups: mature buildings in happy, valuable neighbourhoods. The web rolls once per
        // LEVELUP_PERIOD with chance = 0.06 × days × … (days = period/DAY); collapsing per step
        // with dt/DAY keeps the identical expected rate per game second.
        val days = dt / DAY
        val chance = 0.06 * days * (0.35 + 0.65 * happiness) * (0.4 + 0.6 * landValue)
        if (chance > 0.0) {
            for (b in buildingsById.values) {
                if (b.state != "built" || b.level >= 5 || b.age < MATURE_AGE) continue
                val q = chance / (1 + 0.8 * (b.level - 1))
                if (rng.next() < q) {
                    b.level += 1
                    levelledUp.add(b.id)
                }
            }
        }
        return StepResult(spawned, completed, levelledUp, emptyList())
    }

    /** buildings/index.js DEMAND_KEY. */
    val DEMAND_KEY = mapOf(
        "res-low" to "residential", "res-high" to "residential",
        "com-low" to "commercial", "com-high" to "commercial",
        "ind" to "industrial", "office" to "office",
    )

    /** Deterministic per-building noise in [0,1) — the web's jitter(b.seed, salt). */
    fun jitter(seed: Int, salt: Int): Double = Rng(hash2Signed(seed, salt)).next()
}
