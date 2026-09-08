package com.fablecities.android.worldgen

import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Bit-exact port of effects/SmokeSystem.js — the GPU ring-buffer puff system: industrial smoke,
 * steam, house chimney smoke, construction dust. All motion is evaluated in the vertex shader from
 * static per-particle attributes and uTime; the CPU only rebuilds the instance buffers when the
 * emitter list changes (the site's `SmokeSystem.build`), so this file holds the DATA half:
 *
 *  - PUFF_KINDS / countFor / build: identical rng call order (makeRng(seed ^ 0x3ffec7) on the web
 *    side is handed in by the caller), identical budget thinning (opacity compensated), identical
 *    burst clustering for dust, identical optical-density plumbing.
 *  - makeSmokeAtlas (effects/sprites.js): the 4×4 cauliflower-cluster lobe atlas — RGB is the
 *    lobe pseudo-normal, A the coverage; built with the site's own SimplexNoise fbm2D + mulberry32.
 *
 * Emitter scan (effects/index.js rebuild()): the recorded-stack path (b.stacks / b.vents published
 * by the buildings module) is ported as-is — the native industrial blocks publish the same
 * {x,y,z,r} stack records and {x,y,z} vent records; the res-low cold chimney path and the legacy
 * no-metadata fallback follow the web's branch order and rng chains (hashString(id) ^ 0x1e5).
 */
object Smoke {

    // ---------------------------------------------------------------- emitter kinds (SmokeSystem.js)

    class PuffKind(
        val count: Int,
        val life0: Double, val life1: Double,
        val rise0: Double, val rise1: Double,
        val lateral: Double,
        val size0: Double, val size1: Double,
        val albedo: DoubleArray,
        val opacity: Double,
        val drag: Double,
        val buoyancy: Double,
        val rot: Double,
        val jitter: Double,
        val sprites0: Int, val sprites1: Int,
        val kind: Int,           // 0 smoke/steam, 1 dust
        val dens: Double,
        val bursts: Int = 0,
    )

    val INDUSTRIAL = PuffKind(360, 6.5, 12.0, 3.4, 4.8, 0.34, 1.45, 7.6,
        doubleArrayOf(0.295, 0.276, 0.252), 1.0, 0.22, 0.10, 0.12, 0.26, 0, 16, 0, 1.0)
    val STEAM = PuffKind(90, 2.2, 4.2, 3.0, 4.2, 0.28, 0.55, 4.2,
        doubleArrayOf(0.90, 0.91, 0.94), 0.46, 0.7, 0.1, 0.3, 0.22, 0, 16, 0, 0.18)
    val CHIMNEY = PuffKind(110, 3.6, 7.0, 1.7, 2.6, 0.18, 0.34, 3.6,
        doubleArrayOf(0.415, 0.402, 0.386), 0.88, 0.55, 0.06, 0.3, 0.14, 0, 16, 0, 0.80)
    val DUST = PuffKind(150, 2.6, 5.5, 0.35, 1.0, 1.5, 1.5, 4.6,
        doubleArrayOf(0.55, 0.455, 0.325), 0.62, 1.0, -0.05, 0.2, 1.0, 0, 16, 1, 0.72, bursts = 5)
    val EXHAUST = PuffKind(14, 1.0, 1.8, 0.6, 1.0, 0.4, 0.18, 1.0,
        doubleArrayOf(0.42, 0.41, 0.40), 0.34, 1.5, 0.02, 0.4, 0.13, 0, 16, 0, 0.8)

    fun kindOf(e: Emitter): PuffKind = when (e.kind) {
        "steam" -> STEAM
        "chimney" -> CHIMNEY
        "dust" -> DUST
        "exhaust" -> EXHAUST
        else -> INDUSTRIAL
    }

    /** One emitter — the web's plain object { kind, x, y, z, scale?, density?, opacity?, rect?, albedo?, dens? }. */
    class Emitter(
        val kind: String,
        val x: Double, val y: Double, val z: Double,
        val scale: Double = 1.0,
        val density: Double = 1.0,
        val opacity: Double = -1.0,          // NaN semantics of the web `??` handled by the -1 sentinel
        val rectW: Double = 0.0, val rectD: Double = 0.0, val rectYaw: Double = 0.0, // 0,0,0 = no rect
        val albedo: DoubleArray? = null,
        val dens: Double = -1.0,
    )

    /** The web's SmokeSystem.countFor(e). */
    fun countFor(e: Emitter): Int {
        val k = kindOf(e)
        val scale = e.scale
        return maxOf(1, Math.round(k.count * Math.pow(scale, 1.3) * e.density).toInt())
    }

    // ---------------------------------------------------------------- build (bit-exact)

    class Buffers(
        val origin: FloatArray,
        val vel: FloatArray,
        val param: FloatArray,
        val style: FloatArray,
        val color: FloatArray,
        val kd: FloatArray,
        val count: Int,
    )

    /** The web's SmokeSystem.build(emitters, rng) — same rng call order, same thinning, same fields. */
    fun build(emitters: List<Emitter>, rng: Rng, max: Int): Buffers {
        var want = 0
        for (e in emitters) want += countFor(e)
        val budget = if (want > max) max.toDouble() / want else 1.0
        var i = 0
        val o = FloatArray(max * 3); val v = FloatArray(max * 3); val p = FloatArray(max * 4)
        val s = FloatArray(max * 4); val c = FloatArray(max * 4); val kd = FloatArray(max * 2)
        for (e in emitters) {
            val k = kindOf(e)
            val scale = e.scale
            val n = maxOf(1, Math.round(countFor(e) * budget).toInt())
            val sizeK = Math.pow(scale, 0.6)
            val bursts = k.bursts
            val opacityK = min(1.6, 1.0 / sqrt(budget))
            var j = 0
            while (j < n && i < max) {
                // spawn jitter: dust spawns on the footprint perimeter, others in a small disc (stack mouth)
                var ox = e.x; var oy = e.y; var oz = e.z
                if (e.rectW != 0.0 || e.rectD != 0.0) {
                    val w = e.rectW; val d = e.rectD; val yaw = e.rectYaw
                    val side = rng.int(0, 3)
                    val t = rng.next() * 2 - 1
                    val lx = if (side == 0) t * w * 0.5 else if (side == 1) t * w * 0.5 else if (side == 2) w * 0.5 else -w * 0.5
                    val lz = if (side == 0) d * 0.5 else if (side == 1) -d * 0.5 else t * d * 0.5
                    val cy = cos(yaw); val sy = sin(yaw)
                    ox += lx * cy - lz * sy
                    oz += lx * sy + lz * cy
                } else {
                    val a = rng.next() * Math.PI * 2
                    val r = sqrt(rng.next()) * k.jitter * sqrt(scale)
                    ox += cos(a) * r; oz += sin(a) * r
                }
                o[i * 3] = ox.toFloat(); o[i * 3 + 1] = oy.toFloat(); o[i * 3 + 2] = oz.toFloat()
                val rise = rng.range(k.rise0, k.rise1) * (0.65 + 0.35 * scale)
                val la = rng.next() * Math.PI * 2
                val lr = k.lateral * (0.3 + rng.next() * 0.7)
                var vx = cos(la) * lr; var vz = sin(la) * lr
                if (e.rectW != 0.0 || e.rectD != 0.0) { // dust: push outwards from the centre
                    val dx = ox - e.x; val dz = oz - e.z
                    val l = v8Hypot(dx, dz)
                    val ll = if (l == 0.0) 1.0 else l
                    vx += (dx / ll) * k.lateral * 0.8; vz += (dz / ll) * k.lateral * 0.8
                }
                v[i * 3] = vx.toFloat(); v[i * 3 + 1] = rise.toFloat(); v[i * 3 + 2] = vz.toFloat()
                val life = rng.range(k.life0, k.life1) * rng.range(0.85, 1.25) * (0.8 + 0.2 * scale)
                // bursts (dust): phases cluster into a few groups so puffs come off the machinery in gusts
                p[i * 4] = (if (bursts != 0) (rng.int(0, bursts - 1) + rng.next() * 0.22) / bursts else rng.next()).toFloat()
                p[i * 4 + 1] = life.toFloat()
                p[i * 4 + 2] = (k.size0 * sizeK * rng.range(0.75, 1.25)).toFloat()
                p[i * 4 + 3] = (k.size1 * sizeK * rng.range(0.7, 1.35)).toFloat()
                s[i * 4] = rng.int(k.sprites0, k.sprites1 - 1).toFloat()
                s[i * 4 + 1] = ((if (rng.next() < 0.5) -1.0 else 1.0) * k.rot * rng.range(0.5, 1.2)).toFloat()
                s[i * 4 + 2] = (k.buoyancy * scale).toFloat()
                s[i * 4 + 3] = k.drag.toFloat()
                val tint = 0.92 + rng.next() * 0.16
                val alb = e.albedo ?: k.albedo
                c[i * 4] = (alb[0] * tint).toFloat(); c[i * 4 + 1] = (alb[1] * tint).toFloat(); c[i * 4 + 2] = (alb[2] * tint).toFloat()
                val op = if (e.opacity >= 0.0) e.opacity else k.opacity
                c[i * 4 + 3] = min(1.0, op * rng.range(0.8, 1.15) * opacityK).toFloat()
                kd[i * 2] = k.kind.toFloat()
                kd[i * 2 + 1] = (if (e.dens >= 0.0) e.dens else k.dens).toFloat()
                i++
                j++
            }
            if (i >= max) break
        }
        return Buffers(o, v, p, s, c, kd, i)
    }

    // ---------------------------------------------------------------- makeSmokeAtlas (sprites.js)

    /**
     * 4×4 cauliflower lobe atlas: RGB = lobe pseudo-normal, A = coverage. Same rng/noise call
     * order as effects/sprites.js makeSmokeAtlas — pinned by SmokeParityTest checksums.
     */
    fun makeSmokeAtlas(seed: Int, cell: Int = 128, cols: Int = 4, rows: Int = 4): ByteArray {
        val w = cell * cols; val h = cell * rows
        val data = ByteArray(w * h * 4)
        val noise = SimplexNoise(seed xor 0x5a0ce)
        val rng = Rng(seed xor 0x51)
        val height = FloatArray(cell * cell)

        for (py in 0 until rows) {
            for (px in 0 until cols) {
                // cauliflower cluster: a dense centre lobe + 5-9 satellite lobes
                val bx = DoubleArray(10); val by = DoubleArray(10); val bs = DoubleArray(10)
                val n = 6 + rng.int(0, 4)
                for (i in 0 until n) {
                    val a = rng.next() * Math.PI * 2
                    val r = if (i == 0) 0.0 else 0.09 + rng.next() * 0.25
                    bx[i] = 0.5 + cos(a) * r; by[i] = 0.5 + sin(a) * r
                    bs[i] = if (i == 0) 0.28 else 0.11 + rng.next() * 0.15
                }
                val nOff = rng.next() * 100
                val freq = 3.0 + rng.next() * 2.0
                val erode = 0.40 + rng.next() * 0.16
                for (y in 0 until cell) {
                    for (x in 0 until cell) {
                        val u = (x + 0.5) / cell; val vv = (y + 0.5) / cell
                        var d = 0.0
                        for (i in 0 until n) {
                            val dx = u - bx[i]; val dy = vv - by[i]
                            val q = sqrt(dx * dx + dy * dy) / bs[i]
                            d += maxOf(0.0, 1 - q * q)
                        }
                        // 3-octave erosion field + a fine wisp octave
                        val fb = noise.fbm2D(u * freq + nOff, vv * freq + nOff * 0.7, 3, 2.15, 0.55)
                        val fine = noise.fbm2D(u * freq * 3.1 + nOff * 1.9, vv * freq * 3.1 + nOff * 0.3, 2, 2.0, 0.5)
                        val field = Environment.clamp01(d * 0.8) * (0.55 + 0.45 * (fb * 0.5 + 0.5))
                        // threshold erosion: interior breaks into lobes; edges get ragged
                        var hh = Environment.smoothstep(erode * (0.6 - fb * 0.35), 1.0, field + fine * 0.16)
                        val cx = u - 0.5; val cy = vv - 0.5
                        val rr = sqrt(cx * cx + cy * cy) * 2
                        hh *= 1 - Environment.smoothstep(0.72 + fine * 0.1, 0.98, rr)
                        height[y * cell + x] = Environment.clamp01(hh).toFloat()
                    }
                }
                for (y in 0 until cell) {
                    for (x in 0 until cell) {
                        val idx = y * cell + x
                        val hv = height[idx].toDouble()
                        val hl = height[y * cell + maxOf(0, x - 1)].toDouble()
                        val hr = height[y * cell + min(cell - 1, x + 1)].toDouble()
                        val hd = height[maxOf(0, y - 1) * cell + x].toDouble()
                        val hu = height[min(cell - 1, y + 1) * cell + x].toDouble()
                        // lobe normals blended with a sphere normal: every roll has a sun side
                        var nx = (hl - hr) * 7.0 * cell / 256
                        var ny = (hd - hu) * 7.0 * cell / 256
                        var nz = 1.0
                        val cx = (x + 0.5) / cell - 0.5; val cy = (y + 0.5) / cell - 0.5
                        val sr = min(1.0, sqrt(cx * cx + cy * cy) * 2.2)
                        val sz = sqrt(maxOf(0.0, 1 - sr * sr))
                        nx = nx * 0.85 + cx * 2.2 * 0.65
                        ny = ny * 0.85 + cy * 2.2 * 0.65
                        nz = nz * 0.85 + sz * 0.65
                        val len = v8Hypot3(nx, ny, nz).let { if (it == 0.0) 1.0 else it }
                        nx /= len; ny /= len; nz /= len
                        // dense core, thin ragged fringe
                        val alpha = Math.pow(Environment.smoothstep(0.0, 0.82, hv), 1.1)
                        val o = ((py * cell + y) * w + (px * cell + x)) * 4
                        data[o] = Math.round((nx * 0.5 + 0.5) * 255).toByte()
                        data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255).toByte()
                        data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255).toByte()
                        data[o + 3] = Math.round(alpha * 255).toByte()
                    }
                }
            }
        }
        return data
    }

    // ---------------------------------------------------------------- emitter scan (effects/index.js rebuild)

    /** A stack record published by an industrial building ({x,y,z,r} in world space, y = top). */
    class StackRec(val x: Double, val y: Double, val z: Double, val r: Double)
    class VentRec(val x: Double, val y: Double, val z: Double)

    /**
     * The web rebuild() scan against the native block model. Blocks are (x,z,w,d,yaw,h,type-kind,
     * stacks?,vents?) addressed as "demo:<index>" (the web hashes String(b.id)). Recorded-stack
     * industrial path first, then the res-low cold chimney path, then the legacy no-metadata guess
     * — the web's exact branch order. Construction dust has no native construction state (buildings
     * appear complete), which the web scan treats as `continue` as well.
     */
    fun scanEmitters(
        blocks: List<IndBlock>,
        seed: Int,
        cold: Boolean,
    ): MutableList<Emitter> {
        val industrial = ArrayList<Emitter>()
        val steam = ArrayList<Emitter>()
        val chimney = ArrayList<Emitter>()
        for ((bi, b) in blocks.withIndex()) {
            val rng = Rng(PuddleField.fnv("demo:$bi") xor 0x1e5)
            val w = b.w; val d = b.d; val yaw = b.yaw
            val level = b.level; val h = b.h
            val by = b.y
            val type = b.type // "ind" | "res-low" | "com-low" | "com-high" | "office" | ...
            if (type == "ind") {
                val recorded = b.stacks
                val vents = b.vents
                if ((recorded != null && recorded.isNotEmpty()) || (vents != null && vents.isNotEmpty())) {
                    if (recorded != null) {
                        for (st in recorded) {
                            val scale = (st.r / 1.0).coerceIn(0.6, 2.0) * (0.80 + level * 0.10)
                            industrial.add(Emitter("industrial", st.x, st.y + 0.3, st.z, scale = scale, density = 1.0))
                        }
                    }
                    if (vents != null && vents.isNotEmpty()) {
                        val flue = if ((recorded != null && recorded.isNotEmpty()) || level < 2) -1 else rng.int(0, vents.size - 1)
                        for (vi in vents.indices) {
                            val vt = vents[vi]
                            val vy = vt.y + 0.35
                            if (vi == flue) {
                                chimney.add(Emitter("chimney", vt.x, vy, vt.z, scale = 0.55 + level * 0.09))
                            } else if (rng.next() < 0.18) {
                                steam.add(Emitter("steam", vt.x, vy, vt.z, scale = 0.34, density = 0.45, opacity = 0.20))
                            }
                        }
                    }
                    continue
                }
                // legacy fallback (no recorded stacks): guess ONE stack, only for the bigger plants
                if (level >= 3 && rng.next() < 0.55) {
                    val lx = (rng.next() * 0.6 - 0.3) * w; val lz = (rng.next() * 0.6 - 0.3) * d
                    val cy = cos(yaw); val sy = sin(yaw)
                    val x = b.x + lx * cy - lz * sy; val z = b.z + lx * sy + lz * cy
                    val y = by + h + 1.2
                    val scale = 0.62 + level * 0.12
                    industrial.add(Emitter("industrial", x, y, z, scale = scale, density = 1.0))
                } else if (level >= 2 && rng.next() < 0.34) {
                    val lx = (rng.next() * 0.5 - 0.25) * w; val lz = (rng.next() * 0.5 - 0.25) * d
                    val cy = cos(yaw); val sy = sin(yaw)
                    steam.add(Emitter("steam", b.x + lx * cy - lz * sy, by + h + 0.6, b.z + lx * sy + lz * cy, scale = 0.55, density = 0.6))
                }
                continue
            }
            if (type.startsWith("res") && (type.contains("low") || level <= 2) && !type.contains("high")) {
                if (cold && rng.next() < 0.7) {
                    val lx = (rng.next() * 0.5 - 0.25) * w; val lz = (rng.next() * 0.4 - 0.2) * d
                    val cy = cos(yaw); val sy = sin(yaw)
                    chimney.add(Emitter("chimney", b.x + lx * cy - lz * sy, by + h + 0.6, b.z + lx * sy + lz * cy,
                        scale = 1.05 + rng.next() * 0.35))
                }
                continue
            }
            if ((type.contains("high") || type.startsWith("office") || type.startsWith("com")) && level >= 2) {
                val vents = b.vents
                if (vents != null && vents.isNotEmpty()) {
                    for (vt in vents) {
                        if (rng.next() > 0.22) continue
                        steam.add(Emitter("steam", vt.x, vt.y + 0.35, vt.z, scale = 0.4, density = 0.4, opacity = 0.22))
                    }
                }
                // No guessed plume when `vents` is absent (docs/requests/buildings.md #1).
            }
        }
        val emitters = ArrayList<Emitter>(industrial.size + steam.size + chimney.size)
        emitters.addAll(industrial)
        emitters.addAll(steam)
        emitters.addAll(chimney)
        return emitters
    }

    /** What the renderer needs to know about a block for the scan (the web's building record subset). */
    class IndBlock(
        val x: Double, val y: Double, val z: Double,
        val w: Double, val d: Double, val h: Double,
        val yaw: Double,
        val level: Int,
        val type: String,
        val stacks: List<StackRec>? = null,
        val vents: List<VentRec>? = null,
    )

    /** Buffers → interleaved instance upload layouts (the renderer's 6 instance VBOs). */
    fun interleave(b: Buffers): Array<FloatArray> {
        val n = b.count
        val origin = FloatArray(n * 3); System.arraycopy(b.origin, 0, origin, 0, n * 3)
        val vel = FloatArray(n * 3); System.arraycopy(b.vel, 0, vel, 0, n * 3)
        val param = FloatArray(n * 4); System.arraycopy(b.param, 0, param, 0, n * 4)
        val style = FloatArray(n * 4); System.arraycopy(b.style, 0, style, 0, n * 4)
        val color = FloatArray(n * 4); System.arraycopy(b.color, 0, color, 0, n * 4)
        val kind = FloatArray(n * 2); System.arraycopy(b.kd, 0, kind, 0, n * 2)
        return arrayOf(origin, vel, param, style, color, kind)
    }
}
