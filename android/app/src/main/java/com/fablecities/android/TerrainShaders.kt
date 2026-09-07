package com.fablecities.android

/**
 * The native terrain splat + puddle GLSL — direct GLSL ES 3.0 ports of the site's shader code:
 *
 *  - FS_TERRAIN is the FULL 8-layer splat fragment shader from terrain/TerrainMaterial.js
 *    (the in-map branch; HORIZON_CTRL has no native consumer): CPU control map (dry / dirt /
 *    sand / rockBoost | canopy / field / curvature), per-pixel world-normal + slope, signed shore
 *    distance, two-scale anti-tiling sampling with macro re-tint, triplanar dual-rock strata with
 *    lichen and cut-bank clay, the analytic wandering snow line, near-field 0.55 m + 2.2 m grass
 *    micro-layers, mid scree, curvature/drainage/terracette geology, rain wetness (albedo +
 *    roughness), wet shore band, night matte/cool grade, and the albedo ceiling. The lighting
 *    tail adapts the site's aomap_fragment replacement (tAO / tNightFill / hemi floor / day sky
 *    bounce) to the native light uniforms and adds the sun GGX lobe that carries tRough.
 *
 *  - FS_PUDDLE is effects/PuddleField.js PUDDLE_PARS + PUDDLE_INJECT (surface wobble, rain
 *    rings, dry/far alpha fade) plus a planar-reflection mirror sample standing in for the
 *    MeshPhysicalMaterial env probe + GroundFXPass composite.
 *
 *  - FX_NOISE_GLSL is effects/wetGlsl.js verbatim, shared by FS_PUDDLE and FS_LIT (wet road).
 */
object TerrainShaders {

    /** effects/wetGlsl.js FX_NOISE_GLSL — pure functions, no uniforms, shared by both passes. */
    val FX_NOISE_GLSL = """
vec2 fxHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float fxHash1(vec2 p) { return fxHash2(p).x; }
float fxValueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fxHash1(i), b = fxHash1(i + vec2(1.0, 0.0)), c = fxHash1(i + vec2(0.0, 1.0)), d = fxHash1(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fxPuddleField(vec2 xz) {
  return fxValueNoise(xz * 0.085) * 0.68 + fxValueNoise(xz * 0.21 + 17.3) * 0.32;
}
""".trimIndent()

    // ---------------------------------------------------------------- terrain splat -------------

    val VS_TERRAIN = """
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

    val FS_TERRAIN = """
        #version 300 es
        precision highp float;
        precision highp sampler2DArray;
        in vec3 vColor;
        in vec3 vWorld;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uCamPos;
        uniform vec3 uTint;
        uniform sampler2D uCloudShadow;
        uniform float uShadowStrength;
        uniform vec3 uLightToward;
        uniform float uWetness;
        uniform float uSnow;
        uniform float uNight;
        uniform vec3 uMoonDir;
        uniform sampler2DArray uAlbedo;
        uniform sampler2DArray uNormalArr;
        uniform sampler2D uControl;
        uniform sampler2D uControl2;
        uniform sampler2D uTerrainNormal;
        uniform sampler2D uNoise;
        uniform sampler2D uShore;
        uniform float uSpacing;
        uniform float uHalf;
        uniform float uSize;
        uniform float uShoreN;
        uniform float uWaterLevel;
        uniform float uSnowLine;
        uniform vec2 uDetailFade;
        uniform vec2 uNearFade;
        uniform float uScales[8];
        out vec4 fragColor;

        const mat2 ROT2 = mat2(0.8, -0.6, 0.6, 0.8);
        const mat2 ROT3 = mat2(0.36, 0.93, -0.93, 0.36);
        const vec3 LUMW = vec3(0.3, 0.59, 0.11);

        // two-scale anti-tiling sample of one layer (top projection). alb: rgb colour, a AO; nrm: rgb normal, a roughness
        void sampleLayer(float layer, vec2 p, float scale, float blend, float macro, out vec4 alb, out vec4 nrm) {
          vec2 uv1 = p / scale;
          vec2 uv2 = (ROT2 * p) / (scale * 4.3);
          vec4 a1 = texture(uAlbedo, vec3(uv1, layer));
          vec4 a2 = texture(uAlbedo, vec3(uv2, layer));
          vec4 n1 = texture(uNormalArr, vec3(uv1, layer));
          vec4 n2 = texture(uNormalArr, vec3(uv2, layer));
          alb = mix(a1, a2, blend);
          nrm = mix(n1, n2, blend);
          // 20x scale of the SAME photographic set — real ground structure at aerial distance
          if (macro > 0.004) {
            vec3 uv3 = vec3((ROT3 * p) / (scale * 20.0) + 0.63, layer);
            vec3 a3 = texture(uAlbedo, uv3).rgb;
            float mean3 = max(dot(textureLod(uAlbedo, uv3, 7.0).rgb, LUMW), 0.02);
            alb.rgb *= mix(vec3(1.0), clamp(a3 / mean3, vec3(0.42), vec3(2.1)), macro);
          }
        }

        // triplanar sample of one rock layer; returns world-space normal perturbation in nPert
        void sampleRockLayer(float layer, vec3 p, vec3 w, float scale, float big, out vec4 alb, out vec3 nPert, out float rough) {
          vec4 aX = texture(uAlbedo, vec3(p.zy / scale, layer));
          vec4 aY = texture(uAlbedo, vec3(p.xz / scale, layer));
          vec4 aZ = texture(uAlbedo, vec3(p.xy / scale, layer));
          vec4 nX = texture(uNormalArr, vec3(p.zy / scale, layer));
          vec4 nY = texture(uNormalArr, vec3(p.xz / scale, layer));
          vec4 nZ = texture(uNormalArr, vec3(p.xy / scale, layer));
          if (big > 0.0) {
            vec4 aX2 = texture(uAlbedo, vec3((ROT2 * p.zy) / (scale * 3.7) + 0.31, layer));
            vec4 aY2 = texture(uAlbedo, vec3((ROT2 * p.xz) / (scale * 3.7) + 0.11, layer));
            vec4 aZ2 = texture(uAlbedo, vec3((ROT2 * p.xy) / (scale * 3.7) + 0.57, layer));
            aX = mix(aX, aX2, big); aY = mix(aY, aY2, big); aZ = mix(aZ, aZ2, big);
          }
          alb = aX * w.x + aY * w.y + aZ * w.z;
          vec3 tX = nX.xyz * 2.0 - 1.0, tY = nY.xyz * 2.0 - 1.0, tZ = nZ.xyz * 2.0 - 1.0;
          nPert = vec3(0.0, tX.y, tX.x) * w.x + vec3(tY.x, 0.0, tY.y) * w.y + vec3(tZ.x, tZ.y, 0.0) * w.z;
          rough = nX.a * w.x + nY.a * w.y + nZ.a * w.z;
        }

        vec3 tangentPert(vec4 n) { return (n.xyz * 2.0 - 1.0).xyy * vec3(1.0, 0.0, 1.0); }

        void main() {
            vec3 tAlbedo; vec3 tNormalWorld; float tRough; float tAO; vec3 tNightFill;
            {
              vec2 vTWorld = vWorld.xz;
              float viewDist = length(uCamPos - vWorld);
              vec4 nzMacro = texture(uNoise, vTWorld / 95.0 + 0.29);
              vec4 nzMid = texture(uNoise, vTWorld / 43.0 + 0.37);
              vec4 nzHuge = texture(uNoise, vTWorld / 1150.0 + 0.71);
              vec4 nzReg = texture(uNoise, vTWorld / 430.0 + 0.13);
              vec4 nzSmall = texture(uNoise, vTWorld / 19.0 + 0.83);
              vec2 uvW = (vTWorld + uHalf) / uSize;
              vec3 gN = normalize(texture(uTerrainNormal, uvW).xyz * 2.0 - 1.0);
              vec4 ctrl = texture(uControl, uvW);
              vec4 ctrl2 = texture(uControl2, uvW);
              float canopy = ctrl2.r;
              float curv = ctrl2.a;
              float slope = 1.0 - gN.y;
              float grade = length(gN.xz) / max(gN.y, 0.05);
              // 40 m planform curvature straight off the world-normal map
              float conc = 0.0;
              {
                float e = 40.0 / uSize;
                float gx = texture(uTerrainNormal, uvW + vec2(e, 0.0)).r - texture(uTerrainNormal, uvW - vec2(e, 0.0)).r;
                float gz = texture(uTerrainNormal, uvW + vec2(0.0, e)).b - texture(uTerrainNormal, uvW - vec2(0.0, e)).b;
                conc = -(gx + gz) * 3.0;
              }
              float valleyF = smoothstep(0.03, 0.45, conc);
              float ridgeF = smoothstep(0.03, 0.45, -conc);
              float hAbove = vWorld.y - uWaterLevel;
              // signed distance to the waterline (+ land) from the shore-distance texture
              vec2 uvS = ((vTWorld + uHalf) / uSpacing + 0.5) / uShoreN;
              float shoreD = (texture(uShore, uvS).r * 255.0 - 128.0) * 0.25;
              float detail = 1.0 - smoothstep(uDetailFade.x, uDetailFade.y, viewDist);
              float nearF = 1.0 - smoothstep(uNearFade.x, uNearFade.y, viewDist);
              float midF = 1.0 - smoothstep(90.0, 260.0, viewDist);
              float blend = smoothstep(0.32, 0.68, nzMid.g);
              float macroW = 1.0 * smoothstep(60.0, 260.0, viewDist);

              // --- weights ---
              float jitter = (nzMid.b - 0.5) * 0.10;
              float highland = smoothstep(14.0, 42.0, hAbove);
              float rockSlope = smoothstep(0.19 + jitter, 0.40 + jitter, slope);
              rockSlope *= smoothstep(0.20, 0.66, 0.42 + 0.8 * (nzMid.b - 0.5) + 0.6 * (nzMacro.g - 0.5) + 1.1 * smoothstep(0.28, 0.50, slope));
              float steep = smoothstep(0.30, 0.47, slope);
              float cut = smoothstep(0.26, 0.44, slope) * (1.0 - highland);
              float rock = rockSlope * mix(0.62, 1.0, highland) * mix(0.55, 1.0, smoothstep(0.26, 0.46, slope));
              rock = max(rock, ridgeF * smoothstep(0.28, 0.50, slope) * highland * 0.55
                * smoothstep(0.38, 0.74, 0.45 + 0.7 * (nzMid.b - 0.5) + 0.5 * (nzMacro.g - 0.5)));
              rock = max(rock, ctrl.a * smoothstep(0.06, 0.20, slope + ctrl.a * 0.3));
              float cutRock = cut * smoothstep(0.32, 0.62, 0.45 + 0.55 * nzMid.r + 0.3 * (nzMacro.b - 0.5));
              rock = max(rock, cutRock * 0.45);
              float scree = smoothstep(0.17, 0.30, slope) * (1.0 - rockSlope) * smoothstep(0.38, 0.68, 0.5 + 0.6 * (nzMacro.g - 0.5) + 0.5 * (nzMid.b - 0.5));
              float bankDirt = cut * 0.38 + scree * 0.14;
              // wet band: a darkening of whatever lies at the waterline
              float wetK = (1.0 - smoothstep(0.15, 2.2 + 1.3 * nzMid.r, shoreD)) * smoothstep(-1.1, -0.05, shoreD);
              float bed = smoothstep(0.15, -2.2, shoreD);
              float sandBreak = smoothstep(0.30, 0.72, ctrl.b * 1.45 + 0.42 * (nzMid.b - 0.5) + 0.34 * (nzMacro.b - 0.5));
              float sand = sandBreak * (1.0 - smoothstep(0.10, 0.24, slope));
              // snow: noisy, aspect-dependent line; wide soft transition, hollow accumulation
              vec4 nzSnowA = texture(uNoise, vTWorld / 1500.0 + 0.23);
              vec4 nzSnowB = texture(uNoise, vTWorld / 620.0 + 0.61);
              float northness = clamp(-gN.z * 2.5, 0.0, 1.0) * smoothstep(0.06, 0.25, slope);
              float snowLine = uSnowLine + 100.0 * (nzSnowA.r - 0.5) + 44.0 * (nzSnowB.r - 0.5) + 14.0 * (nzMid.g - 0.5) - 25.0 * northness + 30.0 * (curv - 0.5);
              float snowSlope = 1.0 - smoothstep(0.16, 0.62, slope + 0.16 * (nzMid.r - 0.5) + 0.12 * (nzMacro.g - 0.5));
              float snow = smoothstep(snowLine - 70.0, snowLine + 80.0, vWorld.y) * snowSlope;
              snow *= smoothstep(0.24, 0.78, 0.30 + 0.70 * (nzMid.b * 0.5 + nzSmall.r * 0.3 + nzMacro.g * 0.2)
                + 1.30 * smoothstep(snowLine - 5.0, snowLine + 95.0, vWorld.y));
              float patches = smoothstep(snowLine - 95.0, snowLine - 10.0, vWorld.y)
                * smoothstep(0.46, 0.92, nzMid.r * 0.5 + nzSnowB.g * 0.5 + 0.18 * (1.0 - smoothstep(0.05, 0.2, slope)) + 0.25 * (0.5 - curv))
                * (1.0 - smoothstep(0.12, 0.30, slope));
              snow = max(snow, patches * 0.9);
              float farFade = 1.0 - 0.55 * smoothstep(150.0, 600.0, viewDist);
              float wMud = bed * 0.55 * (1.0 - sand) * farFade;
              float wSand = sand * (1.0 - wMud);
              float wRock = rock * (1.0 - wMud - wSand);
              float rest = max(0.0, 1.0 - wMud - wSand - wRock);
              float wForest = smoothstep(0.25, 0.85, canopy) * (0.42 + 0.38 * smoothstep(0.35, 0.7, nzMid.b)) * rest;
              float wDirt = clamp(max(ctrl.g, bankDirt), 0.0, 1.0) * (rest - wForest);
              float wDry = clamp(ctrl.r * 0.52 + scree * 0.10, 0.0, 1.0) * (rest - wForest - wDirt);
              float wGrass = max(0.0, rest - wForest - wDirt - wDry);
              float snowW = snow * (1.0 - 0.42 * wRock);
              float keep = 1.0 - snowW;
              wMud *= keep; wSand *= keep; wRock *= keep; wForest *= keep; wDirt *= keep; wDry *= keep; wGrass *= keep;

              // regional colour drift
              vec3 region = mix(vec3(0.95, 1.00, 0.94), vec3(1.03, 1.00, 0.90), smoothstep(0.30, 0.72, nzReg.r * 0.65 + nzHuge.g * 0.35));
              region *= 0.96 + 0.08 * nzReg.g;

              vec3 alb = vec3(0.0); vec3 nP = vec3(0.0); float rgh = 0.0; float ao = 0.0;
              vec4 a; vec4 n;
              if (wGrass > 0.004) {
                sampleLayer(0.0, vTWorld, uScales[0], blend, macroW, a, n);
                vec3 tint = mix(vec3(0.44, 0.50, 0.32), vec3(0.60, 0.58, 0.37), smoothstep(0.30, 0.78, nzMacro.r * 0.7 + 0.3 * curv));
                tint = mix(tint, tint * vec3(0.88, 1.02, 0.92), smoothstep(0.5, 0.18, curv));
                alb += a.rgb * tint * region * wGrass; nP += tangentPert(n) * 1.35 * wGrass; rgh += mix(0.94, 1.06, n.a) * wGrass;
              }
              if (wDry > 0.004) {
                sampleLayer(1.0, vTWorld, uScales[1], blend, macroW, a, n);
                vec3 tint = mix(vec3(0.44, 0.46, 0.32), vec3(0.56, 0.54, 0.38), nzMacro.g);
                alb += a.rgb * tint * region * wDry; nP += tangentPert(n) * 1.35 * wDry; rgh += (0.95 + 0.13 * n.a) * wDry;
              }
              if (wDirt > 0.004) {
                sampleLayer(2.0, vTWorld, uScales[2], blend, macroW, a, n);
                vec3 tint = mix(vec3(0.46, 0.40, 0.31), vec3(0.63, 0.57, 0.45), nzMacro.b * 0.6 + 0.4 * (1.0 - cut));
                alb += a.rgb * tint * wDirt; nP += tangentPert(n) * 1.4 * wDirt; rgh += (1.06 + 0.12 * n.a) * wDirt;
              }
              if (wForest > 0.004) {
                sampleLayer(7.0, vTWorld, uScales[7], blend, macroW, a, n);
                vec3 tint = mix(vec3(0.26, 0.25, 0.18), vec3(0.38, 0.35, 0.25), nzMacro.b);
                alb += a.rgb * tint * wForest; nP += tangentPert(n) * wForest; rgh += (0.98 + 0.11 * n.a) * wForest;
              }
              if (wRock > 0.004 || snowW > 0.004) {
                vec3 w3 = pow(abs(gN), vec3(5.0)); w3 /= (w3.x + w3.y + w3.z);
                vec3 rpA, rpB; float rrA, rrB; vec4 aA, aB;
                float bigF = 0.42 * (1.0 - smoothstep(260.0, 850.0, viewDist));
                sampleRockLayer(3.0, vWorld, w3, uScales[3], bigF, aA, rpA, rrA);
                sampleRockLayer(6.0, vWorld, w3, uScales[6], 0.0, aB, rpB, rrB);
                float rockMix = clamp(smoothstep(0.35, 0.65, nzHuge.b + 0.35 * (nzMid.r - 0.5)) * 0.6 + 0.55 * smoothstep(30.0, 150.0, hAbove), 0.0, 1.0);
                vec4 ar = mix(aA, aB, rockMix); vec3 rp = mix(rpA, rpB, rockMix); float rr = mix(rrA, rrB, rockMix);
                float strataF = smoothstep(0.3, 0.55, slope) * (1.0 - smoothstep(180.0, 620.0, viewDist));
                float strata = 1.0 - (0.16 + 0.14 * cut) * strataF + (0.30 + 0.20 * cut) * strataF * smoothstep(0.25, 0.75, fract(vWorld.y * 0.11 + nzMid.g * 0.5));
                vec3 lowTint = vec3(0.86, 0.79, 0.66);
                vec3 highTint = vec3(0.92, 0.90, 0.93);
                vec3 tint = mix(lowTint, highTint, smoothstep(20.0, 130.0, hAbove)) * mix(0.90, 1.10, nzMacro.r) * strata;
                tint *= mix(1.0, 0.95, smoothstep(0.62, 0.88, slope));
                tint = mix(tint, vec3(0.98, 0.84, 0.66) * strata, cut * (0.35 + 0.35 * smoothstep(0.7, 0.3, fract(vWorld.y * 0.11 + nzMid.g * 0.5 + 0.5))));
                tint = mix(tint, tint * vec3(0.70, 0.90, 0.58), smoothstep(0.42, 0.78, nzMid.r * 0.6 + nzMacro.g * 0.4) * (1.0 - smoothstep(0.32, 0.55, slope)) * 0.75);
                alb += ar.rgb * tint * wRock; nP += rp * (1.5 + 1.0 * steep) * wRock; rgh += mix(0.88, 1.00, clamp(rr, 0.0, 1.0)) * wRock;
                float scour = smoothstep(0.15, 0.3, slope) * 0.14 + smoothstep(0.6, 0.85, curv) * 0.08;
                vec3 snowCol = vec3(0.74, 0.78, 0.85) * (0.84 + 0.16 * nzMid.b) * (1.0 - scour);
                alb += snowCol * snowW; nP += rp * 0.4 * snowW; rgh += (0.44 + 0.14 * nzMid.b) * snowW;
              }
              if (wSand > 0.004) {
                sampleLayer(4.0, vTWorld, uScales[4], blend, macroW, a, n);
                vec3 tint = mix(vec3(0.44, 0.40, 0.33), vec3(0.58, 0.53, 0.43), nzMacro.g);
                alb += a.rgb * tint * wSand; nP += tangentPert(n) * 1.2 * wSand; rgh += (1.00 + 0.11 * n.a) * wSand;
              }
              if (wMud > 0.004) {
                sampleLayer(5.0, vTWorld, uScales[5], blend, macroW, a, n);
                alb += a.rgb * vec3(0.52, 0.48, 0.40) * wMud; nP += tangentPert(n) * 1.1 * wMud; rgh += (0.62 + 0.18 * n.a) * wMud;
              }

              // --- near-field micro detail ---
              float grassLike = wGrass + wDry + wForest * 0.6;
              if (nearF > 0.01 && grassLike > 0.02) {
                vec3 duv = vec3(vTWorld / 0.55, 0.0);
                vec4 dA = texture(uAlbedo, duv);
                vec4 dN = texture(uNormalArr, duv);
                float lumMean = max(dot(textureLod(uAlbedo, duv, 6.0).rgb, LUMW), 0.01);
                float ratio = clamp(pow(dot(dA.rgb, LUMW) / lumMean, 1.7), 0.35, 1.7);
                float k = nearF * clamp(grassLike, 0.0, 1.0);
                alb *= mix(1.0, ratio, k * 1.0);
                nP += tangentPert(dN) * 3.6 * k;
                ao = mix(ao, ao * dA.a, k * 0.55);
                vec3 duv2 = vec3(vTWorld / 2.2 + 0.41, 0.0);
                vec4 d2 = texture(uAlbedo, duv2);
                alb *= mix(1.0, clamp(0.70 + 0.75 * dot(d2.rgb, LUMW) / max(lumMean, 0.02), 0.72, 1.35), k * 0.4);
                nP += tangentPert(texture(uNormalArr, duv2)) * 1.0 * k;
              }
              if (midF > 0.01 && (wGrass + wDry) > 0.02) {
                vec4 nzFine = texture(uNoise, vTWorld / 6.0 + 0.13);
                vec4 nzFine2 = texture(uNoise, vTWorld / 2.1 + 0.63);
                float wornP = smoothstep(0.70, 0.86, nzFine.g * 0.45 + nzFine2.b * 0.35 + nzMid.b * 0.2 + 0.10 * wDry + 0.10 * smoothstep(0.04, 0.14, grade)) * clamp(wGrass + wDry, 0.0, 1.0) * midF;
                if (wornP > 0.003) {
                  vec3 puv = vec3(vTWorld / 2.2 + 0.2, 2.0);
                  vec4 pA = texture(uAlbedo, puv);
                  vec4 pN = texture(uNormalArr, puv);
                  alb = mix(alb, pA.rgb * vec3(0.70, 0.63, 0.51), wornP * 0.55);
                  nP = mix(nP, tangentPert(pN) * 1.8, wornP * 0.7);
                  rgh = mix(rgh, 1.06 + 0.10 * pN.a, wornP * 0.6);
                }
              }

              // --- geology, not airbrush ---
              float cav = (curv - 0.5) * 2.0;
              float turf = clamp(wGrass + wDry + wForest, 0.0, 1.0);
              alb *= mix(vec3(1.0), vec3(0.70, 0.79, 0.66), clamp(-cav, 0.0, 1.0) * 0.45 * turf);
              alb *= mix(vec3(1.0), vec3(0.60, 0.72, 0.56), valleyF * 0.62 * turf);
              alb *= mix(vec3(1.0), vec3(1.05, 1.02, 0.94), clamp(cav, 0.0, 1.0) * 0.30 * turf);
              alb *= mix(vec3(1.0), vec3(1.03, 1.01, 0.96), ridgeF * 0.20 * turf);
              // contour bedding / soil-creep terracettes (distance-faded against chunk mesh moire)
              float bedF = smoothstep(0.10, 0.30, slope) * (1.0 - smoothstep(140.0, 520.0, viewDist));
              float band = fract(vWorld.y * 0.30 + nzMacro.r * 1.7 + nzMid.g * 0.6);
              float bedBand = smoothstep(0.18, 0.46, band) - smoothstep(0.56, 0.86, band);
              alb *= 1.0 + (bedBand - 0.28) * 0.10 * bedF;
              alb *= mix(vec3(1.0), vec3(1.03, 0.99, 0.93), max(bedBand - 0.3, 0.0) * bedF * 0.7);
              alb *= 0.97 + 0.06 * nzMid.r;
              // 6-19 m cover mottling
              float small = (nzSmall.b * 0.55 + nzSmall.g * 0.45 - 0.5) * (1.0 - smoothstep(120.0, 380.0, viewDist));
              alb *= mix(vec3(1.0), vec3(0.88, 0.98, 0.84), clamp(small * 1.5, 0.0, 1.0) * (wGrass + wDry));
              alb *= mix(vec3(1.0), vec3(1.05, 1.02, 0.93), clamp(-small * 1.5, 0.0, 1.0) * (wGrass + wDry));
              // rain: wet ground is darker and MUCH glossier
              float wetRain = uWetness * (1.0 - 0.55 * snowW);
              alb *= mix(1.0, 0.70, wetRain);
              rgh = mix(rgh, 0.26, wetRain * 0.88);
              // wet shoreline band
              float wetShore = wetK * farFade;
              alb *= mix(1.0, 0.62, wetShore);
              rgh = mix(rgh, 0.235, wetShore * 0.92 * (1.0 - 0.55 * uNight));
              // global slight desaturation towards a warm grey
              alb = mix(alb, vec3(dot(alb, LUMW)) * vec3(1.04, 1.0, 0.92), 0.24);
              // night: vegetated ground goes fully matte and takes a cool cast
              float veg = clamp(wGrass + wDry + wForest, 0.0, 1.0);
              rgh = mix(rgh, max(rgh, 1.06), uNight * veg * 0.85 * (1.0 - uWetness));
              alb *= mix(vec3(1.0), vec3(0.90, 0.96, 1.14), uNight * 0.5);
              // shore cover never glows after dark
              float shoreCover = clamp(wSand + wMud + wetShore + snowW * 0.5, 0.0, 1.0);
              alb = mix(alb, alb * vec3(0.17, 0.20, 0.25), uNight * shoreCover);
              // moonlit modelling
              float moonWrap = clamp(dot(gN, normalize(uMoonDir)) * 0.62 + 0.38, 0.0, 1.0);
              alb *= mix(1.0, 0.88 + 0.30 * moonWrap * moonWrap, uNight);
              // real ground never reflects more than ~55 % (only snow goes higher)
              alb = min(alb, vec3(0.32) + vec3(0.34) * snowW);
              tAlbedo = alb;
              tRough = clamp(rgh, mix(mix(0.24, 0.80, veg), 0.90, uNight * veg), 1.28);
              tAO = mix(1.0, ao, 0.8);
              // night sky bounce
              {
                float tw = clamp(dot(gN, normalize(uMoonDir)) * 0.5 + 0.5, 0.0, 1.0);
                tNightFill = vec3(0.160, 0.196, 0.300) * uNight * (0.30 + 0.50 * clamp(gN.y, 0.0, 1.0) + 0.55 * tw * tw)
                  * (1.0 - 0.55 * shoreCover);
              }
              vec3 pert = vec3(nP.x, 0.0, nP.z) * (0.9 * detail * detail);
              tNormalWorld = normalize(gN + pert);
            }

            // ---------------- lighting (site aomap_fragment + standard material on native lights) ----
            vec3 Nw = normalize(tNormalWorld);
            float ndl = max(dot(Nw, uSunDir), 0.0);
            float cs = 1.0;
            if (uShadowStrength > 0.001) {
                float t = (1000.0 - vWorld.y) / max(uLightToward.y, 0.05);
                cs = texture(uCloudShadow, (vWorld.xz + uLightToward.xz * t) / 22000.0).r;
            }
            vec3 indirect = tAlbedo * uAmbient * tAO;
            // night sky bounce: nearly achromatic, models the relief without painting the ground green
            indirect += mix(vec3(dot(tAlbedo, LUMW)), tAlbedo, 0.3) * tNightFill;
            // daytime sky/bounce fill: shadowed ground must read as shadow, not as a hole
            indirect += tAlbedo * uSunColor * 0.038 * tAO;
            // hard sky-bounce floor (CS2 measures 0.00 % pure-black pixels in reference frames)
            vec3 skyFill = uAmbient;
            indirect = max(indirect, tAlbedo * skyFill * 0.85 * tAO);
            vec3 albMin = max(tAlbedo, tAlbedo * 0.80 + vec3(0.030, 0.034, 0.024));
            indirect = max(indirect, albMin * skyFill * 1.95 * tAO);
            // direct sun + GGX specular lobe — tRough carries the wet/night roughness work
            vec3 V = normalize(uCamPos - vWorld);
            vec3 H = normalize(V + uSunDir);
            float a = tRough * tRough;
            float ndh = max(dot(Nw, H), 0.0);
            float vdh = max(dot(V, H), 0.0);
            float dnm = ndh * ndh * (a * a - 1.0) + 1.0;
            float D = (a * a) / (3.14159265 * dnm * dnm);
            float kk = (tRough + 1.0) * (tRough + 1.0) / 8.0;
            float ndv = max(dot(Nw, V), 1e-3);
            float G = (ndl / (ndl * (1.0 - kk) + kk)) * (ndv / (ndv * (1.0 - kk) + kk));
            float F = 0.04 + 0.96 * pow(1.0 - vdh, 5.0);
            vec3 spec = (D * G * F / max(4.0 * ndv * ndl, 1e-4)) * uSunColor * ndl * cs;
            vec3 col = (indirect + tAlbedo * uSunColor * ndl * cs + spec) * uTint;
            // weather snow accumulation on top of the analytic caps (WetSurfaces snow hook)
            col = mix(col, vec3(0.82, 0.85, 0.90) * (uAmbient + uSunColor * ndl * cs) * 1.35, uSnow * 0.72);
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * uFogDensity);
            fragColor = vec4(mix(col, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    // ---------------------------------------------------------------- puddles -------------------

    val VS_PUDDLE = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        layout(location=1) in float aAlpha;
        uniform mat4 uVP;
        out vec3 vWorld;
        out float vAlpha;
        void main() {
            vWorld = aPos;
            vAlpha = aAlpha;
            gl_Position = uVP * vec4(aPos, 1.0);
        }
    """.trimIndent()

    // effects/PuddleField.js PUDDLE_PARS + PUDDLE_INJECT, plus the planar-reflection mirror
    // standing in for the MeshPhysicalMaterial env probe + GroundFXPass scene composite.
    val FS_PUDDLE = """
        #version 300 es
        precision highp float;
        in vec3 vWorld;
        in float vAlpha;
        in vec4 vReflUv;
        uniform vec3 uCamPos;
        uniform float uPudTime;
        uniform float uPudRain;
        uniform float uPudWet;
        uniform float uPudFade;
        uniform vec3 uAmbient;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        out vec4 fragColor;

        ${FX_NOISE_GLSL}

        vec2 pudRings(vec2 p, float t, float speed) {
          vec2 g = vec2(0.0);
          vec2 cell = floor(p);
          for (int j = -1; j <= 0; j++) for (int i = -1; i <= 0; i++) {
            vec2 c = cell + vec2(float(i), float(j));
            vec2 h = fxHash2(c);
            vec2 centre = c + 0.5 + (h - 0.5) * 0.9;
            float ph = fract(t * speed + h.x * 7.31 + h.y * 3.17);
            vec2 d = p - centre;
            float r = length(d);
            float ring = ph * 0.8;
            float w = 0.04 + ph * 0.05;
            float x = (r - ring) / w;
            float amp = exp(-x * x) * (1.0 - ph) * (1.0 - ph);
            g += (d / max(r, 1e-3)) * amp * (-2.0 * x / w);
          }
          return g;
        }

        void main() {
            float pudDist = length(uCamPos - vWorld);
            // slow surface undulation: a real pool is never an optically flat mirror
            vec2 wob = vec2(
              fxValueNoise(vWorld.xz * 1.25 + vec2(uPudTime * 0.07, 0.0)) - 0.5,
              fxValueNoise(vWorld.xz * 1.25 + vec2(0.0, uPudTime * 0.07) + 19.0) - 0.5);
            vec2 g = wob * 0.55;
            // rain impact rings, near the camera only (they are 10-30 cm features)
            float rip = uPudRain * (1.0 - smoothstep(30.0, 85.0, pudDist));
            if (rip > 0.002) {
              g += (pudRings(vWorld.xz * 2.4, uPudTime, 2.4) * 0.6 + pudRings(vWorld.xz * 1.15 + 5.0, uPudTime, 1.6) * 0.4) * rip * 0.55;
            }
            vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
            vec3 V = normalize(uCamPos - vWorld);
            float ndv = clamp(dot(n, V), 0.0, 1.0);
            float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
            // dark water bed; the mirror IMAGE is the sky probe (GroundFXPass scene composite is a
            // later native slice — the sky Fresnel + glint carry the wet-mirror read for now)
            vec3 col = vec3(0.006, 0.0075, 0.009) * (uAmbient * 3.0 + 0.03);
            col += uAmbient * F * 1.9;
            // sun glint (roughness 0.06 dielectric)
            vec3 H = normalize(V + uSunDir);
            float spec = pow(max(dot(n, H), 0.0), 220.0) * 0.9;
            col += uSunColor * spec * max(dot(vec3(0.0, 1.0, 0.0), uSunDir), 0.0);
            // dry → gone; far → gone (a 2 m pool under 2 px is nothing but specular aliasing)
            float alpha = vAlpha * uPudWet * (1.0 - smoothstep(uPudFade * 0.62, uPudFade, pudDist));
            if (alpha < 0.004) discard;
            float fog = 1.0 - exp(-pudDist * uFogDensity);
            fragColor = vec4(mix(col, uFogColor, fog), alpha);
        }
    """.trimIndent()

    // ---------------------------------------------------------------- lit ground (flat) ---------
    // FS_LIT upgrade: the WetSurfaces.js wet branch (drainage-map puddles, damp rim, sky sheen)
    // and snow branch (noise coverage, ploughed tyre bands from the drainage G channel) — for the
    // city ground / road ribbons. The terrain splat shader handles itself.
    val FS_LIT_WET = """
        #version 300 es
        precision highp float;
        in vec3 vColor;
        in vec3 vWorld;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uWetness;
        uniform float uSnow;
        uniform vec3 uCamPos;
        uniform vec3 uTint;
        uniform sampler2D uCloudShadow;
        uniform float uShadowStrength;
        uniform vec3 uLightToward;
        uniform sampler2D uFxPoolMap;
        uniform vec4 uFxPoolXf;
        uniform float uFxTime;
        uniform float uFxPuddle;
        uniform float uFxTrack;
        uniform vec4 uRoad;        // segLen, segHash, lampTerm (0/1), uCwHalf
        uniform vec4 uLamp;        // spacing, headLat, alternate, height (RoadTypes.js lamps)
        uniform float uLampRadius;
        uniform vec3 uLampColor;
        uniform float uNight;
        in vec4 vRoad;             // (lat, along, dA, dB) in the road's own frame, metres
        out vec4 fragColor;

        // pool -> emitted radiance (soft saturation so overlapping pools do not blow out)
        float rdTone(float p) { return p / (1.0 + 0.7 * p); }

        ${FX_NOISE_GLSL}

        vec3 fxDrainage(vec2 xz) {
          if (uFxPoolXf.w < 0.5) return vec3(0.0);
          vec2 uv = (xz - uFxPoolXf.xy) * uFxPoolXf.z;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
          return texture(uFxPoolMap, uv).rgb;
        }

        void main() {
            float ndl = max(dot(normalize(vec3(0.0, 1.0, 0.0)), uSunDir), 0.0);
            float cs = 1.0;
            if (uShadowStrength > 0.001) {
                float t = (1000.0 - vWorld.y) / max(uLightToward.y, 0.05);
                cs = texture(uCloudShadow, (vWorld.xz + uLightToward.xz * t) / 22000.0).r;
            }
            float d = length(uCamPos - vWorld);
            vec3 V = normalize(uCamPos - vWorld);
            vec3 alb = vColor * uTint;
            vec3 col = alb * (uAmbient + uSunColor * ndl * cs);
            float fxW = uWetness * uFxPuddle;
            if (fxW > 0.002) {
                // flat upward faces: albedo x0.55, and the puddle field from the drainage map
                col *= 1.0 - 0.45 * fxW;
                vec3 drain = fxDrainage(vWorld.xz);
                float offRoad = 1.0 - smoothstep(0.25, 0.65, drain.b);
                float pn = fxValueNoise(vWorld.xz * 0.20) * 0.70 + fxValueNoise(vWorld.xz * 0.52 + 17.3) * 0.30;
                float thr = 0.735 - 0.075 * fxW;
                float fill = smoothstep(0.22, 0.70, fxW);
                float rim = smoothstep(thr - 0.09, thr, pn) * fill;
                float mask = smoothstep(thr - 0.005, thr + 0.022, pn) * fill;
                float distF = (1.0 - smoothstep(120.0, 320.0, d)) * offRoad;
                float pud = mask * distF;
                rim *= distF;
                if (rim > 0.001) col *= 1.0 - 0.16 * rim;                     // saturated damp shore
                if (pud > 0.001) {
                    // standing water over a dark bed at roughness 0.06
                    col = mix(col, alb * 0.18 * (uAmbient + uSunColor * ndl * cs), pud);
                    float F = 0.03 + 0.97 * pow(1.0 - max(dot(vec3(0.0, 1.0, 0.0), V), 0.0), 4.0);
                    col += uAmbient * F * pud * 0.15;                         // Fresnel sky mirror
                }
                // the sheen a wet surface owes the sky
                float Fw = 0.04 + 0.96 * pow(1.0 - max(dot(vec3(0.0, 1.0, 0.0), V), 0.0), 5.0);
                col += uAmbient * fxW * Fw * 0.045;
            }
            if (uSnow > 0.002) {
                // metre-scale drift field, ploughed tyre bands from the drainage G channel
                float sn = fxValueNoise(vWorld.xz * 0.30) * 0.55 + fxValueNoise(vWorld.xz * 1.05 + 7.0) * 0.30
                         + fxValueNoise(vWorld.xz * 3.7) * 0.15;
                float drift = fxValueNoise(vWorld.xz * 0.11 + 41.0);
                float cov = clamp(uSnow * (0.80 + 0.45 * drift), 0.0, 1.0);
                float slush = 0.0;
                float band = 0.30;
                if (uFxTrack > 0.5) {
                    float g = fxDrainage(vWorld.xz).g;
                    slush = smoothstep(0.18, 0.85, g) * smoothstep(0.02, 0.15, uSnow);
                    cov *= 1.0 - 0.98 * slush;
                    band = mix(band, 0.11, smoothstep(0.1, 0.5, g));
                }
                float thr = 1.0 - cov;
                float snowW = smoothstep(thr - band, thr + 0.10, sn) * smoothstep(0.02, 0.2, uSnow);
                if (slush > 0.001) col *= 1.0 - 0.40 * slush * (1.0 - snowW);  // wet dark slush in the ruts
                if (snowW > 0.001) {
                    float mottle = fxValueNoise(vWorld.xz * 0.22 + 13.0);
                    vec3 snowCol = vec3(0.955, 0.965, 0.995) * (0.88 + 0.12 * sn) * (0.93 + 0.09 * drift) * (0.94 + 0.11 * mottle);
                    col = mix(col, snowCol * (uAmbient + uSunColor * ndl * cs) * 1.35, snowW);
                }
            }
            // ---- analytic street-lamp pools (RoadMaterials.js GLSL_NIGHT_ASPHALT, diffuse half;
            //      the view-dependent GGX streaks arrive through the GroundFX emitter pass) ----
            if (uRoad.z > 0.5 && uNight > 0.001 && uLamp.x > 0.0 && abs(vRoad.x) < 500.0) {
                float lat = vRoad.x; float along = vRoad.y; float dA = vRoad.z; float dB = vRoad.w;
                float spacing = uLamp.x;
                float diff = 0.0;
                float i0 = floor(along / spacing - 0.5);
                for (int k = -1; k <= 1; k++) {
                    float i = i0 + float(k);
                    float ds = (i + 0.5) * spacing - along;
                    if (dA + ds < 3.0 || dB - ds < 3.0) continue;   // LAMP_MARGIN 3 m from the ends
                    float side = uLamp.z > 0.5 ? (mod(i, 2.0) < 0.5 ? 1.0 : -1.0) : 0.0;
                    // ±18 % per-luminaire output (age, dirt, lamp type) keyed off the same index
                    // the instances use — a row of subtly different pools, never one glowing tube
                    float g = 0.82 + 0.36 * fract(sin(i * 12.9898 + uRoad.y * 4.1414) * 43758.5453);
                    float dl = side * uLamp.y - lat;
                    float d2 = dl * dl + ds * ds;
                    float win = 1.0 - smoothstep(uLampRadius * 0.3, uLampRadius, sqrt(d2));
                    if (win > 0.0) {
                        win *= g;
                        float h2 = uLamp.w * uLamp.w;
                        float D2 = d2 + h2;
                        diff += h2 * uLamp.w / (D2 * sqrt(D2)) * win;
                    }
                }
                float gain = uNight * mix(1.0, 0.45, smoothstep(180.0, 620.0, d));
                col += uLampColor * (alb * (rdTone(diff) * 0.55)) * gain;
            }
            float fog = 1.0 - exp(-d * uFogDensity);
            fragColor = vec4(mix(col, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    // ---------------------------------------------------------------- trees ---------------------
    // Instanced crossed-card trees carrying the Vegetation.js placement: per-instance pos/yaw/
    // scale/colour, wind sway on the crown, wrap-lit canopy (normals lean towards the sky like
    // the site's leaf material), cloud shadows, night fill, fog.

    val VS_TREES = """
        #version 300 es
        layout(location=0) in vec3 aPos;      // card corner: x in [-0.5, 0.5], y in [0, 1], z = layer bias
        layout(location=1) in vec2 aUv;
        layout(location=2) in vec4 aInstA;    // x, y (ground), z, yaw
        layout(location=3) in vec4 aInstB;    // sxz, sy, kind, 0
        layout(location=4) in vec4 aInstC;    // r, g, b, windPhase
        uniform mat4 uVP;
        uniform float uTime;
        uniform float uWindAmp;
        out vec2 vUv;
        out vec3 vWorld;
        out vec3 vTint;
        out float vKind;
        flat out float vLayer;
        void main() {
            float yaw = aInstA.w;
            float c = cos(yaw), s = sin(yaw);
            vec3 p = aPos;
            float sy = aInstB.y;
            float sxz = aInstB.x;
            // wind sway: the crown bends, the base does not (Vegetation.js windUniforms semantics)
            float bend = pow(max(p.y, 0.0), 1.5) * uWindAmp;
            float ph = aInstC.w + uTime * 1.35;
            vec2 sway = vec2(sin(ph) + 0.4 * sin(ph * 2.33 + 1.7), cos(ph * 0.87) + 0.4 * sin(ph * 1.91)) * bend;
            vec3 local = vec3(p.x * sxz, p.y * sy, p.z * 0.35);
            vec3 world = vec3(
                aInstA.x + local.x * c - local.z * s + sway.x,
                aInstA.y + local.y + sway.y * 0.4,
                aInstA.z + local.x * s + local.z * c + sway.y);
            vWorld = world;
            vUv = aUv;
            vTint = aInstC.rgb;
            vKind = aInstB.z;
            vLayer = aPos.z;
            gl_Position = uVP * vec4(world, 1.0);
        }
    """.trimIndent()

    val FS_TREES = """
        #version 300 es
        precision highp float;
        in vec2 vUv;
        in vec3 vWorld;
        in vec3 vTint;
        in float vKind;
        flat in float vLayer;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uCamPos;
        uniform sampler2D uLeafTex0;
        uniform sampler2D uLeafTex1;
        uniform sampler2D uLeafTex2;
        uniform sampler2D uLeafTex3;
        uniform sampler2D uLeafTex4;
        uniform sampler2D uCloudShadow;
        uniform float uShadowStrength;
        uniform vec3 uLightToward;
        uniform float uNight;
        out vec4 fragColor;

        vec4 leafSample(float kind) {
            vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
            if (kind < 0.5) return texture(uLeafTex0, uv);
            if (kind < 1.5) return texture(uLeafTex1, uv);
            if (kind < 2.5) return texture(uLeafTex2, uv);
            if (kind < 3.5) return texture(uLeafTex3, uv);
            if (kind < 4.5) return texture(uLeafTex4, uv);
            if (kind < 5.5) return texture(uLeafTex0, uv);
            if (kind < 6.5) return texture(uLeafTex1, uv);
            if (kind < 7.5) return texture(uLeafTex3, uv);
            if (kind < 8.5) return texture(uLeafTex4, uv);
            return texture(uLeafTex0, uv);
        }

        void main() {
            vec4 tex = leafSample(vKind);
            if (tex.a < 0.35) discard;
            // canopy shading: cards lean their normal to the sky (the site's leaf material trick)
            vec3 n = normalize(mix(vec3(0.0, 1.0, 0.0), vec3(0.0, 0.62, 0.55), 0.35 + 0.3 * abs(fract(vLayer * 7.13) - 0.5)));
            float ndl = max(dot(n, uSunDir), 0.0);
            float cs = 1.0;
            if (uShadowStrength > 0.001) {
                float t = (1000.0 - vWorld.y) / max(uLightToward.y, 0.05);
                cs = texture(uCloudShadow, (vWorld.xz + uLightToward.xz * t) / 22000.0).r;
            }
            // cheap wrap transmission so backlit foliage glows (makeLeafMaterial wrap term)
            float wrap = clamp((dot(n, uSunDir) + 0.4) / 1.4, 0.0, 1.0);
            vec3 col = tex.rgb * vTint * (uAmbient * (0.75 + 0.5 * n.y) + uSunColor * mix(ndl, wrap, 0.35) * cs);
            // night: foliage sinks into the sky fill like everything else
            col = mix(col, tex.rgb * vTint * uAmbient * 1.15, uNight * 0.75);
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * uFogDensity);
            fragColor = vec4(mix(col, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    /**
     * Undergrowth (Vegetation.js _buildUndergrowth + _updateUndergrowth, GLSL ES 3.0): instanced
     * crossed cards with the web material's exact behaviour — 8-cell atlas remap, root-shadow
     * gradient (bottom fifth darkens into the turf), mip alpha boost 0.45, stochastic alpha test
     * at 0.42, the camera-radius alpha fade, windPatch(0.2, [0, 0.9]) sway, up-facing normals and
     * the SKY_FLOOR indirect clamp. The atlas is uploaded row-flipped so the site's flipY cell
     * mapping reproduces texel-for-texel.
     */
    val VS_UNDERGROWTH = """
        #version 300 es
        layout(location=0) in vec3 aPos;      // card corner (y 0..1), 3 cards baked rotated
        layout(location=1) in vec3 aNormal;   // forced up (0,1,0) — turf is lit by the sky
        layout(location=2) in vec2 aUv;
        layout(location=3) in vec4 aInstA;    // x, y (ground), z, yaw
        layout(location=4) in vec4 aInstB;    // sx, sy, variant, 0
        layout(location=5) in vec4 aInstC;    // r, g, b, 0
        uniform mat4 uVP;
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        out vec2 vUv;
        out float vCardY;
        out vec3 vWorld;
        out vec3 vTint;
        flat out float aVar;
        void main() {
            float yaw = aInstA.w;
            float c = cos(yaw), s = sin(yaw);
            vec3 p = aPos;
            // windPatch(shader, windUniforms, 0.2, [0.0, 0.9]) — the exact web sway
            float phase = dot(aInstA.xz, vec2(0.031, 0.047)) + uTime * 1.15;
            float heightF = smoothstep(0.0, 0.9, p.y);
            float sway = (sin(phase) * 0.6 + sin(phase * 2.17 + 1.3) * 0.4) * uWindStrength * 0.2 * heightF;
            vec3 local = vec3(p.x * aInstB.x, p.y * aInstB.y, p.z * aInstB.x);
            local.xz += uWindDir * sway;
            local += aNormal * sin(uTime * 3.3 + phase * 4.0 + p.y * 2.0) * 0.04 * uWindStrength * heightF;
            vec3 world = vec3(
                aInstA.x + local.x * c - local.z * s,
                aInstA.y + local.y,
                aInstA.z + local.x * s + local.z * c);
            vWorld = world;
            vUv = aUv;
            vCardY = aUv.y;
            vTint = aInstC.rgb;
            aVar = aInstB.z;
            gl_Position = uVP * vec4(world, 1.0);
        }
    """.trimIndent()

    val FS_UNDERGROWTH = """
        #version 300 es
        precision highp float;
        in vec2 vUv;
        in float vCardY;
        in vec3 vWorld;
        in vec3 vTint;
        flat in float aVar;
        uniform sampler2D uAtlas;
        uniform vec2 uGrassCenter;
        uniform float uGrassRadius;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uCamPos;
        uniform float uNight;
        uniform sampler2D uCloudShadow;
        uniform float uShadowStrength;
        uniform vec3 uLightToward;
        out vec4 fragColor;
        void main() {
            // vMapUv * vec2(0.25, 0.5) + cell * vec2(0.25, 0.5) — the site's 8-cell remap
            float col = mod(aVar, 4.0);
            float row = floor(aVar * 0.25 + 0.01);
            vec2 cellUv = vUv * vec2(0.25, 0.5) + vec2(col, row) * vec2(0.25, 0.5);
            vec4 tex = texture(uAtlas, cellUv);
            // MIP_ALPHA_BOOST (uMipBoost 0.45): keep cutout coverage as the cards shrink
            vec2 tsz = vec2(textureSize(uAtlas, 0));
            vec2 ddx = dFdx(cellUv * tsz); vec2 ddy = dFdy(cellUv * tsz);
            float lodF = 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy)) + 1e-6);
            tex.a *= 1.0 + max(lodF, 0.0) * 0.45;
            // camera-radius alpha fade (uGrassRadius 0.5 → 0.95)
            tex.a *= 1.0 - smoothstep(uGrassRadius * 0.5, uGrassRadius * 0.95, distance(vWorld.xz, uGrassCenter));
            // STOCHASTIC_ALPHATEST at alphaTest 0.42 — interleaved-gradient jitter dissolves card edges
            float ignA = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            if (tex.a < 0.42 * (0.62 + 0.76 * ignA)) discard;
            // root shadow: the bottom fifth of every card darkens towards the ground
            vec3 alb = tex.rgb * vTint * mix(0.84, 1.0, smoothstep(0.0, 0.3, vCardY));
            // up-facing normal (NO_FLIP_NORMAL): turf is lit by the sky, not by card facing
            vec3 n = vec3(0.0, 1.0, 0.0);
            float ndl = max(dot(n, uSunDir), 0.0);
            float cs = 1.0;
            if (uShadowStrength > 0.001) {
                float t = (1000.0 - vWorld.y) / max(uLightToward.y, 0.05);
                cs = texture(uCloudShadow, (vWorld.xz + uLightToward.xz * t) / 22000.0).r;
            }
            vec3 col3 = alb * (uAmbient * (0.75 + 0.5 * n.y) + uSunColor * ndl * cs);
            // SKY_FLOOR: nothing lit by an open sky is darker than its sky bounce, tinted by the
            // SURFACE (albMin) so shadowed undergrowth never turns blue
            vec3 skyFill = uAmbient;
            vec3 albMin = max(alb, alb * 0.80 + vec3(0.030, 0.038, 0.022));
            col3 = max(col3, albMin * skyFill * 2.10);
            // night: turf sinks into the sky fill like everything else
            col3 = mix(col3, alb * uAmbient * 1.15, uNight * 0.75);
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * uFogDensity);
            fragColor = vec4(mix(col3, uFogColor, fog), 1.0);
        }
    """.trimIndent()

    /**
     * GroundFXPass (effects/GroundFXPass.js, GLSL ES 3.0) — one depth-driven fullscreen pass:
     * screen-space wet-surface reflections (marched against the depth buffer, PuddleField
     * drainage-map pool sharpening + the fxPuddleMask world-noise pools off-road, analytic
     * emitter streaks for lamps/head-/tail-lights), contact shadows, fine 8-tap hemisphere AO,
     * aerial perspective and the night light-pollution horizon band. Bit-exact port including
     * the p5-p13 tuning constants.
     */
    val VS_GROUNDFX = """
        #version 300 es
        layout(location=0) in vec3 aPos;
        out vec2 vUv;
        void main() { vUv = aPos.xy * 0.5 + 0.5; gl_Position = vec4(aPos.xy, 0.0, 1.0); }
    """.trimIndent()

    val FS_GROUNDFX = """
        #version 300 es
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uHasDepth;
        uniform vec2 uResolution;
        uniform vec2 uNearFar;
        uniform mat4 uProj;
        uniform mat4 uProjInv;
        uniform mat4 uViewInv;
        uniform mat4 uView;
        uniform vec3 uUpView;        // world up in view space
        uniform vec3 uSunView;       // direction TOWARD the sun, view space
        uniform float uTime;
        uniform vec2 uContact;       // strength, length (m)
        uniform vec2 uAO;            // strength, radius (m)
        uniform float uWet;          // 0 dry .. 1 soaked
        uniform float uReflect;      // reflection strength multiplier
        uniform vec3 uSkyColor;      // fallback reflected radiance (renderer units)
        uniform vec4 uAerial;        // density (1/m), desaturation, lift, unused
        uniform vec3 uHaze;          // haze colour (renderer units)
        uniform float uRipple;       // rain intensity -> wobble in the mirror
        uniform vec3 uHorizon;       // ndc y of the horizon, falloff, strength
        uniform vec3 uGlowColor;
        uniform vec2 uOcclusion;     // occlusion strength, cool sky-bounce fraction
        uniform float uContactDark;  // how dark a confirmed contact patch goes
        uniform float uNight;        // 0 day .. 1 night
        uniform sampler2D uPoolMap;  // PuddleField drainage map (R pool, G tyre band, B corridor)
        uniform vec4 uPoolXf;        // originX, originZ, 1/spanMetres, hasMap
        uniform vec4 uWetLights[12];     // xyz = world position, w = intensity (0 = unused slot)
        uniform vec3 uWetLightCol[12];   // emitter radiance colour
        uniform int uWetLightN;
        in vec2 vUv;
        out vec4 fragColor;

        // FX_NOISE_GLSL (effects/wetGlsl.js) — the same puddle mask the material hook uses
        vec2 fxHash2(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.xx + p3.yz) * p3.zy);
        }
        float fxHash1(vec2 p) { return fxHash2(p).x; }
        float fxValueNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          float a = fxHash1(i), b = fxHash1(i + vec2(1.0, 0.0)), c = fxHash1(i + vec2(0.0, 1.0)), d = fxHash1(i + vec2(1.0, 1.0));
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
        float fxPuddleField(vec2 xz) {
          return fxValueNoise(xz * 0.085) * 0.68 + fxValueNoise(xz * 0.21 + 17.3) * 0.32;
        }
        float fxPuddleMask(vec2 xz, float wet, out float rim) {
          float pn = fxPuddleField(xz);
          float thr = 0.655 - 0.075 * wet;
          float fill = smoothstep(0.10, 0.55, wet);
          rim = smoothstep(thr - 0.10, thr, pn) * fill;
          return smoothstep(thr - 0.004, thr + 0.03, pn) * fill;
        }

        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        vec3 drainage(vec2 xz) {
          if (uPoolXf.w < 0.5) return vec3(0.0);
          vec2 uv = (xz - uPoolXf.xy) * uPoolXf.z;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
          return texture(uPoolMap, uv).rgb;
        }
        float rawDepth(vec2 uv) { return texture(tDepth, uv).x; }
        // three.js packing: perspectiveDepthToViewZ — negative view-space z
        float viewZ(float d) { return (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y); }
        vec3 viewPos(vec2 uv, float d) {
          vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 p = uProjInv * ndc;
          return p.xyz / p.w;
        }
        vec3 project(vec3 v) {
          vec4 c = uProj * vec4(v, 1.0);
          vec3 n = c.xyz / max(abs(c.w), 1e-6) * sign(c.w);
          return vec3(n.xy * 0.5 + 0.5, n.z * 0.5 + 0.5);
        }

        void main() {
          vec4 src = texture(tDiffuse, vUv);
          vec3 c = src.rgb;
          if (uHasDepth < 0.5) { fragColor = vec4(c, src.a); return; }

          float d0 = rawDepth(vUv);
          if (d0 >= 0.99999) {
            // sky: only the night light-pollution band above the horizon
            if (uHorizon.z > 0.0001) {
              float dy = (vUv.y * 2.0 - 1.0) - uHorizon.x;
              float band = exp(-max(dy, 0.0) * uHorizon.y) * smoothstep(-0.10, 0.0, dy);
              c += uGlowColor * (luma(c) * 1.4 + 0.0012) * band * uHorizon.z;
            }
            fragColor = vec4(c, src.a);
            return;
          }

          vec2 texel = 1.0 / uResolution;
          vec3 P = viewPos(vUv, d0);
          float dist = length(P);
          vec3 V = P / max(dist, 1e-4);

          // normal from depth (smaller of the two one-sided differences per axis)
          vec3 dxP = viewPos(vUv + vec2(texel.x, 0.0), rawDepth(vUv + vec2(texel.x, 0.0))) - P;
          vec3 dxM = P - viewPos(vUv - vec2(texel.x, 0.0), rawDepth(vUv - vec2(texel.x, 0.0)));
          vec3 dyP = viewPos(vUv + vec2(0.0, texel.y), rawDepth(vUv + vec2(0.0, texel.y))) - P;
          vec3 dyM = P - viewPos(vUv - vec2(0.0, texel.y), rawDepth(vUv - vec2(0.0, texel.y)));
          vec3 ddx = abs(dxP.z) < abs(dxM.z) ? dxP : dxM;
          vec3 ddy = abs(dyP.z) < abs(dyM.z) ? dyP : dyM;
          vec3 N = normalize(cross(ddx, ddy));
          if (dot(N, V) > 0.0) N = -N;

          float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

          // ---- fine ambient occlusion (0.4-0.6 m: kerbs, eaves, object bases) ----
          float ao = 1.0;
          if (uAO.x > 0.001) {
            float r = uAO.y;
            float occ = 0.0;
            float bay = mod(floor(gl_FragCoord.x), 2.0) + 2.0 * mod(floor(gl_FragCoord.y), 2.0);
            float a0 = bay * 0.19634954;
            for (int i = 0; i < 8; i++) {
              float a = a0 + float(i) * 0.7853982;
              float rad = r * (0.30 + 0.70 * fract(float(i) * 0.37 + bay * 0.25));
              vec3 t = normalize(abs(N.z) < 0.9 ? cross(N, vec3(0.0, 0.0, 1.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
              vec3 b = cross(N, t);
              vec3 dir = normalize(t * cos(a) + b * sin(a) + N * 0.55);
              vec3 sp = P + dir * rad;
              vec3 pr = project(sp);
              if (pr.x < 0.0 || pr.x > 1.0 || pr.y < 0.0 || pr.y > 1.0) continue;
              float sz = viewZ(rawDepth(pr.xy));
              float dz = sz - sp.z;
              float range = smoothstep(0.0, 1.0, r / max(abs(sz - P.z), 1e-3));
              occ += step(0.02, dz) * range;
            }
            ao = 1.0 - uAO.x * (occ / 8.0);
            ao = clamp(mix(1.0, ao, 1.0 - smoothstep(140.0, 460.0, dist)), 0.0, 1.0);
          }

          // ---- contact shadow (short march toward the sun) ----
          float shadow = 1.0;
          if (uContact.x > 0.001) {
            float len = uContact.y * (1.0 + smoothstep(20.0, 220.0, dist) * 2.2);
            float stepLen = len / 12.0;
            vec3 O = P + N * (0.012 + dist * 0.0025);
            float hit = 0.0;
            for (int i = 1; i <= 12; i++) {
              vec3 sp = O + uSunView * (stepLen * (float(i) - 0.5 + dither * 0.9));
              vec3 pr = project(sp);
              if (pr.x < 0.0 || pr.x > 1.0 || pr.y < 0.0 || pr.y > 1.0) break;
              float sz = viewZ(rawDepth(pr.xy));
              float dz = sz - sp.z;
              float bias = 0.03 + abs(sp.z) * 0.004;
              if (dz > bias && dz < bias + 1.6) { hit = 1.0 - (float(i) - 1.0) / 12.0 * 0.35; break; }
            }
            shadow = 1.0 - uContact.x * hit * (1.0 - smoothstep(120.0, 380.0, dist));
          }

          // contact multiplies FIRST; the bounce is computed on what is left (p6 fix)
          c *= 1.0 - (1.0 - shadow) * uContactDark;
          float occAO = (1.0 - ao) * uOcclusion.x;
          c = c * (1.0 - occAO) + uSkyColor * (luma(c) + 0.0015) * occAO * uOcclusion.y;

          // ---- wet reflections ----
          float up = dot(N, uUpView);
          float flat_ = smoothstep(0.80, 0.96, up);
          float lum = luma(c);
          float green = (c.g - max(c.r, c.b)) / max(lum, 1e-3);
          float notGreen = 1.0 - smoothstep(0.06, 0.22, green);
          float wetMask = uWet * flat_ * notGreen * uReflect;
          if (wetMask > 0.004 && dist < 700.0) {
            vec3 W = (uViewInv * vec4(P, 1.0)).xyz;
            float rim;
            vec3 drain = drainage(W.xz);
            float poolMap = smoothstep(0.12, 0.55, drain.r) * smoothstep(0.10, 0.45, uWet);
            float offRoad = 1.0 - smoothstep(0.25, 0.65, drain.b);
            float pool = max(poolMap, fxPuddleMask(W.xz, uWet, rim) * offRoad);
            float rough = mix(0.85, 0.10, pool);
            vec2 g = vec2(
              fxValueNoise(W.xz * 1.7 + vec2(uTime * 0.05, 0.0)) - fxValueNoise(W.xz * 1.7 + vec2(0.3 + uTime * 0.05, 0.0)),
              fxValueNoise(W.xz * 1.7 + vec2(0.0, uTime * 0.05)) - fxValueNoise(W.xz * 1.7 + vec2(0.0, 0.3 + uTime * 0.05)));
            g += vec2(fxValueNoise(W.xz * 1.45) - 0.5, fxValueNoise(W.xz * 1.45 + 31.0) - 0.5) * (0.30 + 0.5 * uRipple);
            g += vec2(fxValueNoise(W.xz * 0.47) - 0.5, fxValueNoise(W.xz * 0.47 + 17.0) - 0.5) * 0.55;
            float NdV = clamp(-dot(N, V), 0.0, 1.0);
            float F = 0.028 + 0.972 * pow(1.0 - NdV, 4.5);
            vec3 tilt = mat3(uView) * vec3(g.x, 0.0, g.y);
            float wob = rough * 0.05 * (0.16 + 0.84 * NdV) * (1.0 - smoothstep(60.0, 200.0, dist));
            vec3 R = reflect(V, normalize(N + tilt * wob));

            vec3 Rw = mat3(uViewInv) * reflect(V, N);
            vec3 miss = mix(uHaze, uSkyColor, smoothstep(0.03, 0.40, Rw.y)) * 0.75
                        * (1.0 - 0.92 * uNight * (1.0 - 0.85 * pool));
            vec3 refl = miss;
            float conf = 0.0;
            if (R.z < 0.35) {
              float t = 0.30 + dist * 0.010;
              vec3 prev = P;
              for (int i = 0; i < 22; i++) {
                vec3 sp = P + R * t;
                vec3 pr = project(sp);
                if (pr.x < -0.02 || pr.x > 1.02 || pr.y < -0.02 || pr.y > 1.02 || sp.z > -uNearFar.x) break;
                float sd = rawDepth(clamp(pr.xy, vec2(0.0), vec2(1.0)));
                float sz = viewZ(sd);
                float dz = sz - sp.z;
                float thick = min(0.55 + t * 0.22, 5.5);
                float minDz = 0.06 + t * 0.035;
                if (dz > minDz && dz < thick && sd < 0.99999) {
                  vec3 lo = prev, hi = sp;
                  for (int k = 0; k < 4; k++) {
                    vec3 mid = (lo + hi) * 0.5;
                    vec3 pm = project(mid);
                    float zm = viewZ(rawDepth(clamp(pm.xy, vec2(0.0), vec2(1.0))));
                    if (zm - mid.z > minDz) hi = mid; else lo = mid;
                  }
                  vec3 pf = project(hi);
                  vec2 huv = clamp(pf.xy, vec2(0.0), vec2(1.0));
                  refl = texture(tDiffuse, huv).rgb;
                  vec2 e = smoothstep(vec2(0.0), vec2(0.11), huv) * (1.0 - smoothstep(vec2(0.89), vec2(1.0), huv));
                  conf = e.x * e.y;
                  break;
                }
                prev = sp;
                t *= 1.28;
                t += 0.14;
                if (t > 260.0) break;
              }
            }
            refl = mix(miss, refl, conf);
            float k = clamp(F * wetMask * (0.18 + 0.82 * pool) * mix(0.18, 1.0, conf), 0.0, 0.82);
            c = mix(c, refl, k);
            c *= 1.0 - 0.12 * pool * uWet;

            // ---- analytic emitter smears (lamps, head- and tail-lights) ----
            if (uWetLightN > 0) {
              vec3 acc = vec3(0.0);
              vec3 RwDir = mat3(uViewInv) * R;
              RwDir /= max(length(RwDir), 1e-4);
              for (int i = 0; i < 12; i++) {
                if (i >= uWetLightN) break;
                vec4 Le = uWetLights[i];
                if (Le.w <= 0.0) continue;
                vec3 M = Le.xyz;
                vec3 toM = M - W;
                float t = dot(toM, RwDir);
                if (t <= 0.5) continue;
                vec3 diff = toM - RwDir * t;
                float dh2 = dot(diff.xz, diff.xz);
                float dv = abs(diff.y);
                float sh = mix(0.66, 0.26, pool);
                vec3 colN = uWetLightCol[i] / max(luma(uWetLightCol[i]), 0.25);
                float sv = mix(1.8, 2.3, pool);
                float tailish = smoothstep(2.0, 5.0, colN.r / max(colN.g, 0.05));
                sv *= mix(1.0, 2.2, tailish);
                sh *= mix(1.0, 1.05, tailish);
                float w = exp(-dh2 / (sh * sh)) * exp(-dv * dv / (sv * sv));
                if (w < 0.004) continue;
                float wCore = exp(-dh2 / (sh * sh * 0.30)) * exp(-dv * dv / (sv * sv * 0.45));
                float amp = w + wCore * min(1.0, Le.w / 2.5) * 0.7;
                float att = mix(1.0, 0.30, smoothstep(30.0, 160.0, t));
                att *= mix(0.22, 1.0, smoothstep(6.0, 40.0, t));
                acc += colN * (Le.w * amp * att);
              }
              c += acc * (0.45 + 0.55 * F) * wetMask * (0.45 + 0.80 * pool) * 1.3;
            }
          }

          // ---- aerial perspective (lifts blacks toward the sky, desaturates) ----
          if (uAerial.x > 0.0) {
            float f = 1.0 - exp(-dist * uAerial.x);
            float l = luma(c);
            c = mix(c, vec3(l), uAerial.y * f);
            c += uHaze * uAerial.z * f;
          }

          fragColor = vec4(max(c, vec3(0.0)), src.a);
        }
    """.trimIndent()

    /** Street-lamp bulb heads: dark glass by day, warm radiance at night (the site's lamp glow). */
    val FS_LAMPHEAD = """
        #version 300 es
        precision highp float;
        in vec3 vColor;
        in vec3 vWorld;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform vec3 uCamPos;
        uniform float uNight;
        out vec4 fragColor;
        void main() {
            vec3 glass = vColor;
            vec3 glow = vec3(1.0, 0.78, 0.45) * 2.2;
            vec3 col = mix(glass, glow, uNight);
            float d = length(uCamPos - vWorld);
            float fog = 1.0 - exp(-d * uFogDensity);
            fragColor = vec4(mix(col, uFogColor, fog), 1.0);
        }
    """.trimIndent()
}
