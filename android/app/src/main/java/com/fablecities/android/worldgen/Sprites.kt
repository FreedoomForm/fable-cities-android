package com.fablecities.android.worldgen

/**
 * Bit-exact port of the procedural effect sprites (effects/sprites.js): the vehicle-spray
 * crown, the rain-impact ring, the snowflake and the rain streak. All alpha-only RGBA8,
 * flipY=false (row 0 = the sprite bottom), pinned by SprayParityTest against
 * tools/probe_sprites.mjs running the REAL modules.
 */
object Sprites {

    private fun clamp01(v: Double): Double = if (v < 0.0) 0.0 else if (v > 1.0) 1.0 else v
    private fun smoothstep(x: Double, y: Double, t0: Double): Double {
        val t = if (t0 < x) 0.0 else if (t0 > y) 1.0 else (t0 - x) / (y - x)
        return t * t * (3.0 - 2.0 * t)
    }

    /** makeSpray: a short arc of droplets + spray haze + the impact bead. 64×64. */
    fun makeSpray(seed: Int, size: Int = 64): ByteArray {
        val data = ByteArray(size * size * 4)
        val rng = Rng(seed xor 0x5b1a5)
        class Drop(val x: Double, val y: Double, val s: Double)
        val drops = ArrayList<Drop>()
        val n = 5 + rng.int(0, 2)
        for (i in 0 until n) {
            val a = (i + 0.5) / n * Math.PI * 0.9 + Math.PI * 0.05 + (rng.next() - 0.5) * 0.25
            val r = 0.28 + rng.next() * 0.16
            drops.add(Drop(0.5 + Math.cos(a) * r, 0.15 + Math.sin(a) * r, 0.035 + rng.next() * 0.03))
        }
        for (y in 0 until size) {
            for (x in 0 until size) {
                val u = (x + 0.5) / size
                val v = (y + 0.5) / size   // v grows upward (row 0 = bottom)
                var a = 0.0
                for (p in drops) {
                    val q = v8Hypot(u - p.x, v - p.y) / p.s
                    val t = 1.0 - q * q
                    a += if (t > 0.0) t else 0.0
                }
                val dx = (u - 0.5)
                val dy = v - 0.12
                val rr = v8Hypot(dx, dy * 1.2)
                val haze = (if (1.0 - rr / 0.46 > 0.0) 1.0 - rr / 0.46 else 0.0) * smoothstep(-0.02, 0.1, dy) * 0.26
                val bead = Math.exp(-Math.pow(rr / 0.095, 2.0)) * 0.7
                a = clamp01(a * 0.8 + haze + bead)
                val o = (y * size + x) * 4
                data[o] = 255.toByte(); data[o + 1] = 255.toByte(); data[o + 2] = 255.toByte()
                data[o + 3] = Math.round(a * 255.0).toByte()
            }
        }
        return data
    }

    /** makeRing: fat rim + faint inner — the rain-impact ring (puddles only). */
    fun makeRing(size: Int = 64): ByteArray {
        val data = ByteArray(size * size * 4)
        for (y in 0 until size) {
            for (x in 0 until size) {
                val dx = (x + 0.5) / size - 0.5
                val dy = (y + 0.5) / size - 0.5
                val r = Math.sqrt(dx * dx + dy * dy) * 2.0
                val rim = Math.exp(-Math.pow((r - 0.68) / 0.2, 2.0))
                val inner = Math.exp(-Math.pow((r - 0.36) / 0.12, 2.0)) * 0.5
                val a = clamp01(rim + inner) * (1.0 - smoothstep(0.86, 1.0, r))
                val o = (y * size + x) * 4
                data[o] = 255.toByte(); data[o + 1] = 255.toByte(); data[o + 2] = 255.toByte()
                data[o + 3] = Math.round(a * 255.0).toByte()
            }
        }
        return data
    }

    /** makeSnowflake: soft irregular flake (dense core + halo + slightly brighter rim). */
    fun makeSnowflake(size: Int = 32): ByteArray {
        val data = ByteArray(size * size * 4)
        for (y in 0 until size) {
            for (x in 0 until size) {
                val dx = (x + 0.5) / size - 0.5
                val dy = (y + 0.5) / size - 0.5
                val r = Math.sqrt(dx * dx + dy * dy) * 2.0
                val ang = Math.atan2(dy, dx)
                val wob = 1.0 + 0.06 * Math.sin(ang * 5 + 0.7) + 0.04 * Math.sin(ang * 3)
                val q = r / wob
                val a = clamp01((1.0 - smoothstep(0.20, 0.62, q)) * 0.92 + (1.0 - smoothstep(0.55, 1.0, q)) * 0.30)
                val o = (y * size + x) * 4
                data[o] = 255.toByte(); data[o + 1] = 255.toByte(); data[o + 2] = 255.toByte()
                data[o + 3] = Math.round(a * 255.0).toByte()
            }
        }
        return data
    }

    /** makeRainStreak: head-weighted gaussian drop with a stretched tail. 32×256. */
    fun makeRainStreak(w: Int = 32, h: Int = 256): ByteArray {
        val data = ByteArray(w * h * 4)
        for (y in 0 until h) {
            val v = (y + 0.5) / h
            val t = (v - 0.62) / 0.30
            val along = Math.exp(-t * t) * (0.35 + 0.65 * smoothstep(0.0, 0.30, v)) * (1.0 - smoothstep(0.90, 1.0, v))
            val wid = 0.55 + 0.45 * smoothstep(0.15, 0.75, v)
            for (x in 0 until w) {
                val u = ((x + 0.5) / w - 0.5) * 2.0 / wid
                val core = Math.exp(-u * u * 4.5)
                val a = clamp01(core * along)
                val o = (y * w + x) * 4
                data[o] = 255.toByte(); data[o + 1] = 255.toByte(); data[o + 2] = 255.toByte()
                data[o + 3] = Math.round(a * 255.0).toByte()
            }
        }
        return data
    }

    /** VehicleSpray constructor seed layout: the xorshift per-slot jitter stream. */
    fun spraySeedBlock(emitters: Int, perEmitter: Int): FloatArray {
        val seed = FloatArray(emitters * perEmitter * 4)
        var h = 0x9e3779b9.toInt()
        fun rnd(): Double {
            h = h xor (h shl 13)
            h = h xor (h ushr 17)
            h = h xor (h shl 5)
            return ((h.toLong() and 0xffffffffL) % 100000).toDouble() / 100000.0
        }
        for (e in 0 until emitters) {
            for (k in 0 until perEmitter) {
                val i = (e * perEmitter + k) * 4
                val wheel = if (k % 2 == 0) -1.0 else 1.0
                seed[i] = ((k + rnd() * 0.6) / perEmitter).toFloat()
                seed[i + 1] = (wheel * (0.62 + rnd() * 0.30)).toFloat()
                seed[i + 2] = (0.40 + rnd() * 0.44).toFloat()
                seed[i + 3] = rnd().toFloat()
            }
        }
        return seed
    }
}
