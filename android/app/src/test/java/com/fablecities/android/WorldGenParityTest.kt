package com.fablecities.android

import com.fablecities.android.worldgen.Heightmap
import com.fablecities.android.worldgen.Rng
import com.fablecities.android.worldgen.SimplexNoise
import com.fablecities.android.worldgen.hash2Unsigned
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import kotlin.math.abs

/**
 * Bit-parity golden tests against the REAL browser world generator
 * (src/shared/random.js + src/shared/noise.js + src/modules/terrain/Heightmap.js).
 * Every expected value below was produced by running the actual web code in Node with
 * seed 1337 (the game's default menu seed) — tools: /scripts probe run documented in
 * the worklog. The native app must generate the SAME world as the site.
 */
class WorldGenParityTest {

    private fun assertNear(actual: Double, expected: Double, tol: Double, what: String) {
        val ok = abs(actual - expected) <= tol
        assert(ok) { "$what: expected $expected, got $actual (diff ${actual - expected})" }
    }

    @Test
    fun mulberry32_bitParity() {
        val rng = Rng(1337)
        val expected = doubleArrayOf(
            0.1844118325971067, 0.18998925131745636, 0.8104719922412187,
            0.6437488221563399, 0.430774615611881,
        )
        for (e in expected) assertEquals(e, rng.next(), 0.0)
    }

    @Test
    fun hash2_bitParity() {
        assertEquals(1987620549L, hash2Unsigned(1337, 7))
        assertEquals(1007616808L, hash2Unsigned(1, 2))
        assertEquals(4020748216L, hash2Unsigned(123456, 654321))
    }

    @Test
    fun simplex_bitParity() {
        val sn = SimplexNoise(9386) // 1337*7+1 — the terrain's nBase field
        assertNear(sn.noise2D(0.5, -1.25), -0.500739659204, 1e-9, "noise2D#1")
        assertNear(sn.noise2D(100.7, 3.1), 0.169104704617, 1e-9, "noise2D#2")
        assertNear(sn.noise2D(-45.3, 88.8), -0.572158519474, 1e-9, "noise2D#3")
        assertNear(sn.fbm2D(12.4, -7.9, 3), 0.256016964848, 1e-9, "fbm2D")
        assertNear(sn.ridged2D(3.3, 9.9, 3, 2.0, 0.55), 0.521043642002, 1e-9, "ridged2D")
    }

    @Test
    fun heightmap_sampleGen_bitParity() {
        val hm = Heightmap(size = 2048, spacing = 2, seed = 1337)
        // analytic probes taken straight from the web sampleGen(x, z, 0)
        val probes = arrayOf(
            doubleArrayOf(-900.0, -1700.0, 200.333300242),
            doubleArrayOf(-780.0, -820.0, 139.412898525),
            doubleArrayOf(-660.0, -1620.0, 75.632464258),
            doubleArrayOf(-540.0, -740.0, 85.702917306),
            doubleArrayOf(-420.0, -1540.0, 4.01928666),
            doubleArrayOf(-300.0, -660.0, -0.826261088),
            doubleArrayOf(-180.0, -1460.0, 6.478435278),
            doubleArrayOf(-60.0, -580.0, 8.303157922),
            doubleArrayOf(60.0, -1380.0, 81.858584899),
            doubleArrayOf(180.0, -500.0, 7.023965552),
            doubleArrayOf(300.0, -1300.0, 140.061581757),
            doubleArrayOf(420.0, -420.0, 17.50972029),
            doubleArrayOf(540.0, -1220.0, 129.548559822),
            doubleArrayOf(660.0, -340.0, 23.627855371),
            doubleArrayOf(780.0, -1140.0, 121.096913678),
            doubleArrayOf(900.0, -260.0, 25.889623211),
        )
        for (p in probes) assertNear(hm.sampleGen(p[0], p[1], 0), p[2], 1e-6, "sampleGen(${p[0]},${p[1]})")
    }

    @Test
    fun heightmap_generate_2048x4_matchesWeb() {
        // the runtime config the native renderer ships (2048 m world, 4 m grid)
        val hm = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()
        assertNear(hm.minH, -20.8046, 1e-3, "minH")
        assertNear(hm.maxH, 244.9784, 1e-3, "maxH")
        val probes = arrayOf(0.0 to 0.0, 120.0 to 0.0, -420.0 to 300.0, 600.0 to -600.0, 0.0 to 800.0)
        val expected = doubleArrayOf(8.8625, 13.5566, 4.5565, 11.7448, -5.9879)
        for (i in probes.indices) assertNear(hm.getHeight(probes[i].first, probes[i].second), expected[i], 1e-3, "getHeight(${probes[i].first},${probes[i].second})")
    }

    @Test
    fun heightmap_conformPath_matchesWeb() {
        // the road-corridor mechanism (the site's roads use the same conformPath)
        val hm = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()
        val pts = ArrayList<Heightmap.PathPoint>()
        var z = -300.0
        while (z <= 300.0) {
            pts.add(Heightmap.PathPoint(120.0, hm.getHeight(120.0, z) + 0.4, z))
            z += 20.0
        }
        val b = hm.conformPath(pts, 22.0, 20.0)
        assertNotNull(b)
        assertEquals(278, b!![0])
        assertEquals(294, b[1])
        assertEquals(173, b[2])
        assertEquals(339, b[3])
        val after = doubleArrayOf(13.9566, 27.7832, 9.836)
        val qs = arrayOf(0.0 to 0.0, 120.0 to 120.0, 120.0 to -240.0)
        for (i in qs.indices) assertNear(hm.getHeight(qs[i].first, qs[i].second), after[i], 1e-3, "conformed(${qs[i].first},${qs[i].second})")
    }
}
