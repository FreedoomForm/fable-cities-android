package com.fablecities.android

import android.opengl.GLES30
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.util.Log
import com.fablecities.android.worldgen.Heightmap
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.Random
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Native OpenGL ES 3.0 city renderer. Deterministic (seeded), 16:9 letterboxed viewport,
 * orbit camera, day/night cycle with emissive windows, moving vehicles, fog and water.
 * All gameplay geometry is drawn inside the letterboxed viewport; the sky fills the surface.
 */
class GlCityRenderer : GLSurfaceView.Renderer {

    interface Listener {
        fun onMessage(text: String)
        fun onCityEdited()
        fun onHourChanged(hour: Float, day: Int)
    }

    var listener: Listener? = null
    var paused = false

    // --- camera ---
    private val camTarget = floatArrayOf(40f, 14f, 0f)
    private var camYaw = 0.6f
    private var camPitch = 0.95f
    private var camDist = 320f
    private val camTargetGoal = floatArrayOf(40f, 14f, 0f)
    private var camYawGoal = 0.6f
    private var camPitchGoal = 0.95f
    private var camDistGoal = 320f

    // --- matrices ---
    private val projM = FloatArray(16)
    private val viewM = FloatArray(16)
    private val vpM = FloatArray(16)
    private val invVpM = FloatArray(16)

    // --- time of day ---
    var hour = 8f
        private set
    var day = 1

    // --- world constants: the SITE'S real world (2048 m, seed 1337, sea level 0) ---
    private val mapHalf = 1024f
    private val cityHalf = 504f // tool grid + prebuilt content extent (east of the river)
    private val waterY = 0f
    private val cellSize = 24f
    private val gridN = 42
    private lateinit var worldHeight: Heightmap

    // --- shaders ---
    private var progTerrain = 0
    private var progFlat = 0
    private var progBuilding = 0
    private var progWater = 0
    private var progSky = 0

    // --- geometry handles ---
    private var terrainVbo = 0
    private var terrainCount = 0
    private var cityGroundVbo = 0
    private var cityGroundCount = 0
    private var waterVbo = 0
    private var cubeVbo = 0
    private var carVbo = 0
    private var carCount = 0
    private var skyVbo = 0
    private var editRoadVbo = 0
    private var editRoadCount = 0
    private var editZoneVbo = 0
    private var editZoneCount = 0

    private var surfaceW = 1
    private var surfaceH = 1
    private val letterbox = FloatArray(4) // x, y, w, h in pixels

    // --- city data ---
    private class Building(
        val x: Float, val y: Float, val z: Float, val w: Float, val d: Float, val h: Float,
        val kind: Int, val yaw: Float, val seed: Int, val cell: Int, var removed: Boolean = false
    )

    private val buildings = ArrayList<Building>()
    private var selectedBuilding: Building? = null

    private class Vehicle(val route: Int, val lane: Float, var s: Float, val speed: Float, val dir: Float, val seed: Int, val color: FloatArray)

    private class RoadSeg(val x0: Float, val z0: Float, val x1: Float, val z1: Float, val hw: Float)

    private val vehicles = ArrayList<Vehicle>()
    private val roadSegs = ArrayList<RoadSeg>()
    private var cityYaw = 0f
    private lateinit var demo: DemoCity
    private val roadCells = HashSet<Int>()
    private val zoneCells = HashMap<Int, Int>() // cell -> 0 res, 1 com, 2 ind
    private var editsDirty = false
    private var lastSaveHint = 0L

    private var frameNanos = 0L
    private var glErrorLogged = false

    // ---------------------------------------------------------------- lifecycle

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)
        GLES30.glEnable(GLES30.GL_CULL_FACE)
        GLES30.glCullFace(GLES30.GL_BACK)
        GLES30.glClearColor(0.03f, 0.05f, 0.08f, 1f)

        progTerrain = buildProgram(VS_LIT, FS_LIT, "terrain")
        progFlat = buildProgram(VS_LIT, FS_LIT, "flat")
        progBuilding = buildProgram(VS_BUILDING, FS_BUILDING, "building")
        progWater = buildProgram(VS_WATER, FS_WATER, "water")
        progSky = buildProgram(VS_SKY, FS_SKY, "sky")

        // The real world: the site's 2048 m heightmap (seed 1337), then THE SITE'S demo city:
        // the shoreline-fitted site picker, block grading and the full street network
        // (motorway + trumpet interchange, downtown grid, boulevards, crescents, industry).
        worldHeight = Heightmap(size = 2048, spacing = 4, seed = 1337).generate()
        demo = DemoCity(worldHeight, 1337)
        demo.buildStreets()
        demo.gradeBlocks()
        conformRoads()
        demo.buildRoutes()
        demo.generateBlocks()
        buildRoadNet()
        cityYaw = atan2(-demo.site.uz, demo.site.ux).toFloat()
        val cc = demo.L(0.0, demo.COAST_V + demo.ROWS[2])
        val camY = worldHeight.getHeight(cc[0], cc[1]).toFloat() + 12f
        camTarget[0] = cc[0].toFloat(); camTarget[1] = camY; camTarget[2] = cc[1].toFloat()
        camTargetGoal[0] = camTarget[0]; camTargetGoal[1] = camY; camTargetGoal[2] = camTarget[2]
        camYaw = atan2(-demo.site.ux, -demo.site.uz).toFloat()
        camYawGoal = camYaw
        camPitch = 0.85f; camPitchGoal = 0.85f
        camDist = 430f; camDistGoal = 430f
        buildTerrain()
        buildRoadMesh()
        loadBuildings()
        buildWater()
        buildCube()
        buildCar()
        buildSky()
        rebuildEditMeshes()
        generateVehicles()
        glReady = true
        pendingCamera?.let { restoreCamera(it) }
        pendingEdits?.let { applyEdits(it) }
        pendingEdits = null
        pendingCamera = null
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        surfaceW = max(1, width)
        surfaceH = max(1, height)
        computeLetterbox()
    }

    private fun computeLetterbox() {
        val vw = min(surfaceW.toFloat(), surfaceH * 16f / 9f)
        val vh = vw * 9f / 16f
        letterbox[0] = (surfaceW - vw) / 2f
        letterbox[1] = (surfaceH - vh) / 2f
        letterbox[2] = vw
        letterbox[3] = vh
    }

    override fun onDrawFrame(gl: GL10?) {
        val now = System.nanoTime()
        val dt = if (frameNanos == 0L) 0.016f else ((now - frameNanos) / 1_000_000_000f).coerceIn(0.001f, 0.1f)
        frameNanos = now

        if (!paused) {
            hour += dt / 18f
            if (hour >= 24f) {
                hour -= 24f
                day++
                listener?.onHourChanged(hour, day)
            }
            updateVehicles(dt)
        }
        updateCamera(dt)
        if (editsDirty && now - lastSaveHint > 900_000_000L) {
            editsDirty = false
            lastSaveHint = now
            listener?.onCityEdited()
        }

        // camera matrices
        val aspect = letterbox[2] / max(1f, letterbox[3])
        Matrix.perspectiveM(projM, 0, 50f, aspect, 5f, 2600f)
        val cx = camTarget[0] + camDist * cos(camPitch) * sin(camYaw)
        val cy = camTarget[1] + camDist * sin(camPitch)
        val cz = camTarget[2] + camDist * cos(camPitch) * cos(camYaw)
        Matrix.setLookAtM(viewM, 0, cx, cy, cz, camTarget[0], camTarget[1], camTarget[2], 0f, 1f, 0f)
        Matrix.multiplyMM(vpM, 0, projM, 0, viewM, 0)
        Matrix.invertM(invVpM, 0, vpM, 0)

        val sun = sunState()
        GLES30.glViewport(letterbox[0].toInt(), letterbox[1].toInt(), letterbox[2].toInt(), letterbox[3].toInt())
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)

        // sky fills the letterboxed viewport (depth off)
        GLES30.glDisable(GLES30.GL_DEPTH_TEST)
        drawSky(sun)
        GLES30.glEnable(GLES30.GL_DEPTH_TEST)

        drawTerrain(sun)
        drawCityGround(sun)
        drawEditQuads(sun)
        drawBuildings(sun)
        drawVehicles(sun)
        drawWater(sun)

        if (!glErrorLogged) {
            val err = GLES30.glGetError()
            if (err != GLES30.GL_NO_ERROR) {
                Log.e(TAG, "GL error 0x${Integer.toHexString(err)}")
                glErrorLogged = true
            }
        }
    }

    // ---------------------------------------------------------------- sun & palette

    private class SunState {
        var dir = FloatArray(3)
        var color = FloatArray(3)
        var ambient = FloatArray(3)
        var dayFactor = 1f
        var zenith = FloatArray(3)
        var horizon = FloatArray(3)
    }

    private fun sunState(): SunState {
        val s = SunState()
        val ang = (hour - 6f) / 12f * Math.PI.toFloat()
        val elev = sin(ang)
        val dirX = cos(ang) * 0.42f
        val dirZ = -0.78f
        val len = sqrt(dirX * dirX + max(0.12f, elev) * max(0.12f, elev) + dirZ * dirZ)
        s.dir[0] = dirX / len
        s.dir[1] = max(0.12f, elev) / len
        s.dir[2] = dirZ / len
        s.dayFactor = (elev * 3.2f + 0.12f).coerceIn(0f, 1f)
        val warm = (1f - (elev * 1.8f).coerceIn(0f, 1f))
        val sunUp = s.dayFactor
        s.color[0] = (1.0f * (1 - warm * 0.35f) + 0.0f) * sunUp
        s.color[1] = (0.62f + 0.36f * (1 - warm)) * sunUp
        s.color[2] = (0.38f + 0.54f * (1 - warm)) * sunUp
        // ambient: cool blue at night, sky-tinted at day
        s.ambient[0] = 0.05f + 0.33f * s.dayFactor
        s.ambient[1] = 0.07f + 0.41f * s.dayFactor
        s.ambient[2] = 0.13f + 0.53f * s.dayFactor
        // sky palette
        val dayZen = floatArrayOf(0.22f, 0.44f, 0.78f)
        val dayHor = floatArrayOf(0.66f, 0.78f, 0.88f)
        val duskZen = floatArrayOf(0.12f, 0.14f, 0.30f)
        val duskHor = floatArrayOf(0.86f, 0.44f, 0.22f)
        val nightZen = floatArrayOf(0.015f, 0.025f, 0.06f)
        val nightHor = floatArrayOf(0.05f, 0.08f, 0.16f)
        val duskMix = (1f - abs(elev) * 2.4f).coerceIn(0f, 1f)
        for (i in 0..2) {
            val dayC = dayZen[i] * (1 - duskMix) + duskZen[i] * duskMix
            val horC = dayHor[i] * (1 - duskMix) + duskHor[i] * duskMix
            s.zenith[i] = dayC * s.dayFactor + nightZen[i] * (1 - s.dayFactor)
            s.horizon[i] = horC * s.dayFactor + nightHor[i] * (1 - s.dayFactor)
        }
        return s
    }

    // ---------------------------------------------------------------- terrain / noise

    private fun hash2(ix: Int, iz: Int): Float {
        var h = ix * 374761393 + iz * 668265263 + 1442695041
        h = (h xor (h shr 13)) * 1274126177
        h = h xor (h shr 16)
        return (h and 0x7fffffff) / 0x7fffffff.toFloat()
    }

    private fun valueNoise(x: Float, z: Float): Float {
        val ix = kotlin.math.floor(x)
        val iz = kotlin.math.floor(z)
        val fx = x - ix
        val fz = z - iz
        val sx = fx * fx * (3 - 2 * fx)
        val sz = fz * fz * (3 - 2 * fz)
        val a = hash2(ix.toInt(), iz.toInt())
        val b = hash2(ix.toInt() + 1, iz.toInt())
        val c = hash2(ix.toInt(), iz.toInt() + 1)
        val d = hash2(ix.toInt() + 1, iz.toInt() + 1)
        return a * (1 - sx) * (1 - sz) + b * sx * (1 - sz) + c * (1 - sx) * sz + d * sx * sz
    }

    private fun fbm(x: Float, z: Float): Float {
        var v = 0f
        var amp = 0.5f
        var fx = x
        var fz = z
        for (i in 0 until 4) {
            v += valueNoise(fx, fz) * amp
            amp *= 0.5f
            fx *= 2.03f
            fz *= 1.97f
        }
        return v
    }

    private fun roadDistance(x: Float, z: Float): Float {
        // signed distance to the prebuilt road network (negative = on a road)
        var best = Float.MAX_VALUE
        for (s in roadSegs) {
            val dx = s.x1 - s.x0
            val dz = s.z1 - s.z0
            val len2 = dx * dx + dz * dz
            var t = if (len2 > 0f) ((x - s.x0) * dx + (z - s.z0) * dz) / len2 else 0f
            t = t.coerceIn(0f, 1f)
            val px = s.x0 + dx * t - x
            val pz = s.z0 + dz * t - z
            val d = sqrt(px * px + pz * pz) - s.hw
            if (d < best) best = d
        }
        return best
    }

    /** Conform every demo street corridor into the heightmap (the site's road mechanism). */
    private fun conformRoads() {
        for (road in demo.roads) {
            if (road.world.size < 2) continue
            val pts = ArrayList<Heightmap.PathPoint>(road.world.size)
            for (p in road.world) {
                pts.add(Heightmap.PathPoint(p[0], worldHeight.getHeight(p[0], p[1]) + 0.4, p[1]))
            }
            worldHeight.conformPath(pts, (DemoCity.halfWidth(road.type) * 2).toDouble(), 20.0)
        }
    }

    private fun buildRoadNet() {
        roadSegs.clear()
        for (road in demo.roads) {
            val hw = DemoCity.halfWidth(road.type)
            val w = road.world
            for (i in 0 until w.size - 1) {
                roadSegs.add(RoadSeg(w[i][0].toFloat(), w[i][1].toFloat(), w[i + 1][0].toFloat(), w[i + 1][1].toFloat(), hw))
            }
        }
    }

    private fun terrainHeight(x: Float, z: Float): Float = worldHeight.getHeight(x.toDouble(), z.toDouble()).toFloat()

    private fun buildTerrain() {
        val n = 224
        val step = mapHalf * 2f / n
        val data = FloatArray(n * n * 48) // 2 tris x 3 verts x 8 floats per cell
        var o = 0
        for (j in 0 until n) {
            for (i in 0 until n) {
                val x0 = -mapHalf + i * step
                val z0 = -mapHalf + j * step
                val x1 = x0 + step
                val z1 = z0 + step
                // two triangles, positions + colors (pos3, col3, padded to 8 floats: pos3 col3 nY1 pad1)
                o = emitQuad(data, o,
                    x0, terrainHeight(x0, z0), z0, x1, terrainHeight(x1, z0), z0,
                    x1, terrainHeight(x1, z1), z1, x0, terrainHeight(x0, z1), z1, true)
            }
        }
        terrainCount = o / 8
        terrainVbo = upload(data)
    }

    private fun terrainColor(x: Float, z: Float, h: Float, out: FloatArray, off: Int) {
        val n = fbm(x * 0.02f, z * 0.02f) // fine detail
        val n2 = fbm(x * 0.004f + 11f, z * 0.004f - 5f) // macro variation
        var r: Float
        var g: Float
        var b: Float
        when {
            h < 0.4f -> { // shallow water bed / wet sand
                r = 0.30f + n * 0.05f; g = 0.26f + n * 0.04f; b = 0.18f + n * 0.03f
            }
            h < 3.2f -> { // beach sand
                r = 0.72f + n * 0.06f; g = 0.65f + n * 0.05f; b = 0.44f + n * 0.04f
            }
            h < 120f -> { // grass: light valley → deeper upland
                val t = ((h - 3.2f) / 116.8f).coerceIn(0f, 1f)
                r = (0.30f - 0.10f * t) + n * 0.06f + n2 * 0.05f
                g = (0.44f - 0.08f * t) + n * 0.08f + n2 * 0.04f
                b = (0.20f - 0.05f * t) + n * 0.03f
            }
            h < 190f -> { // rock
                r = 0.38f + n * 0.08f; g = 0.36f + n * 0.07f; b = 0.33f + n * 0.06f
            }
            else -> { // snow caps above ~190 m
                val s = ((h - 190f) / 30f).coerceIn(0f, 1f)
                r = (0.38f + n * 0.08f) * (1 - s) + (0.92f + n * 0.04f) * s
                g = (0.36f + n * 0.07f) * (1 - s) + (0.94f + n * 0.03f) * s
                b = (0.33f + n * 0.06f) * (1 - s) + 0.97f * s
            }
        }
        out[off] = r; out[off + 1] = g; out[off + 2] = b
    }

    private fun emitQuad(data: FloatArray, o0: Int,
                         ax: Float, ay: Float, az: Float, bx: Float, by: Float, bz: Float,
                         cx: Float, cy: Float, cz: Float, dx: Float, dy: Float, dz: Float,
                         colored: Boolean): Int {
        val c = FloatArray(3)
        var o = o0
        val tris = arrayOf(
            floatArrayOf(ax, ay, az, bx, by, bz, cx, cy, cz),
            floatArrayOf(ax, ay, az, cx, cy, cz, dx, dy, dz)
        )
        for (t in tris) {
            var sx = 0f; var sz = 0f
            for (k in 0 until 3) sx += t[k * 3] / 3f
            for (k in 0 until 3) sz += t[k * 3 + 2] / 3f
            for (k in 0 until 3) {
                data[o] = t[k * 3]; data[o + 1] = t[k * 3 + 1]; data[o + 2] = t[k * 3 + 2]
                if (colored) {
                    terrainColor(sx, sz, t[k * 3 + 1], c, 0)
                    data[o + 3] = c[0]; data[o + 4] = c[1]; data[o + 5] = c[2]
                } else {
                    data[o + 3] = 1f; data[o + 4] = 1f; data[o + 5] = 1f
                }
                data[o + 6] = 1f; data[o + 7] = 0f
                o += 8
            }
        }
        return o
    }

    // ---------------------------------------------------------------- prebuilt city ground

    private fun buildRoadMesh() {
        // every demo street as a conformed ribbon + centre dashes (paths get a lighter tone)
        val quads = ArrayList<Float>(1 shl 17)
        for (road in demo.roads) {
            val hw = DemoCity.halfWidth(road.type)
            val isPath = road.type == "path"
            val cr = if (isPath) 0.46f else 0.115f
            val cg = if (isPath) 0.43f else 0.12f
            val cb = if (isPath) 0.38f else 0.135f
            val w = road.world
            for (i in 0 until w.size - 1) {
                val x0 = w[i][0].toFloat(); val z0 = w[i][1].toFloat()
                val x1 = w[i + 1][0].toFloat(); val z1 = w[i + 1][1].toFloat()
                val dx = x1 - x0; val dz = z1 - z0
                val len = sqrt(dx * dx + dz * dz)
                if (len < 0.5f) continue
                val px = -dz / len * hw
                val pz = dx / len * hw
                val y00 = terrainHeight(x0 - px, z0 - pz) + 0.06f
                val y10 = terrainHeight(x0 + px, z0 + pz) + 0.06f
                val y01 = terrainHeight(x1 - px, z1 - pz) + 0.06f
                val y11 = terrainHeight(x1 + px, z1 + pz) + 0.06f
                quads.addAll(listOf(
                    x0 - px, y00, z0 - pz, cr, cg, cb, 1f, 0f,
                    x0 + px, y10, z0 + pz, cr, cg, cb, 1f, 0f,
                    x1 + px, y11, z1 + pz, cr, cg, cb, 1f, 0f,
                    x0 - px, y00, z0 - pz, cr, cg, cb, 1f, 0f,
                    x1 + px, y11, z1 + pz, cr, cg, cb, 1f, 0f,
                    x1 - px, y01, z1 - pz, cr, cg, cb, 1f, 0f
                ))
            }
            if (!isPath) {
                // centre dashes: 9 m dash / 9 m gap along the polyline
                var stepIdx = 0
                for (i in 0 until w.size - 1) {
                    val x0 = w[i][0].toFloat(); val z0 = w[i][1].toFloat()
                    val x1 = w[i + 1][0].toFloat(); val z1 = w[i + 1][1].toFloat()
                    val dx = x1 - x0; val dz = z1 - z0
                    val len = sqrt(dx * dx + dz * dz)
                    if (len < 0.01f) continue
                    val ux = dx / len; val uz = dz / len
                    var t = 0f
                    while (t < len - 0.01f) {
                        val stepLen = min(9f, len - t)
                        if (stepIdx % 2 == 0) {
                            val ax = x0 + ux * t; val az = z0 + uz * t
                            val bx = ax + ux * stepLen; val bz = az + uz * stepLen
                            val px = -uz * 0.35f; val pz = ux * 0.35f
                            val y00 = terrainHeight(ax - px, az - pz) + 0.075f
                            val y10 = terrainHeight(ax + px, az + pz) + 0.075f
                            val y01 = terrainHeight(bx - px, bz - pz) + 0.075f
                            val y11 = terrainHeight(bx + px, bz + pz) + 0.075f
                            quads.addAll(listOf(
                                ax - px, y00, az - pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                ax + px, y10, az + pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                bx + px, y11, bz + pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                ax - px, y00, az - pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                bx + px, y11, bz + pz, 0.72f, 0.70f, 0.52f, 1f, 0f,
                                bx - px, y01, bz - pz, 0.72f, 0.70f, 0.52f, 1f, 0f
                            ))
                        }
                        stepIdx++
                        t += stepLen
                    }
                }
            }
        }
        val arr = FloatArray(quads.size)
        for (i in arr.indices) arr[i] = quads[i]
        cityGroundCount = arr.size / 8
        cityGroundVbo = upload(arr)
    }

    // ---------------------------------------------------------------- city generation

    /** The demo city's preview blocks (web block plan + zoneFor mix) become renderable buildings. */
    private fun loadBuildings() {
        buildings.clear()
        val kindMap = intArrayOf(0, 0, 1, 1, 2, 3, 2) // DemoCity zone id -> renderer palette kind
        for (b in demo.blocks) {
            val gx = ((b.x + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
            val gz = ((b.z + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
            buildings.add(Building(b.x, b.y, b.z, b.w, b.d, b.h, kindMap[b.kind], b.yaw, b.seed, gz * gridN + gx))
        }
    }

    private fun generateVehicles() {
        val rng = Random(77123L)
        vehicles.clear()
        for (i in 0 until 26) {
            val route = i % max(demo.routes.size, 1)
            val dir = if (rng.nextBoolean()) 1f else -1f
            val lane = if (rng.nextBoolean()) 3.6f else -3.6f
            val speed = 9f + rng.nextFloat() * 8f
            val hue = rng.nextFloat()
            val body = when {
                hue < 0.25f -> floatArrayOf(0.75f, 0.16f, 0.14f)
                hue < 0.5f -> floatArrayOf(0.16f, 0.32f, 0.62f)
                hue < 0.78f -> floatArrayOf(0.88f, 0.86f, 0.84f)
                hue < 0.9f -> floatArrayOf(0.22f, 0.22f, 0.24f)
                else -> floatArrayOf(0.80f, 0.55f, 0.12f)
            }
            val len = demo.routes[route].length()
            vehicles.add(Vehicle(route, lane, rng.nextFloat() * len, speed, dir, rng.nextInt(10000), body))
        }
    }

    private fun updateVehicles(dt: Float) {
        for (v in vehicles) {
            val len = demo.routes[v.route].length()
            v.s += v.speed * v.dir * dt
            if (v.s > len) v.s = 0f
            if (v.s < 0f) v.s = len
        }
    }

    // ---------------------------------------------------------------- static meshes

    private fun buildWater() {
        val s = mapHalf * 1.3f
        val data = floatArrayOf(
            -s, waterY, -s, 1f, 1f, 1f, 1f, 0f,
            s, waterY, -s, 1f, 1f, 1f, 1f, 0f,
            s, waterY, s, 1f, 1f, 1f, 1f, 0f,
            -s, waterY, -s, 1f, 1f, 1f, 1f, 0f,
            s, waterY, s, 1f, 1f, 1f, 1f, 0f,
            -s, waterY, s, 1f, 1f, 1f, 1f, 0f
        )
        waterVbo = upload(data)
    }

    private fun pushBox(data: FloatArray, o0: Int, cx: Float, cy: Float, cz: Float, sx: Float, sy: Float, sz: Float, part: Float): Int {
        // unit cube faces scaled; normals per face; 8 floats per vertex: pos3 normal3 part1 pad1
        var o = o0
        val hx = sx / 2f
        val hy = sy / 2f
        val hz = sz / 2f
        val faces = arrayOf(
            // normal, then 4 corners (two tris)
            floatArrayOf(0f, 0f, 1f, cx - hx, cy - hy, cz + hz, cx + hx, cy - hy, cz + hz, cx + hx, cy + hy, cz + hz, cx - hx, cy + hy, cz + hz),
            floatArrayOf(0f, 0f, -1f, cx + hx, cy - hy, cz - hz, cx - hx, cy - hy, cz - hz, cx - hx, cy + hy, cz - hz, cx + hx, cy + hy, cz - hz),
            floatArrayOf(1f, 0f, 0f, cx + hx, cy - hy, cz + hz, cx + hx, cy - hy, cz - hz, cx + hx, cy + hy, cz - hz, cx + hx, cy + hy, cz + hz),
            floatArrayOf(-1f, 0f, 0f, cx - hx, cy - hy, cz - hz, cx - hx, cy - hy, cz + hz, cx - hx, cy + hy, cz + hz, cx - hx, cy + hy, cz - hz),
            floatArrayOf(0f, 1f, 0f, cx - hx, cy + hy, cz + hz, cx + hx, cy + hy, cz + hz, cx + hx, cy + hy, cz - hz, cx - hx, cy + hy, cz - hz),
            floatArrayOf(0f, -1f, 0f, cx - hx, cy - hy, cz - hz, cx + hx, cy - hy, cz - hz, cx + hx, cy - hy, cz + hz, cx - hx, cy - hy, cz + hz)
        )
        for (f in faces) {
            val idx = intArrayOf(0, 1, 2, 0, 2, 3)
            for (i in idx) {
                data[o] = f[3 + i * 3]; data[o + 1] = f[4 + i * 3]; data[o + 2] = f[5 + i * 3]
                data[o + 3] = f[0]; data[o + 4] = f[1]; data[o + 5] = f[2]
                data[o + 6] = part; data[o + 7] = 0f
                o += 8
            }
        }
        return o
    }

    private fun buildCube() {
        val data = FloatArray(36 * 8)
        pushBox(data, 0, 0f, 0f, 0f, 1f, 1f, 1f, 0f)
        cubeVbo = upload(data)
    }

    private fun buildCar() {
        // body + cabin in one buffer; part 0 = body, 1 = cabin/glass, 2 = wheels strip
        val data = FloatArray(36 * 8 * 2 + 36 * 8)
        var o = 0
        o = pushBox(data, o, 0f, 0.55f, 0f, 4.4f, 1.1f, 1.9f, 0f) // body
        o = pushBox(data, o, -0.25f, 1.32f, 0f, 2.3f, 0.62f, 1.72f, 1f) // cabin
        o = pushBox(data, o, 0f, 0.28f, 0f, 4.5f, 0.36f, 2.0f, 2f) // chassis/wheels hint
        carCount = o / 8
        carVbo = upload(data.copyOf(o))
    }

    private fun buildSky() {
        val data = floatArrayOf(-1f, -1f, 0f, 1f, -1f, 0f, 1f, 1f, 0f)
        skyVbo = upload(data)
    }

    // ---------------------------------------------------------------- edits

    fun cellIndexAt(worldX: Float, worldZ: Float): Int {
        val gx = ((worldX + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
        val gz = ((worldZ + cityHalf) / cellSize).toInt().coerceIn(0, gridN - 1)
        return gz * gridN + gx
    }

    private fun cellCenter(idx: Int): FloatArray {
        val gx = idx / gridN
        val gz = idx % gridN
        return floatArrayOf(-cityHalf + gx * cellSize + cellSize / 2f, -cityHalf + gz * cellSize + cellSize / 2f)
    }

    /** @return 1 = placed, -1 = removed, 0 = blocked (prebuilt road) */
    fun toggleRoadCell(idx: Int): Int {
        val center = cellCenter(idx)
        if (roadDistance(center[0], center[1]) < 1f) return 0
        val removed = roadCells.remove(idx)
        if (!removed) roadCells.add(idx)
        selectedBuilding = null
        rebuildEditMeshes()
        editsDirty = true
        return if (removed) -1 else 1
    }

    fun cycleZoneCell(idx: Int): Int {
        val cur = zoneCells[idx] ?: -1
        selectedBuilding = null
        if (cur >= 2) zoneCells.remove(idx) else zoneCells[idx] = cur + 1
        rebuildEditMeshes()
        editsDirty = true
        return zoneCells[idx] ?: -1
    }

    fun placeService(idx: Int): Boolean {
        val center = cellCenter(idx)
        if (roadDistance(center[0], center[1]) < 1f) return false
        for (b in buildings) if (!b.removed && b.cell == idx) return false
        val rng = Random(idx * 31L + 7)
        val y = terrainHeight(center[0], center[1])
        buildings.add(Building(center[0], y, center[1], 26f, 26f, 18f + rng.nextFloat() * 10f, 3, cityYaw, rng.nextInt(10000), idx))
        selectedBuilding = null
        rebuildEditMeshes()
        editsDirty = true
        return true
    }

    private fun rebuildEditMeshes() {
        // roads: cell quad + centre line; zones: tinted translucent quad
        val roads = FloatArray(roadCells.size * 2 * 6 * 8)
        var o = 0
        for (idx in roadCells) {
            val c = cellCenter(idx)
            val x0 = c[0] - cellSize / 2 + 1.5f
            val x1 = c[0] + cellSize / 2 - 1.5f
            val z0 = c[1] - cellSize / 2 + 1.5f
            val z1 = c[1] + cellSize / 2 - 1.5f
            val y = terrainHeight(c[0], c[1]) + 0.05f
            val asphalt = floatArrayOf(0.115f, 0.12f, 0.135f)
            o = putQuad(roads, o, x0, z0, x1, z1, y, asphalt)
            o = putQuad(roads, o, c[0] - 0.3f, z0, c[0] + 0.3f, z1, y + 0.01f, floatArrayOf(0.72f, 0.70f, 0.52f))
        }
        editRoadCount = o / 8
        if (editRoadVbo != 0) GLES30.glDeleteBuffers(1, intArrayOf(editRoadVbo), 0)
        editRoadVbo = upload(roads.copyOf(o))

        val zones = FloatArray(zoneCells.size * 6 * 8)
        o = 0
        for ((idx, kind) in zoneCells) {
            val c = cellCenter(idx)
            val col = when (kind) {
                0 -> floatArrayOf(0.20f, 0.65f, 0.30f)
                1 -> floatArrayOf(0.20f, 0.45f, 0.80f)
                else -> floatArrayOf(0.85f, 0.65f, 0.15f)
            }
            o = putQuad(zones, o, c[0] - cellSize / 2 + 2f, c[1] - cellSize / 2 + 2f,
                c[0] + cellSize / 2 - 2f, c[1] + cellSize / 2 - 2f, terrainHeight(c[0], c[1]) + 0.04f, col)
        }
        editZoneCount = o / 8
        if (editZoneVbo != 0) GLES30.glDeleteBuffers(1, intArrayOf(editZoneVbo), 0)
        editZoneVbo = upload(zones.copyOf(o))
    }

    private fun putQuad(data: FloatArray, o0: Int, x0: Float, z0: Float, x1: Float, z1: Float, y: Float, col: FloatArray): Int {
        var o = o0
        val seq = floatArrayOf(x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1)
        for (i in 0 until 6) {
            data[o] = seq[i * 2]; data[o + 1] = y; data[o + 2] = seq[i * 2 + 1]
            data[o + 3] = col[0]; data[o + 4] = col[1]; data[o + 5] = col[2]
            data[o + 6] = 1f; data[o + 7] = 0f
            o += 8
        }
        return o
    }

    // ---------------------------------------------------------------- picking & tools

    private fun rayFromScreen(sx: Float, sy: Float): FloatArray {
        val ndcX = (sx - letterbox[0]) / letterbox[2] * 2f - 1f
        val ndcY = 1f - (sy - letterbox[1]) / letterbox[3] * 2f
        val near = unproject(ndcX, ndcY, -1f)
        val far = unproject(ndcX, ndcY, 1f)
        return floatArrayOf(near[0], near[1], near[2], far[0] - near[0], far[1] - near[1], far[2] - near[2])
    }

    private fun unproject(nx: Float, ny: Float, nz: Float): FloatArray {
        val vIn = floatArrayOf(nx, ny, nz, 1f)
        val vOut = FloatArray(4)
        Matrix.multiplyMV(vOut, 0, invVpM, 0, vIn, 0)
        val w = vOut[3]
        return floatArrayOf(vOut[0] / w, vOut[1] / w, vOut[2] / w)
    }

    private fun groundPoint(ray: FloatArray): FloatArray? {
        // ray-march the real terrain (adaptive step + bisection refine)
        val ox = ray[0]; val oy = ray[1]; val oz = ray[2]
        val dx = ray[3]; val dy = ray[4]; val dz = ray[5]
        if (dy >= 0f && oy > 280f) return null
        var t = 0f
        var prevT = 0f
        var prevDiff = oy - terrainHeight(ox, oz)
        if (prevDiff < 0f) return floatArrayOf(ox, oz)
        while (t < 8000f) {
            t += (prevDiff * 0.6f).coerceIn(8f, 60f)
            val px = ox + dx * t
            val py = oy + dy * t
            val pz = oz + dz * t
            if (abs(px) > mapHalf || abs(pz) > mapHalf) return null
            val diff = py - terrainHeight(px, pz)
            if (diff <= 0f) {
                var a = prevT
                var b = t
                for (k in 0 until 8) {
                    val m = 0.5f * (a + b)
                    val mx = ox + dx * m
                    val mz = oz + dz * m
                    if (oy + dy * m - terrainHeight(mx, mz) > 0f) a = m else b = m
                }
                val tt = 0.5f * (a + b)
                return floatArrayOf(ox + dx * tt, oz + dz * tt)
            }
            prevT = t
            prevDiff = diff
        }
        return null
    }

    private fun buildingAt(ray: FloatArray): Building? {
        var best: Building? = null
        var bestT = Float.MAX_VALUE
        for (b in buildings) {
            if (b.removed) continue
            // yaw-rotated box → conservative axis-aligned bounds for picking
            val c = abs(cos(b.yaw))
            val s2 = abs(sin(b.yaw))
            val ew = b.w / 2f * c + b.d / 2f * s2
            val ed = b.w / 2f * s2 + b.d / 2f * c
            val t = rayBox(ray, b.x, b.y, b.z, ew * 2f, b.h, ed * 2f)
            if (t in 0f..bestT) {
                bestT = t
                best = b
            }
        }
        return best
    }

    private fun rayBox(ray: FloatArray, cx: Float, cy: Float, cz: Float, w: Float, h: Float, d: Float): Float {
        val min = floatArrayOf(cx - w / 2, cy, cz - d / 2)
        val max = floatArrayOf(cx + w / 2, cy + h, cz + d / 2)
        var t0 = 0f
        var t1 = 1e9f
        val ro = floatArrayOf(ray[0], ray[1], ray[2])
        val rd = floatArrayOf(ray[3], ray[4], ray[5])
        for (i in 0..2) {
            if (abs(rd[i]) < 1e-6f) {
                if (ro[i] < min[i] || ro[i] > max[i]) return -1f
            } else {
                var ta = (min[i] - ro[i]) / rd[i]
                var tb = (max[i] - ro[i]) / rd[i]
                if (ta > tb) { val tmp = ta; ta = tb; tb = tmp }
                t0 = max(t0, ta)
                t1 = min(t1, tb)
                if (t0 > t1) return -1f
            }
        }
        return t0
    }

    /** Applies the active tool at the tapped screen position; returns a status message. */
    fun tapTool(sx: Float, sy: Float, tool: String): String {
        val ray = rayFromScreen(sx, sy)
        return when (tool) {
            "ROAD" -> {
                val p = groundPoint(ray) ?: return "Aim inside the map"
                when (toggleRoadCell(cellIndexAt(p[0], p[1]))) {
                    1 -> "Road placed"
                    -1 -> "Road removed • +$300 refund"
                    else -> "Blocked by a road"
                }
            }
            "ZONE" -> {
                val p = groundPoint(ray) ?: return "Aim inside the map"
                when (cycleZoneCell(cellIndexAt(p[0], p[1]))) {
                    0 -> "Residential zone painted"
                    1 -> "Commercial zone painted"
                    2 -> "Industrial zone painted"
                    else -> "Zone cleared"
                }
            }
            "SERVICE" -> {
                val p = groundPoint(ray) ?: return "Aim inside the map"
                if (placeService(cellIndexAt(p[0], p[1]))) "Service built"
                else "Blocked — pick an empty lot"
            }
            "BULLDOZE" -> {
                val b = buildingAt(ray)
                if (b != null) {
                    b.removed = true
                    selectedBuilding = null
                    editsDirty = true
                    "Demolished"
                } else "Nothing to demolish here"
            }
            else -> {
                val b = buildingAt(ray)
                selectedBuilding = b
                b?.let {
                    val name = when (it.kind) {
                        0 -> "Residences"
                        1 -> "Commercial block"
                        2 -> "Office tower"
                        else -> "City service"
                    }
                    "$name • ${it.h.toInt()} m tall"
                } ?: "No building selected"
            }
        }
    }

    // ---------------------------------------------------------------- camera control

    private var panLast = FloatArray(2)

    fun beginPan(x: Float, y: Float) {
        panLast[0] = x
        panLast[1] = y
    }

    fun updatePan(x: Float, y: Float) {
        val dx = x - panLast[0]
        val dy = y - panLast[1]
        panLast[0] = x
        panLast[1] = y
        val scaleF = camDist * 0.0016f
        val sy = sin(camYaw)
        val cy = cos(camYaw)
        camTargetGoal[0] -= (dx * cy + dy * sy) * scaleF
        camTargetGoal[2] -= (-dx * sy + dy * cy) * scaleF
        camTargetGoal[0] = camTargetGoal[0].coerceIn(-mapHalf, mapHalf)
        camTargetGoal[2] = camTargetGoal[2].coerceIn(-mapHalf, mapHalf)
    }

    fun zoomBy(factor: Float) {
        camDistGoal = (camDistGoal / factor).coerceIn(60f, 900f)
    }

    fun rotateBy(delta: Float) {
        camYawGoal += delta
    }

    fun pitchBy(delta: Float) {
        camPitchGoal = (camPitchGoal + delta).coerceIn(0.35f, 1.45f)
    }

    private fun updateCamera(dt: Float) {
        val k = (dt * 8f).coerceIn(0f, 1f)
        camTarget[0] += (camTargetGoal[0] - camTarget[0]) * k
        camTarget[1] += (camTargetGoal[1] - camTarget[1]) * k
        camTarget[2] += (camTargetGoal[2] - camTarget[2]) * k
        camYaw += (camYawGoal - camYaw) * k
        camPitch += (camPitchGoal - camPitch) * k
        camDist += (camDistGoal - camDist) * k
    }

    fun cameraState(): FloatArray =
        floatArrayOf(camTarget[0], camTarget[1], camTarget[2], camYawGoal, camPitchGoal, camDistGoal, hour)

    fun restoreCamera(state: FloatArray) {
        if (state.size < 7) return
        if (!glReady) {
            pendingCamera = state.copyOf()
            return
        }
        camTargetGoal[0] = state[0]; camTarget[0] = state[0]
        camTargetGoal[1] = state[1]; camTarget[1] = state[1]
        camTargetGoal[2] = state[2]; camTarget[2] = state[2]
        camYawGoal = state[3]; camYaw = state[3]
        camPitchGoal = state[4]; camPitch = state[4]
        camDistGoal = state[5]; camDist = state[5]
        hour = state[6]
    }

    fun setHour(h: Float) {
        hour = h.coerceIn(0f, 23.99f)
    }

    // ---------------------------------------------------------------- persistence

    fun editsState(): String {
        val sb = StringBuilder()
        for (r in roadCells) {
            sb.append('r').append(r).append(';')
        }
        for ((k, v) in zoneCells) {
            sb.append('z').append(k).append(':').append(v).append(';')
        }
        return sb.toString()
    }

    fun restoreEdits(state: String) {
        pendingEdits = state
        if (glReady) applyEdits(state)
    }

    private var pendingEdits: String? = null
    private var pendingCamera: FloatArray? = null

    private fun applyEdits(state: String) {
        roadCells.clear()
        zoneCells.clear()
        for (token in state.split(';')) {
            if (token.isEmpty()) continue
            if (token[0] == 'r') {
                token.substring(1).toIntOrNull()?.let { roadCells.add(it) }
            } else if (token[0] == 'z') {
                val parts = token.substring(1).split(':')
                if (parts.size == 2) {
                    val k = parts[0].toIntOrNull()
                    val v = parts[1].toIntOrNull()
                    if (k != null && v != null) zoneCells[k] = v
                }
            }
        }
        rebuildEditMeshes()
    }

    private var glReady = false

    // ---------------------------------------------------------------- GL helpers & draws

    private fun upload(data: FloatArray): Int {
        val buf = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        buf.put(data).position(0)
        val handles = IntArray(1)
        GLES30.glGenBuffers(1, handles, 0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, handles[0])
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, buf.capacity() * 4, buf, GLES30.GL_STATIC_DRAW)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        return handles[0]
    }

    private fun compileShader(type: Int, src: String, label: String): Int {
        val sh = GLES30.glCreateShader(type)
        GLES30.glShaderSource(sh, src)
        GLES30.glCompileShader(sh)
        val ok = IntArray(1)
        GLES30.glGetShaderiv(sh, GLES30.GL_COMPILE_STATUS, ok, 0)
        if (ok[0] == 0) {
            val log = GLES30.glGetShaderInfoLog(sh)
            Log.e(TAG, "shader $label: $log")
            GLES30.glDeleteShader(sh)
            return 0
        }
        return sh
    }

    private fun buildProgram(vsSrc: String, fsSrc: String, label: String): Int {
        val vs = compileShader(GLES30.GL_VERTEX_SHADER, vsSrc, "$label.vs")
        val fs = compileShader(GLES30.GL_FRAGMENT_SHADER, fsSrc, "$label.fs")
        if (vs == 0 || fs == 0) return 0
        val p = GLES30.glCreateProgram()
        GLES30.glAttachShader(p, vs)
        GLES30.glAttachShader(p, fs)
        GLES30.glLinkProgram(p)
        val ok = IntArray(1)
        GLES30.glGetProgramiv(p, GLES30.GL_LINK_STATUS, ok, 0)
        if (ok[0] == 0) {
            Log.e(TAG, "link $label: ${GLES30.glGetProgramInfoLog(p)}")
            return 0
        }
        return p
    }

    private fun bindAttribs(stride: Int) {
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, stride, 0)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glVertexAttribPointer(1, 3, GLES30.GL_FLOAT, false, stride, 12)
        GLES30.glEnableVertexAttribArray(1)
        GLES30.glVertexAttribPointer(2, 2, GLES30.GL_FLOAT, false, stride, 24)
        GLES30.glEnableVertexAttribArray(2)
    }

    private fun drawLit(program: Int, vbo: Int, count: Int, sun: SunState, tintR: Float, tintG: Float, tintB: Float) {
        if (program == 0 || vbo == 0) return
        GLES30.glUseProgram(program)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vbo)
        bindAttribs(32)
        GLES30.glUniformMatrix4fv(u(program, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(program, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(program, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(program, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(program, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(program, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform3f(u(program, "uTint"), tintR, tintG, tintB)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, count)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    private fun drawTerrain(sun: SunState) = drawLit(progTerrain, terrainVbo, terrainCount, sun, 1f, 1f, 1f)
    private fun drawCityGround(sun: SunState) = drawLit(progFlat, cityGroundVbo, cityGroundCount, sun, 1f, 1f, 1f)

    private fun drawEditQuads(sun: SunState) {
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        drawLit(progFlat, editRoadVbo, editRoadCount, sun, 1f, 1f, 1f)
        drawLit(progFlat, editZoneVbo, editZoneCount, sun, 0.55f, 0.55f, 0.55f)
        GLES30.glDisable(GLES30.GL_BLEND)
    }

    private val uniCache = HashMap<Int, HashMap<String, Int>>()

    private fun u(program: Int, name: String): Int {
        var map = uniCache[program]
        if (map == null) {
            map = HashMap()
            uniCache[program] = map
        }
        val cached = map[name]
        if (cached != null) return cached
        val loc = GLES30.glGetUniformLocation(program, name)
        map[name] = loc
        return loc
    }

    private fun drawBuildings(sun: SunState) {
        if (progBuilding == 0 || cubeVbo == 0) return
        GLES30.glUseProgram(progBuilding)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, cubeVbo)
        bindAttribs(32)
        GLES30.glUniformMatrix4fv(u(progBuilding, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progBuilding, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(progBuilding, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(progBuilding, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(progBuilding, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(progBuilding, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform1f(u(progBuilding, "uDayFactor"), sun.dayFactor)
        for (b in buildings) {
            if (b.removed) continue
            val selected = selectedBuilding === b
            GLES30.glUniform3f(u(progBuilding, "uPos"), b.x, b.y, b.z)
            GLES30.glUniform3f(u(progBuilding, "uScale"), b.w, b.h, b.d)
            GLES30.glUniform1f(u(progBuilding, "uYaw"), b.yaw)
            val pal = when (b.kind) {
                0 -> floatArrayOf(0.74f, 0.62f, 0.50f)
                1 -> floatArrayOf(0.62f, 0.64f, 0.68f)
                2 -> floatArrayOf(0.42f, 0.50f, 0.60f)
                else -> floatArrayOf(0.80f, 0.78f, 0.72f)
            }
            GLES30.glUniform3f(u(progBuilding, "uColor"), pal[0], pal[1], pal[2])
            GLES30.glUniform1f(u(progBuilding, "uSeed"), b.seed.toFloat())
            GLES30.glUniform1f(u(progBuilding, "uKind"), b.kind.toFloat())
            GLES30.glUniform1f(u(progBuilding, "uSelected"), if (selected) 1f else 0f)
            GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 36)
        }
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    private fun drawVehicles(sun: SunState) {
        if (progBuilding == 0 || carVbo == 0) return
        GLES30.glUseProgram(progBuilding)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, carVbo)
        bindAttribs(32)
        GLES30.glUniformMatrix4fv(u(progBuilding, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progBuilding, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(progBuilding, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(progBuilding, "uAmbient"), sun.ambient[0], sun.ambient[1], sun.ambient[2])
        GLES30.glUniform3f(u(progBuilding, "uFogColor"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(progBuilding, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform1f(u(progBuilding, "uDayFactor"), sun.dayFactor)
        GLES30.glUniform1f(u(progBuilding, "uSelected"), 0f)
        GLES30.glUniform1f(u(progBuilding, "uKind"), 9f) // vehicle mode
        val out5 = FloatArray(5)
        for (v in vehicles) {
            val route = demo.routes[v.route]
            route.at(v.s, out5)
            // tangent flipped to the driving direction; right-hand lane offset
            val tl = sqrt(out5[3] * out5[3] + out5[4] * out5[4]) + 1e-6f
            val ndx = out5[3] / tl * v.dir
            val ndz = out5[4] / tl * v.dir
            val x = out5[0] - ndz * v.lane
            val z = out5[1] + ndx * v.lane
            GLES30.glUniform3f(u(progBuilding, "uPos"), x, terrainHeight(x, z) + 0.05f, z)
            GLES30.glUniform3f(u(progBuilding, "uScale"), 4.4f, 1f, 1.9f)
            GLES30.glUniform1f(u(progBuilding, "uYaw"), atan2(ndz, ndx))
            GLES30.glUniform3f(u(progBuilding, "uColor"), v.color[0], v.color[1], v.color[2])
            GLES30.glUniform1f(u(progBuilding, "uSeed"), v.seed.toFloat())
            GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, carCount)
        }
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
    }

    private fun drawWater(sun: SunState) {
        if (progWater == 0 || waterVbo == 0) return
        GLES30.glEnable(GLES30.GL_BLEND)
        GLES30.glBlendFunc(GLES30.GL_SRC_ALPHA, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        GLES30.glUseProgram(progWater)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, waterVbo)
        bindAttribs(32)
        GLES30.glUniformMatrix4fv(u(progWater, "uVP"), 1, false, vpM, 0)
        GLES30.glUniform3f(u(progWater, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform3f(u(progWater, "uZenith"), sun.zenith[0], sun.zenith[1], sun.zenith[2])
        GLES30.glUniform3f(u(progWater, "uHorizon"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform1f(u(progWater, "uTime"), frameNanos / 1_000_000_000f)
        GLES30.glUniform3f(u(progWater, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 6)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        GLES30.glDisable(GLES30.GL_BLEND)
    }

    private fun drawSky(sun: SunState) {
        if (progSky == 0 || skyVbo == 0) return
        GLES30.glDisable(GLES30.GL_CULL_FACE)
        GLES30.glUseProgram(progSky)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, skyVbo)
        GLES30.glVertexAttribPointer(0, 3, GLES30.GL_FLOAT, false, 12, 0)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glUniformMatrix4fv(u(progSky, "uInvVP"), 1, false, invVpM, 0)
        GLES30.glUniform3f(u(progSky, "uZenith"), sun.zenith[0], sun.zenith[1], sun.zenith[2])
        GLES30.glUniform3f(u(progSky, "uHorizon"), sun.horizon[0], sun.horizon[1], sun.horizon[2])
        GLES30.glUniform3f(u(progSky, "uSunDir"), sun.dir[0], sun.dir[1], sun.dir[2])
        GLES30.glUniform3f(u(progSky, "uSunColor"), sun.color[0], sun.color[1], sun.color[2])
        GLES30.glUniform3f(u(progSky, "uCamPos"),
            camTarget[0] + camDist * cos(camPitch) * sin(camYaw),
            camTarget[1] + camDist * sin(camPitch),
            camTarget[2] + camDist * cos(camPitch) * cos(camYaw))
        GLES30.glUniform1f(u(progSky, "uDayFactor"), sun.dayFactor)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, 0)
        GLES30.glEnable(GLES30.GL_CULL_FACE)
    }

    fun markReady() {
        glReady = true
    }

    companion object {
        private const val TAG = "GlCityRenderer"
    }

    // ---------------------------------------------------------------- shaders

    private val VS_LIT = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        layout(location=1) in vec3 aColor;
        layout(location=2) in vec2 aExtra;
        uniform mat4 uVP;
        out vec3 vColor;
        out vec3 vWorld;
        void main() {
            vColor = aColor;
            vWorld = aPos;
            gl_Position = uVP * vec4(aPos, 1.0);
        }
    """.trimIndent()

    private val FS_LIT = """
        #version 300 es
        precision highp float;
        in vec3 vColor;
        in vec3 vWorld;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform vec3 uCamPos;
        uniform vec3 uTint;
        out vec4 fragColor;
        void main() {
            float ndl = max(dot(normalize(vec3(0.0, 1.0, 0.0)), uSunDir), 0.0);
            vec3 col = vColor * uTint * (uAmbient + uSunColor * ndl);
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * 0.0011);
            fragColor = vec4(mix(col, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    private val VS_BUILDING = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        layout(location=1) in vec3 aNormal;
        layout(location=2) in vec2 aExtra;
        uniform mat4 uVP;
        uniform vec3 uPos;
        uniform vec3 uScale;
        uniform float uYaw;
        out vec3 vNormal;
        out vec3 vLocal;
        out vec3 vWorld;
        out float vPart;
        void main() {
            float c = cos(uYaw);
            float s = sin(uYaw);
            vec3 scaled = aPos * uScale;
            vLocal = aPos;
            vPart = aExtra.x;
            vNormal = normalize(vec3(aNormal.x * c - aNormal.z * s, aNormal.y, aNormal.x * s + aNormal.z * c));
            vWorld = uPos + vec3(scaled.x * c - scaled.z * s, scaled.y, scaled.x * s + scaled.z * c);
            gl_Position = uVP * vec4(vWorld, 1.0);
        }
    """.trimIndent()

    private val FS_BUILDING = """
        #version 300 es
        precision highp float;
        in vec3 vNormal;
        in vec3 vLocal;
        in vec3 vWorld;
        in float vPart;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform vec3 uCamPos;
        uniform vec3 uColor;
        uniform vec3 uScale;
        uniform float uDayFactor;
        uniform float uSeed;
        uniform float uKind;
        uniform float uSelected;
        out vec4 fragColor;

        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453);
        }

        void main() {
            vec3 n = normalize(vNormal);
            float ndl = max(dot(n, uSunDir), 0.0);
            float hemi = 0.5 + 0.5 * n.y;
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * 0.0011);
            vec3 colOut;
            if (uKind < 8.5) {
                // buildings: window grid on side faces
                vec3 col = uColor * (uAmbient * hemi + uSunColor * ndl * 0.9);
                bool side = abs(n.y) < 0.5;
                if (side) {
                    float u = abs(n.x) > 0.5 ? vLocal.z : vLocal.x;
                    float v = vLocal.y;
                    float rows = max(2.0, floor(uScale.y / 5.0));
                    vec2 grid = vec2(u, v) * vec2(6.0, rows);
                    vec2 cell = floor(grid);
                    vec2 f = fract(grid);
                    bool win = f.x > 0.22 && f.x < 0.78 && f.y > 0.25 && f.y < 0.80;
                    float litRand = hash(cell);
                    float litFraction = mix(0.72, 0.10, uDayFactor);
                    bool lit = win && litRand < litFraction;
                    if (win) {
                        vec3 glass = uColor * 0.32 + vec3(0.03, 0.05, 0.09);
                        vec3 warm = vec3(1.0, 0.72, 0.38) * (1.6 + 0.9 * hash(cell + 7.0));
                        col = lit ? warm : glass * (uAmbient * 1.4 + uSunColor * ndl);
                    } else {
                        col *= 0.92; // mullions slightly darker
                    }
                }
                if (n.y > 0.5) col = uColor * 0.55 * (uAmbient + uSunColor * ndl);
                colOut = col;
                if (uSelected > 0.5) colOut = mix(colOut, vec3(0.35, 0.85, 1.0), 0.45);
            } else {
                // vehicles: vPart 0 = body (uColor), 1 = cabin glass, 2 = chassis
                vec3 partCol = uColor;
                if (vPart > 1.5) partCol = vec3(0.06, 0.06, 0.07);
                else if (vPart > 0.5) partCol = vec3(0.10, 0.13, 0.18);
                colOut = partCol * (uAmbient * hemi + uSunColor * ndl * 1.15);
                if (vPart > 0.5 && vPart < 1.5) {
                    float spec = pow(max(dot(normalize(uSunDir + normalize(uCamPos - vWorld)), n), 0.0), 60.0);
                    colOut += uSunColor * spec * 0.35;
                }
            }
            fragColor = vec4(mix(colOut, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    private val VS_WATER = VS_LIT

    private val FS_WATER = """
        #version 300 es
        precision highp float;
        in vec3 vColor;
        in vec3 vWorld;
        uniform vec3 uCamPos;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;   // CI emulator gate caught this missing declaration - the water
        uniform float uTime;      // shader failed to compile (undeclared identifier) and the water plane never rendered
        out vec4 fragColor;
        void main() {
            vec3 viewDir = normalize(uCamPos - vWorld);
            float fres = pow(1.0 - max(viewDir.y, 0.0), 3.0);
            float w1 = sin(vWorld.x * 0.12 + uTime * 1.3) * 0.5 + 0.5;
            float w2 = sin(vWorld.z * 0.09 - uTime * 1.1) * 0.5 + 0.5;
            vec3 sky = mix(uHorizon, uZenith, 0.6);
            vec3 deep = vec3(0.05, 0.16, 0.22) * (0.6 + 0.4 * w1 * w2);
            vec3 col = mix(deep, sky, 0.35 + 0.45 * fres);
            float sunSpot = pow(max(dot(reflect(-viewDir, vec3(0.0, 1.0, 0.0)), uSunDir), 0.0), 90.0);
            col += uSunColor * sunSpot * 0.9;
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * 0.0011);
            fragColor = vec4(mix(col, uHorizon, fog), 0.86);
        }
    """.trimIndent()

    private val VS_SKY = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        out vec2 vNdc;
        void main() {
            vNdc = aPos.xy;
            gl_Position = vec4(aPos.xy, 0.9999, 1.0);
        }
    """.trimIndent()

    private val FS_SKY = """
        #version 300 es
        precision highp float;
        in vec2 vNdc;
        uniform mat4 uInvVP;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uCamPos;
        uniform float uDayFactor;
        out vec4 fragColor;
        void main() {
            vec4 p = uInvVP * vec4(vNdc, 1.0, 1.0);
            vec3 dir = normalize(p.xyz / p.w - uCamPos);
            float t = clamp(dir.y * 1.4 + 0.12, 0.0, 1.0);
            vec3 col = mix(uHorizon, uZenith, pow(t, 0.75));
            float s = max(dot(dir, uSunDir), 0.0);
            col += uSunColor * (pow(s, 700.0) * 2.4 + pow(s, 24.0) * 0.28 + pow(s, 5.0) * 0.10);
            // ground below horizon darkens toward a muted land tone
            col = mix(col, uHorizon * 0.55, clamp(-dir.y * 6.0, 0.0, 1.0));
            fragColor = vec4(col, 1.0);
        }
    """.trimIndent()
}
