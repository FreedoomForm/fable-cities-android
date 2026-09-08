package com.fablecities.android.worldgen

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the effect-sprite generators (Sprites.kt — the effects/sprites.js port) and the
 * VehicleSpray seed layout against tools/probe_sprites.mjs running the REAL web modules.
 */
class SprayParityTest {

    private fun expect(name: String, goldens: DoubleArray, got: ByteArray, idx: IntArray, ch: Int, chIdx: Int) {
        var sum = 0
        for (b in got) sum += (b.toInt() and 0xff)
        assertTrue("$name checksum $sum != $chIdx($ch)", sum == ch)
        for ((k, i) in idx.withIndex()) {
            val v = (got[i * 4 + 3].toInt() and 0xff).toDouble()
            assertTrue("$name alpha[$i] $v != ${goldens[k]}", v == goldens[k])
        }
    }

    @Test
    fun spritesMatchWeb() {
        val spray = Sprites.makeSpray(1337)
        expect("spray", SprayGoldens.SPRAY_ALPHA, spray, SprayGoldens.SPRAY_IDX,
            3193836, SprayGoldens.SPRAY_CHECKSUM.toInt())
        val ring = Sprites.makeRing(64)
        var rs = 0
        for (b in ring) rs += (b.toInt() and 0xff)
        assertTrue("ring checksum", rs == SprayGoldens.RING_CHECKSUM.toInt())
        for ((k, i) in SprayGoldens.RING_IDX.withIndex()) {
            val v = (ring[i * 4 + 3].toInt() and 0xff).toDouble()
            assertTrue("ring alpha[$i]", v == SprayGoldens.RING_ALPHA[k])
        }
        val flake = Sprites.makeSnowflake(32)
        var fs = 0
        for (b in flake) fs += (b.toInt() and 0xff)
        assertTrue("flake checksum", fs == SprayGoldens.FLAKE_CHECKSUM.toInt())
        val streak = Sprites.makeRainStreak(32, 256)
        var ss = 0
        for (b in streak) ss += (b.toInt() and 0xff)
        assertTrue("streak checksum", ss == SprayGoldens.STREAK_CHECKSUM.toInt())
    }

    @Test
    fun spraySeedBlockMatchesWeb() {
        val block = Sprites.spraySeedBlock(5, 7)
        for ((k, i) in SprayGoldens.SEED_IDX.withIndex()) {
            val got = block[i].toDouble()
            val want = SprayGoldens.SEED_BLOCK[k]
            // float32 round-trip: the web writes into a Float32Array, compare as float bits
            val gotF = got.toFloat().toDouble()
            assertTrue("seed[$i] $gotF != $want", Math.abs(gotF - want) < 1e-9)
        }
    }
}
