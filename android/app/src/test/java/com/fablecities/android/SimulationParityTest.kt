package com.fablecities.android

import com.fablecities.android.worldgen.Rng
import com.fablecities.android.worldgen.SimBuilding
import com.fablecities.android.worldgen.SimEconomy
import com.fablecities.android.worldgen.SimGoldens
import com.fablecities.android.worldgen.SimIds
import com.fablecities.android.worldgen.SimMilestones
import com.fablecities.android.worldgen.SimServices
import com.fablecities.android.worldgen.hash2Signed
import com.fablecities.android.worldgen.simHashString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Bit-parity golden tests against the REAL browser simulation modules
 * (src/modules/simulation/services.js + economy.js + milestones.js), run headless
 * in Node (scripts/probe_sim.mjs) on a synthetic village driven for 336 game hours
 * with the site's own simulation RNG chain:
 *   world.rng.fork(hashString('simulation')) = makeRng(hash2(1337, hashString('simulation'))).
 * The native city must run the SAME economy as the site.
 */
class SimulationParityTest {

    private fun near(actual: Double, expected: Double, tol: Double, what: String) {
        assertTrue(
            "$what: expected $expected, got $actual (diff ${actual - expected})",
            abs(actual - expected) <= tol
        )
    }

    private fun buildWorld(): Triple<ArrayList<SimBuilding>, SimServices, Rng> {
        val village = ArrayList<SimBuilding>()
        var id = 0
        fun mk(type: String, x: Double, z: Double, w: Double, d: Double, h: Double) {
            village.add(SimBuilding("b" + (id++), type, x, z, w, d, h))
        }
        for (i in 0 until 6) mk("res_low", -240.0 + (i % 3) * 88.0, -180.0 + (i / 3) * 88.0, 22.0, 16.0, 8.0)
        for (i in 0 until 4) mk("res_high", 44.0 + (i % 2) * 88.0, -180.0 + (i / 2) * 88.0, 24.0, 24.0, 34.0)
        for (i in 0 until 4) mk("com", -96.0 + i * 88.0, -4.0, 20.0, 18.0, 12.0)
        for (i in 0 until 2) mk("ind", -320.0 + i * 96.0, 88.0, 40.0, 32.0, 14.0)
        mk("office", 132.0, 92.0, 20.0, 20.0, 26.0)
        val services = SimServices(1024.0, 2048.0)
        val simSeed = hash2Signed(1337, simHashString("simulation"))
        return Triple(village, services, Rng(simSeed))
    }

    private fun placeFree(services: SimServices) {
        val sink = doubleArrayOf(0.0)
        services.place("power", -520.0, -60.0, 5.0, true, sink)
        services.place("water", -160.0, -120.0, 5.0, true, sink)
        services.place("sewage", -560.0, 160.0, 5.0, true, sink)
        services.place("garbage", -600.0, -220.0, 5.0, true, sink)
    }

    @Test
    fun simulationSeed_chain() {
        // makeRng(1337).fork(hashString('simulation')) — the unsigned hash the web seeds
        val seed = hash2Signed(1337, simHashString("simulation")).toLong() and 0xFFFFFFFFL
        assertEquals(SimGoldens.simSeed.toLong(), seed)
    }

    @Test
    fun economy_336hours_bitParity() {
        val (village, services, rng) = buildWorld()
        placeFree(services)
        val economy = SimEconomy(village, services, rng)
        val milestones = SimMilestones(economy)
        economy.recomputeRates()

        val checkpoints = intArrayOf(24, 72, 168, 336)
        var cpIdx = 0
        for (h in 1..336) {
            economy.totalDays = (h - 1) / 24
            for (m in 0 until 60) {
                val ranHour = economy.minute()
                if (ranHour) milestones.tick()
            }
            if (cpIdx < checkpoints.size && h == checkpoints[cpIdx]) {
                val g = SimGoldens.checkpoints.getValue(checkpoints[cpIdx])
                val e = economy.e
                near(e.money, g.money, 1e-6, "h$h money")
                assertEquals("h$h population", g.population, e.population)
                assertEquals("h$h households", g.households, e.households)
                near(e.happiness, g.happiness, 1e-9, "h$h happiness")
                near(e.unemployment, g.unemployment, 1e-9, "h$h unemployment")
                near(e.jobFill, g.jobFill, 1e-9, "h$h jobFill")
                assertEquals("h$h jobs", g.jobs, e.jobs)
                assertEquals("h$h jobsCom", g.jobsCom, e.jobsByClass["commercial"])
                assertEquals("h$h jobsInd", g.jobsInd, e.jobsByClass["industrial"])
                assertEquals("h$h jobsOff", g.jobsOff, e.jobsByClass["office"])
                assertEquals("h$h jobsSvc", g.jobsSvc, e.jobsByClass["services"])
                assertEquals("h$h resCap", g.residentialCapacity, e.residentialCapacity)
                near(e.demand["residential"]!!, g.dRes, 1e-9, "h$h dRes")
                near(e.demand["commercial"]!!, g.dCom, 1e-9, "h$h dCom")
                near(e.demand["industrial"]!!, g.dInd, 1e-9, "h$h dInd")
                near(e.demand["office"]!!, g.dOff, 1e-9, "h$h dOff")
                assertEquals("h$h income", g.income, e.income)
                assertEquals("h$h expenses", g.expenses, e.expenses)
                assertEquals("h$h net", g.net, e.net)
                val ids = SimIds.IDS
                val cov = doubleArrayOf(g.covPower, g.covWater, g.covSewage, g.covGarbage, g.covPolice, g.covFire, g.covHealth, g.covEducation)
                val strain = doubleArrayOf(g.strainPower, g.strainWater, g.strainSewage, g.strainGarbage, g.strainPolice, g.strainFire, g.strainHealth, g.strainEducation)
                for (k in ids.indices) {
                    near(e.coverage[ids[k]]!!, cov[k], 1e-9, "h$h cov(${ids[k]})")
                    near(services.strain[ids[k]]!!, strain[k], 1e-9, "h$h strain(${ids[k]})")
                }
                near(e.pollution, g.pollution, 1e-9, "h$h pollution")
                near(e.education, g.education, 1e-9, "h$h education")
                near(e.landValue, g.landValue, 1e-9, "h$h landValue")
                near(e.congestion, g.congestion, 1e-9, "h$h congestion")
                assertEquals("h$h milestoneIndex", g.milestoneIndex, e.milestone.index)
                assertEquals("h$h milestoneName", g.milestoneName, e.milestone.name)
                near(e.milestone.progress, g.milestoneProgress, 1e-9, "h$h msProgress")
                assertEquals("h$h alerts", g.alerts, e.alerts)
                val b = e.budgetReport
                if (g.budgetWeek == null) {
                    assertEquals("h$h budget null", null, b)
                } else {
                    assertTrue("h$h budget present", b != null)
                    if (b != null) {
                        assertEquals("h$h budget.week", g.budgetWeek, b.week)
                        assertEquals("h$h budget.label", g.budgetLabel, b.label)
                        assertEquals("h$h budget.income", g.budgetIncome, b.income)
                        assertEquals("h$h budget.expenses", g.budgetExpenses, b.expenses)
                        assertEquals("h$h budget.net", g.budgetNet, b.net)
                    }
                }
                cpIdx++
            }
        }
    }
}
