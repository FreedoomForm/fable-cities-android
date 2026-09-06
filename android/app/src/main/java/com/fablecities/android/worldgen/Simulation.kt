package com.fablecities.android.worldgen

import kotlin.math.max
import kotlin.math.min
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ceil

/**
 * Kotlin port of the browser game's simulation core (pure logic, no three.js):
 *   src/modules/simulation/services.js  — SimServices (coverage grids, strain, upkeep)
 *   src/modules/simulation/economy.js   — SimEconomy (occupancy, jobs, demand, happiness, money)
 *   src/modules/simulation/milestones.js— SimMilestones (population thresholds + alerts)
 *
 * Golden values pinned by SimulationParityTest come from running the REAL web modules in Node
 * (scripts/probe_sim.mjs) on a synthetic village driven for 336 game hours with the site's own
 * simulation RNG: world.rng.fork(hashString('simulation')) → makeRng(hash2(1337, hashString('simulation'))).
 *
 * JS semantics preserved: Double math, Math.round = floor(x+0.5), Float32 coverage grids,
 * insertion-ordered occupancy map (the pollution loop depends on its iteration order).
 */

// ------------------------------------------------------------------ shared

fun simHashString(str: String): Int {
    var h = 2166136261.toInt() // 0x811C9DC5 as Int32, matching JS (h ^= charCode coerces to Int32)
    for (c in str) {
        h = h xor c.code
        h *= 16777619
    }
    return h
}

/** JS Math.round: floor(x + 0.5) (rounds half toward +infinity — NOT kotlin's round). */
fun jsRound(x: Double): Double = floor(x + 0.5)

fun simClamp01(v: Double): Double = if (v < 0.0) 0.0 else if (v > 1.0) 1.0 else v

fun simDamp(current: Double, target: Double, lambda: Double, dt: Double): Double {
    val t = 1.0 - exp(-lambda * dt)
    return current + (target - current) * t
}

// ------------------------------------------------------------------ services

object SimIds {
    val IDS = listOf("power", "water", "sewage", "garbage", "police", "fire", "health", "education")
    val UTILITIES = setOf("power", "water", "sewage", "garbage")
}

class ServiceType(
    val id: String, val name: String, val group: String,
    val radius: Double, val capacity: Double,
    val cost: Int, val upkeep: Int, val workers: Int,
    val w: Double, val d: Double, val height: Double,
)

/** SERVICE_TYPES — exact values from services.js (weekly upkeep ¤, radius m, capacity people). */
val SERVICE_TYPES: Map<String, ServiceType> = linkedMapOf(
    "power" to ServiceType("power", "Coal Power Plant", "utilities", 640.0, 9000.0, 120000, 1150, 40, 60.0, 42.0, 22.0),
    "water" to ServiceType("water", "Water Tower", "utilities", 480.0, 6000.0, 32000, 260, 6, 18.0, 18.0, 27.0),
    "sewage" to ServiceType("sewage", "Sewage Treatment Plant", "utilities", 600.0, 7000.0, 60000, 480, 12, 46.0, 38.0, 8.0),
    "garbage" to ServiceType("garbage", "Landfill Site", "utilities", 560.0, 7000.0, 45000, 420, 18, 64.0, 50.0, 7.0),
    "police" to ServiceType("police", "Police Station", "safety", 400.0, 4500.0, 50000, 590, 30, 30.0, 22.0, 9.5),
    "fire" to ServiceType("fire", "Fire House", "safety", 380.0, 4500.0, 42000, 560, 24, 30.0, 24.0, 9.5),
    "health" to ServiceType("health", "Medical Clinic", "wellbeing", 420.0, 4000.0, 70000, 820, 40, 36.0, 26.0, 13.5),
    "education" to ServiceType("education", "Elementary School", "wellbeing", 360.0, 3000.0, 55000, 720, 26, 44.0, 28.0, 8.5),
)

/** Coverage falloff: full strength inside 70 % of the radius, fading to 0 at the radius. */
fun serviceFalloff(dist: Double, radius: Double): Double = Environment.smoothstep(1.0, 0.7, dist / radius)

class ServiceRec(
    val id: String, val type: String, val name: String,
    val x: Double, val y: Double, val z: Double,
    val w: Double, val d: Double, val height: Double,
    val radius: Double, val capacity: Double, val upkeep: Int, val workers: Int,
) { var efficiency: Double = 1.0 }

/** Port of ServicesModel (coverage grids + strain), rasterised on the site's 16 m grid. */
class SimServices(worldHalf: Double, worldSize: Double) {
    val res = 16.0
    val n = kotlin.math.ceil(worldSize / res).toInt()
    val half = worldHalf
    val grids = HashMap<String, FloatArray>()
    val strain = HashMap<String, Double>()
    val capacity = HashMap<String, Double>()
    val counts = HashMap<String, Int>()
    val demandServed = HashMap<String, Double>()
    val list = ArrayList<ServiceRec>()
    var version = 0
        private set
    private var nextId = 1

    init {
        for (id in SimIds.IDS) {
            grids[id] = FloatArray(n * n)
            strain[id] = 1.0
            capacity[id] = 0.0
            counts[id] = 0
            demandServed[id] = 0.0
        }
    }

    fun place(type: String, x: Double, z: Double, y: Double, free: Boolean, money: DoubleArray): ServiceRec? {
        val def = SERVICE_TYPES[type] ?: return null
        if (!free) money[0] -= def.cost
        val rec = ServiceRec(
            "svc-" + nextId++, def.id, def.name, x, y, z,
            def.w, def.d, def.height, def.radius, def.capacity, def.upkeep, def.workers)
        list.add(rec)
        rasterise(def.id)
        version++
        return rec
    }

    fun remove(rec: ServiceRec) {
        list.remove(rec)
        rasterise(rec.type)
        version++
    }

    /** Re-rasterise the coverage grid of one service type (services.js _rasterise). */
    private fun rasterise(type: String) {
        val g = grids[type]!!
        java.util.Arrays.fill(g, 0f)
        var count = 0
        var cap = 0.0
        for (b in list) {
            if (b.type != type) continue
            count++
            cap += b.capacity
            val r = b.radius
            val i0 = max(0, kotlin.math.floor((b.x - r + half) / res).toInt())
            val i1 = min(n - 1, kotlin.math.ceil((b.x + r + half) / res).toInt())
            val j0 = max(0, kotlin.math.floor((b.z - r + half) / res).toInt())
            val j1 = min(n - 1, kotlin.math.ceil((b.z + r + half) / res).toInt())
            for (j in j0..j1) {
                val cz = -half + (j + 0.5) * res
                val dz = cz - b.z
                for (i in i0..i1) {
                    val cx = -half + (i + 0.5) * res
                    val dx = cx - b.x
                    val d = kotlin.math.sqrt(dx * dx + dz * dz)
                    if (d >= r) continue
                    val k = j * n + i
                    // JS: f32 grid value read, f64 add, rounded back to f32 on store
                    val v = g[k] + serviceFalloff(d, r)
                    g[k] = if (v > 1.0) 1f else v.toFloat()
                }
            }
        }
        counts[type] = count
        capacity[type] = cap
    }

    /** Coverage before capacity strain, bilinear-sampled (services.js rawCoverageAt). */
    fun rawCoverageAt(x: Double, z: Double, type: String): Double {
        val g = grids[type] ?: return 0.0
        val fx = (x + half) / res - 0.5
        val fz = (z + half) / res - 0.5
        val i = kotlin.math.floor(fx).toInt()
        val j = kotlin.math.floor(fz).toInt()
        val tx = fx - i
        val tz = fz - j
        fun s(ii: Int, jj: Int): Float = if (ii < 0 || jj < 0 || ii >= n || jj >= n) 0f else g[jj * n + ii]
        val a = s(i, j) * (1 - tx).toFloat() + s(i + 1, j) * tx.toFloat()
        val b = s(i, j + 1) * (1 - tx).toFloat() + s(i + 1, j + 1) * tx.toFloat()
        return (a * (1 - tz).toFloat() + b * tz.toFloat()).toDouble()
    }

    /** Capacity strain (services.js updateStrain). */
    fun updateStrain(demandByType: Map<String, Double>, efficiency: Double) {
        for (id in SimIds.IDS) {
            val demand = demandByType[id] ?: 0.0
            val cap = capacity[id]!! * efficiency
            demandServed[id] = demand
            strain[id] = when {
                cap <= 0 -> 0.0
                demand <= 0 -> 1.0
                else -> min(1.0, cap / demand)
            }
        }
        for (b in list) b.efficiency = efficiency * strain[b.type]!!
    }

    fun weeklyUpkeep(): Int {
        var sum = 0
        for (b in list) sum += b.upkeep
        return sum
    }

    fun totalWorkers(): Int {
        var sum = 0
        for (b in list) sum += b.workers
        return sum
    }
}

// ------------------------------------------------------------------ economy

class SimBuilding(
    val id: String,
    val type: String,          // 'res_low' | 'res_high' | 'com' | 'ind' | 'office'
    val x: Double, val z: Double,
    val w: Double, val d: Double, val height: Double,
    val residents: Double = 0.0, // >0 overrides estimated capacity
    val jobs: Double = 0.0,
    var state: String = "built",
)

fun zoneClass(type: String?): String? {
    if (type == null) return null
    val t = type.lowercase()
    return when {
        t.startsWith("res") -> "residential"
        t.startsWith("com") -> "commercial"
        t.startsWith("ind") -> "industrial"
        t.startsWith("off") -> "office"
        else -> null
    }
}

/** World.economy state (World.js defaults + Economy-managed fields). */
class SimEconState {
    var money: Double = 350000.0
    var population: Int = 0
    var households: Int = 0
    var jobs: Int = 0
    var workers: Int = 0
    var employed: Int = 0
    var unemployment: Double = 0.0
    var jobFill: Double = 0.0
    var income: Int = 0
    var expenses: Int = 0
    var net: Int = 0
    val taxRate = linkedMapOf("residential" to 0.1, "commercial" to 0.1, "industrial" to 0.1, "office" to 0.1)
    var happiness: Double = 0.72
    val demand = linkedMapOf("residential" to 0.6, "commercial" to 0.35, "industrial" to 0.4, "office" to 0.2)
    var cityName: String = "New Fable"
    var education: Double = 0.1
    var pollution: Double = 0.0
    var congestion: Double = 0.0
    var landValue: Double = 0.3
    var residentialCapacity: Int = 0
    val jobsByClass = linkedMapOf("commercial" to 0, "industrial" to 0, "office" to 0, "services" to 0)
    val coverage = linkedMapOf<String, Double>().apply { for (id in SimIds.IDS) put(id, 0.0) }
    var milestone: MilestoneState = MilestoneState()
    var budgetReport: BudgetReport? = null
    val alerts = ArrayList<String>()
}

class MilestoneState {
    var index: Int = -1
    var name: String = "Founding"
    var next: String? = null
    var nextPopulation: Int? = null
    var progress: Double = 1.0
}

class BudgetReport(
    val week: Int, val label: String,
    val income: Int, val expenses: Int, val net: Int,
    val services: Int, val roads: Int, val admin: Int,
    val money: Int, val population: Int, val happiness: Double,
)

/** Port of Economy — O(buildings) once per game hour, O(1) per minute. */
class SimEconomy(private val buildings: List<SimBuilding>, val services: SimServices, private val rng: Rng) {
    val e = SimEconState()
    var buildingsVersion = 0 // bump when the building list changes

    // constants from economy.js
    private val ZONE_CLASSES = listOf("residential", "commercial", "industrial", "office")
    private val TAX_BASE = mapOf("residential" to 19.1, "commercial" to 45.5, "industrial" to 38.1, "office" to 57.7)
    private val ROAD_COST = mapOf("local" to 0.30, "avenue" to 0.64, "highway" to 1.01, "path" to 0.07, "default" to 0.30)
    private val ADMIN_COST = 550.0
    private val HOURS_PER_WEEK = 24 * 7
    private val WORKING_SHARE = 0.62
    private val HOUSEHOLD_SIZE = 2.4
    private val HOURS_PER_DAY = 24
    private val FILL_PER_HOUR = 0.22
    private val MAX_MOVE_IN_PER_HOUR = 2
    private val SETTLE_HOURS = 18
    private val TARGET_OCCUPANCY = 0.94
    private val HOUSEHOLD_SIZES = intArrayOf(1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 5)

    private class Occ(
        var occ: Double, var hh: Int, var homes: Int, var cls: String, var cap: Int,
        val cov: FloatArray, var covVersion: Int, var seen: Int, var since: Int,
        var x: Double, var z: Double,
    )

    private val occ = LinkedHashMap<String, Occ>()
    private var hourlyNet = 0.0
    private var minuteInHour = 0
    private val taxes = HashMap<String, Double>()
    private var roadCost = 0.0
    private var serviceCost = 0.0
    private var weekKey: Int? = null
    private var lastReport: BudgetReport? = null
    private var demandTarget = linkedMapOf("residential" to 0.6, "commercial" to 0.35, "industrial" to 0.4, "office" to 0.2)
    private var happinessTarget = 0.72
    private var lastBuildingsVersion = -1
    private var lastServicesVersion = -1
    private val sumCov = DoubleArray(SimIds.IDS.size)
    private val sumCovCap = DoubleArray(SimIds.IDS.size)
    private var hourCount = 0
    private var newCityBonus = 1.0

    // inputs the renderer bridge sets each hour (the web reads world.traffic / world.roads)
    var trafficCongestion: Double? = 0.06 // null → roads-segments branch
    var roadSegmentsCount = 0
    var roadVehicles = 0
    var totalDays = 0
    var timeDay = 1
    var timeMonth = 5
    var timeYear = 2026

    private fun informalJobs(pop: Double): Double = min(45.0, 10 + pop * 0.08)

    private fun estimateCapacity(b: SimBuilding, cls: String): Int {
        val floors = if (b.height > 0) max(1.0, jsRound(b.height / 3.4)) else 1.0
        val area = (if (b.w > 0) b.w else 16.0) * (if (b.d > 0) b.d else 16.0) * floors
        return when (cls) {
            "residential" -> max(2.0, jsRound(area / (if (b.type.contains("high")) 34.0 else 48.0))).toInt()
            "commercial" -> max(2.0, jsRound(area / 55.0)).toInt()
            "industrial" -> max(3.0, jsRound(area / 80.0)).toInt()
            "office" -> max(4.0, jsRound(area / 22.0)).toInt()
            else -> 0
        }
    }

    /** Called once per game minute: continuous cash flow. Returns true when an hour ticked. */
    fun minute(): Boolean {
        e.money += hourlyNet / 60.0
        minuteInHour++
        if (minuteInHour >= 60) {
            minuteInHour = 0
            hour()
            return true
        }
        return false
    }

    private fun utilityFactor(): Double {
        val c = e.coverage
        return 0.3 + 0.7 * simClamp01((c["power"]!! + c["water"]!!) * 0.5 + 0.1)
    }

    /** Heavy update once per game hour (economy.js hour()). */
    fun hour() {
        hourCount++
        val svc = services

        // 0. week bookkeeping
        val wkey = kotlin.math.floor(totalDays / 7.0).toInt()
        if (weekKey == null) weekKey = wkey
        else if (wkey != weekKey) { closeWeek(weekKey!!); weekKey = wkey }

        val servicesDirty = svc.version != lastServicesVersion

        // 1. sync buildings & occupancy
        var resCap = 0
        var pop = 0.0
        var households = 0
        var settledCap = 0
        var settledPop = 0.0
        val jobs = linkedMapOf("commercial" to 0, "industrial" to 0, "office" to 0, "services" to svc.totalWorkers())
        val pollutionSources = ArrayList<SimBuilding>()
        val seenTag = hourCount
        java.util.Arrays.fill(sumCov, 0.0)
        java.util.Arrays.fill(sumCovCap, 0.0)
        var covWeight = 0.0
        var capWeight = 0.0

        val happy = e.happiness
        val demandRes = e.demand["residential"]!!
        val utilities = utilityFactor()
        val moveInRate = FILL_PER_HOUR * (0.25 + 0.75 * demandRes) * (0.55 + (1 - 0.55) * happy) * utilities * newCityBonus
        val moveOutRate = (if (happy < 0.35) (0.35 - happy) * 0.3 else 0.0) / HOURS_PER_DAY
        val unemploymentOut = (if (e.unemployment > 0.18) (e.unemployment - 0.18) * 0.15 else 0.0) / HOURS_PER_DAY
        val leaveRate = moveOutRate + unemploymentOut

        for (b in buildings) {
            if (b.state != "built") continue
            val cls = zoneClass(b.type) ?: continue
            var st = occ[b.id]
            if (st == null) {
                st = Occ(0.0, 0, 0, cls, 0, FloatArray(SimIds.IDS.size), -1, 0, seenTag, b.x, b.z)
                occ[b.id] = st
            }
            st.seen = seenTag
            st.cls = cls
            if (st.covVersion != svc.version || st.x != b.x || st.z != b.z) {
                st.x = b.x; st.z = b.z; st.covVersion = svc.version
                for (k in SimIds.IDS.indices) st.cov[k] = svc.rawCoverageAt(b.x, b.z, SimIds.IDS[k]).toFloat()
            }
            if (cls == "residential") {
                val cap = if (b.residents > 0) b.residents.toInt() else estimateCapacity(b, cls)
                st.cap = cap
                resCap += cap
                val homes = max(1.0, jsRound(cap / HOUSEHOLD_SIZE)).toInt()
                st.homes = homes
                val wanted = if (homes <= 2) homes else max(2.0, jsRound(homes * TARGET_OCCUPANCY)).toInt()
                if (st.hh > homes) { st.occ *= homes.toDouble() / st.hh; st.hh = homes }
                val lp = st.cov[0].toDouble() * svc.strain["power"]!!
                val lw = st.cov[1].toDouble() * svc.strain["water"]!!
                val localUtil = 0.25 + 0.75 * min(1.0, (lp + lw) * 0.5 + 0.15)
                val free = wanted - st.hh
                if (free > 0) {
                    val expected = free * moveInRate * localUtil
                    var n = kotlin.math.floor(expected).toInt()
                    if (rng.next() < expected - n) n++
                    if (n > MAX_MOVE_IN_PER_HOUR) n = MAX_MOVE_IN_PER_HOUR
                    if (n > free) n = free
                    for (k in 0 until n) {
                        val size = min(HOUSEHOLD_SIZES[(rng.next() * HOUSEHOLD_SIZES.size).toInt()].toDouble(), max(1.0, cap - st.occ))
                        st.hh++
                        st.occ += size
                    }
                }
                if (leaveRate > 0 && st.hh > 0) {
                    val expected = st.hh * leaveRate
                    var n = kotlin.math.floor(expected).toInt()
                    if (rng.next() < expected - n) n++
                    if (n > st.hh) n = st.hh
                    for (k in 0 until n) {
                        val avg = st.occ / st.hh
                        st.hh--
                        st.occ = if (st.hh > 0) max(0.0, st.occ - avg) else 0.0
                    }
                }
                pop += st.occ
                households += st.hh
                if (seenTag - st.since >= SETTLE_HOURS) { settledCap += cap; settledPop += st.occ }
                val w = st.occ
                if (w > 0) {
                    covWeight += w
                    for (k in SimIds.IDS.indices) sumCov[k] += st.cov[k] * w
                }
                if (cap > 0) {
                    capWeight += cap
                    for (k in SimIds.IDS.indices) sumCovCap[k] += st.cov[k] * cap
                }
            } else {
                val cap = if (b.jobs > 0) b.jobs.toInt() else estimateCapacity(b, cls)
                st.cap = cap
                jobs[cls] = jobs[cls]!! + cap
                if (cls == "industrial") pollutionSources.add(b)
            }
        }
        if (buildingsVersion != lastBuildingsVersion) {
            occ.entries.removeAll { it.value.seen != seenTag }
            lastBuildingsVersion = buildingsVersion
        }

        // 2. population, jobs, employment
        val totalJobs = jobs["commercial"]!! + jobs["industrial"]!! + jobs["office"]!! + jobs["services"]!!
        val workers = pop * WORKING_SHARE
        val employed = min(workers, totalJobs + informalJobs(pop)) * 0.98
        e.population = jsRound(pop).toInt()
        e.households = households
        e.residentialCapacity = resCap
        e.jobs = totalJobs
        e.jobsByClass.clear(); e.jobsByClass.putAll(jobs)
        e.workers = jsRound(workers).toInt()
        e.employed = jsRound(employed).toInt()
        e.unemployment = if (workers > 1) simClamp01(1 - employed / workers) else 0.0
        e.jobFill = if (totalJobs > 0) simClamp01(employed / totalJobs) else 0.0
        newCityBonus = if (pop < 60) 2.6 else if (pop < 400) 1.6 else if (pop < 1500) 1.25 else 1.0
        val inhabited = pop >= 1

        // 3. service coverage & strain
        val cov = e.coverage
        val demandByType = HashMap<String, Double>()
        for (k in SimIds.IDS.indices) {
            val id = SimIds.IDS[k]
            val raw = if (covWeight > 0) sumCov[k] / covWeight else if (capWeight > 0) sumCovCap[k] / capWeight else 0.0
            var served = if (id == "education") raw * pop * 0.22 else raw * pop
            if (SimIds.UTILITIES.contains(id)) served += raw * totalJobs * 0.6
            demandByType[id] = max(0.0, served)
        }
        val efficiency = if (e.money < 0) 0.6 else 1.0
        svc.updateStrain(demandByType, efficiency)
        for (k in SimIds.IDS.indices) {
            val id = SimIds.IDS[k]
            val raw = if (covWeight > 0) sumCov[k] / covWeight else if (capWeight > 0) sumCovCap[k] / capWeight else 0.0
            cov[id] = simClamp01(raw * svc.strain[id]!!)
        }

        // 4. pollution, congestion, education, land value
        val indShare = if (pop > 0) jobs["industrial"]!!.toDouble() / (pop + jobs["industrial"]!!) else 0.0
        var industrialNearHomes = 0.0
        if (pollutionSources.isNotEmpty() && pop > 0) {
            var hit = 0.0
            var n = 0
            for (st in occ.values) {
                if (st.cls != "residential" || st.occ < 1) continue
                n++
                for (s in pollutionSources) {
                    val dx = s.x - st.x
                    val dz = s.z - st.z
                    if (dx * dx + dz * dz < 120 * 120) { hit += st.occ; break }
                }
            }
            industrialNearHomes = if (n > 0) hit / pop else 0.0
        }
        e.pollution = simClamp01(
            indShare * 0.35 + industrialNearHomes * 0.6 +
                (1 - cov["garbage"]!!) * 0.1 * min(1.0, pop / 500) +
                (1 - cov["sewage"]!!) * 0.1 * min(1.0, pop / 500))
        val tc = trafficCongestion
        e.congestion = if (tc != null) simClamp01(tc) else {
            if (roadSegmentsCount > 0) simClamp01(roadVehicles / (roadSegmentsCount * 14.0)) else 0.0
        }
        if (inhabited) {
            e.education = simDamp(e.education, 0.1 + 0.85 * cov["education"]!!, 0.08, 1.0)
            e.landValue = simClamp01(
                0.25 + 0.3 * e.happiness +
                    0.25 * (cov["police"]!! * 0.5 + cov["health"]!! * 0.3 + cov["education"]!! * 0.2) -
                    0.35 * e.pollution)
        }

        // 5. happiness
        val tr = e.taxRate
        val avgTax = (tr["residential"]!! * 2 + tr["commercial"]!! + tr["industrial"]!! + tr["office"]!!) / 5
        val taxPressure = (avgTax - 0.10) * 2.2
        if (inhabited) {
            val util = (cov["power"]!! + cov["water"]!! + cov["sewage"]!! + cov["garbage"]!!) / 4
            val care = (cov["police"]!! + cov["fire"]!! + cov["health"]!! + cov["education"]!!) / 4
            val target = max(
                0.05, min(0.98,
                    0.42 + 0.28 * util + 0.18 * care - taxPressure - 0.5 * e.unemployment -
                        0.15 * e.congestion - 0.22 * e.pollution + 0.08 * (e.landValue - 0.3)))
            happinessTarget = target
            e.happiness = simDamp(e.happiness, target, 0.12, 1.0)
        }

        // 6. demand
        val vacancy = if (settledCap > 0) simClamp01(1 - settledPop / settledCap) else 0.0
        val openJobs = max(0.0, totalJobs - employed)
        val idealCom = 0.13 * pop + 20
        val idealInd = 0.16 * pop * (1 - 0.5 * e.education) + 15
        val idealOff = 0.10 * pop * (0.3 + e.education) + 5
        val bootstrap = if (pop < 600) 0.18 else 0.0
        var res = 0.18 + bootstrap + 0.65 * simClamp01(openJobs / (totalJobs * 0.6 + 40)) +
            0.35 * (e.happiness - 0.5) - 0.9 * max(0.0, vacancy - 0.12) - taxPressure * 0.5
        res = min(res, if (settledCap > 0 && vacancy < 0.03) 0.85 else 0.92)
        demandTarget["residential"] = simClamp01(res)
        demandTarget["commercial"] = simClamp01(min(0.92, 0.1 + bootstrap * 0.5 + 0.9 * simClamp01((idealCom - jobs["commercial"]!!) / (idealCom + 40)) + 0.35 * e.unemployment - (tr["commercial"]!! - 0.1) * 2))
        demandTarget["industrial"] = simClamp01(min(0.92, 0.08 + bootstrap * 0.6 + 0.9 * simClamp01((idealInd - jobs["industrial"]!!) / (idealInd + 40)) + 0.45 * e.unemployment * (1 - e.education) - (tr["industrial"]!! - 0.1) * 2))
        demandTarget["office"] = simClamp01(min(0.92, 0.04 + bootstrap * 0.2 + 0.9 * simClamp01((idealOff - jobs["office"]!!) / (idealOff + 40)) + 0.35 * e.unemployment * e.education - (tr["office"]!! - 0.1) * 2))
        for (k in ZONE_CLASSES) e.demand[k] = simDamp(e.demand[k]!!, demandTarget[k]!!, 0.25, 1.0)

        // 7. money
        recomputeRates()
        val hpm = HOURS_PER_WEEK.toDouble()
        // hourly period accumulation folded into the hourlyNet flow (see closeWeek for the week sums)
        periodIncome += e.income / hpm
        periodExpenses += e.expenses / hpm
        periodHours++
        periodTaxesRes += taxes["residential"]!! / hpm
        periodTaxesCom += taxes["commercial"]!! / hpm
        periodTaxesInd += taxes["industrial"]!! / hpm
        periodTaxesOff += taxes["office"]!! / hpm
        periodServices += serviceCost / hpm
        periodRoads += roadCost / hpm
        periodAdmin += ADMIN_COST / hpm
        if (servicesDirty) lastServicesVersion = svc.version
    }

    private var periodIncome = 0.0
    private var periodExpenses = 0.0
    private var periodHours = 0
    private var periodTaxesRes = 0.0
    private var periodTaxesCom = 0.0
    private var periodTaxesInd = 0.0
    private var periodTaxesOff = 0.0
    private var periodServices = 0.0
    private var periodRoads = 0.0
    private var periodAdmin = 0.0

    /** Weekly income / expense rates (economy.js recomputeRates). */
    fun recomputeRates() {
        val tr = e.taxRate
        val jb = e.jobsByClass
        val fill = e.jobFill
        fun elasticity(r: Double): Double = 1 - simClamp01((r - 0.12) / 0.18) * 0.45
        taxes["residential"] = e.population * TAX_BASE["residential"]!! * tr["residential"]!! * elasticity(tr["residential"]!!)
        taxes["commercial"] = jb["commercial"]!! * fill * TAX_BASE["commercial"]!! * tr["commercial"]!! * elasticity(tr["commercial"]!!)
        taxes["industrial"] = jb["industrial"]!! * fill * TAX_BASE["industrial"]!! * tr["industrial"]!! * elasticity(tr["industrial"]!!)
        taxes["office"] = jb["office"]!! * fill * TAX_BASE["office"]!! * tr["office"]!! * elasticity(tr["office"]!!)
        roadCost = extraRoadCost // the bridge adds its road network upkeep via setRoadCost
        serviceCost = services.weeklyUpkeep().toDouble()
        val income = taxes["residential"]!! + taxes["commercial"]!! + taxes["industrial"]!! + taxes["office"]!!
        val expenses = serviceCost + roadCost + ADMIN_COST
        e.income = jsRound(income).toInt()
        e.expenses = jsRound(expenses).toInt()
        e.net = e.income - e.expenses
        hourlyNet = (income - expenses) / HOURS_PER_WEEK
    }

    /** Road-network upkeep the bridge recomputes when roads change; rates refresh after. */
    var extraRoadCost = 0.0
        set(value) { field = value; recomputeRates() }

    /** Close the books for week `key` (economy.js closeWeek). */
    fun closeWeek(key: Int): BudgetReport {
        val st = "${timeDay} ${MONTHS[(timeMonth - 1).coerceIn(0, 11)]} $timeYear"
        val label = "Week ${key + 1} ($st)"
        val prev = lastReport
        val report = BudgetReport(
            week = key + 1, label = label,
            income = jsRound(periodIncome).toInt(),
            expenses = jsRound(periodExpenses).toInt(),
            net = jsRound(periodIncome - periodExpenses).toInt(),
            services = jsRound(periodServices).toInt(),
            roads = jsRound(periodRoads).toInt(),
            admin = jsRound(periodAdmin).toInt(),
            money = jsRound(e.money).toInt(),
            population = e.population,
            happiness = e.happiness,
        )
        e.budgetReport = report
        lastReport = report
        periodIncome = 0.0; periodExpenses = 0.0; periodHours = 0
        periodTaxesRes = 0.0; periodTaxesCom = 0.0; periodTaxesInd = 0.0; periodTaxesOff = 0.0
        periodServices = 0.0; periodRoads = 0.0; periodAdmin = 0.0
        return report
    }

    fun lastBudget(): BudgetReport? = lastReport
}

val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

// ------------------------------------------------------------------ milestones

class SimMilestone(val name: String, val population: Int, val reward: Int)

val MILESTONES = listOf(
    SimMilestone("Tiny Village", 120, 25000),
    SimMilestone("Small Village", 400, 40000),
    SimMilestone("Large Village", 1000, 60000),
    SimMilestone("Grand Village", 2200, 90000),
    SimMilestone("Tiny Town", 4000, 120000),
    SimMilestone("Boom Town", 7000, 160000),
    SimMilestone("Busy Town", 11000, 200000),
    SimMilestone("Big Town", 16000, 260000),
    SimMilestone("Great Town", 24000, 320000),
    SimMilestone("Small City", 34000, 400000),
    SimMilestone("Big City", 50000, 500000),
    SimMilestone("Large City", 70000, 650000),
    SimMilestone("Grand City", 100000, 800000),
    SimMilestone("Metropolis", 150000, 1000000),
    SimMilestone("Megalopolis", 250000, 1500000),
)

private const val ALERT_COOLDOWN_HOURS = 24 * 3

/** Port of Milestones — population thresholds with cash rewards + city alerts. */
class SimMilestones(private val economy: SimEconomy) {
    var index = -1
        private set
    var hour = 0
        private set
    private var hadResidents = false
    private val alertTimers = HashMap<String, Int>()
    private val activeAlerts = HashSet<String>()

    /** Notifications emitted this tick: kind|title (for the HUD message panel). */
    val notifications = ArrayList<Pair<String, String>>()

    private fun update() {
        val m = economy.e.milestone
        val next = MILESTONES.getOrNull(index + 1)
        m.index = index
        m.name = if (index >= 0) MILESTONES[index].name else "Founding"
        m.next = next?.name
        m.nextPopulation = next?.population
        m.progress = if (next != null) min(1.0, economy.e.population.toDouble() / next.population) else 1.0
    }

    /** Call once per game hour after the economy updated (milestones.js tick). */
    fun tick() {
        hour++
        val e = economy.e
        if (!hadResidents && e.population >= 5) {
            hadResidents = true
            notifications.add(Pair("info", "First residents"))
        }
        val next = MILESTONES.getOrNull(index + 1)
        if (next != null && e.population >= next.population) {
            index++
            e.money += next.reward
            notifications.add(Pair("milestone", "Milestone: ${next.name}"))
        }
        update()

        // alerts
        val pop = e.population
        val cov = e.coverage
        val alerts = ArrayList<String>()
        fun check(key: String, cond: Boolean) {
            if (!cond) { activeAlerts.remove(key); return }
            alerts.add(key)
            if (activeAlerts.contains(key)) return
            val until = alertTimers[key] ?: 0
            if (hour < until) return
            activeAlerts.add(key)
            alertTimers[key] = hour + ALERT_COOLDOWN_HOURS
            notifications.add(Pair("alert", key))
        }
        val need = pop >= 20
        check("power", need && cov["power"]!! < 0.5)
        check("water", need && cov["water"]!! < 0.5)
        check("sewage", need && cov["sewage"]!! < 0.5)
        check("garbage", pop >= 250 && cov["garbage"]!! < 0.5)
        check("health", pop >= 500 && cov["health"]!! < 0.4)
        check("education", pop >= 700 && cov["education"]!! < 0.4)
        check("safety", pop >= 400 && (cov["police"]!! < 0.4 || cov["fire"]!! < 0.4))
        check("unemployment", pop >= 200 && e.unemployment > 0.15)
        check("jobs", pop >= 200 && e.jobs > 60 && e.unemployment < 0.05 && e.jobs > e.residentialCapacity * 0.62 * 1.25)
        check("happiness", pop >= 100 && e.happiness < 0.4)
        check("deficit", e.net < 0 && e.money < 60000)
        check("bankrupt", e.money < 0)
        e.alerts.clear()
        e.alerts.addAll(alerts)
    }
}
