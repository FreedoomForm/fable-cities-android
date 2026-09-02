import * as THREE from 'three';
import { clamp, damp, dampAngle, DEG2RAD } from '../shared/math.js';

/**
 * Cities: Skylines style orbit camera.
 *  - WASD / arrows: pan (speed scales with zoom)   - Q/E: rotate   - R/F: tilt
 *  - Middle drag (or Alt+left drag): grab-the-ground pan    - Right drag: rotate/tilt
 *  - Wheel: zoom towards cursor                              - Home: reset
 */
export class CameraController {
  constructor(camera, input, world, canvas) {
    this.camera = camera;
    this.input = input;
    this.world = world;
    this.canvas = canvas;
    this.enabled = true;

    this.target = new THREE.Vector3(0, 0, 0);
    this.distance = 450;
    this.yaw = 30 * DEG2RAD;
    this.pitch = 42 * DEG2RAD;
    this.desired = { target: this.target.clone(), distance: this.distance, yaw: this.yaw, pitch: this.pitch };

    this.minDistance = 4;
    this.maxDistance = 3200;
    this.minPitch = 6 * DEG2RAD;
    this.maxPitch = 88 * DEG2RAD;
    this.smoothing = 12;
    this.panSpeed = 1.1; // fraction of distance per second
    this.rotateSpeed = 0.0045;
    this.zoomSpeed = 0.0011;
    this.minHeightAboveGround = 1.8;

    this._raycaster = new THREE.Raycaster();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._panStart = new THREE.Vector3();
    this._panning = false;
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this.updateCameraTransform(true);
  }

  /** Immediately or smoothly move to a view: { target:{x,y,z}, distance, yaw (rad), pitch (rad) } */
  setView(view, immediate = false) {
    if (view.target) this.desired.target.set(view.target.x ?? this.desired.target.x, view.target.y ?? 0, view.target.z ?? this.desired.target.z);
    if (view.distance != null) this.desired.distance = clamp(view.distance, this.minDistance, this.maxDistance);
    if (view.yaw != null) this.desired.yaw = view.yaw;
    if (view.pitch != null) this.desired.pitch = clamp(view.pitch, this.minPitch, this.maxPitch);
    if (immediate) {
      this.target.copy(this.desired.target);
      this.distance = this.desired.distance;
      this.yaw = this.desired.yaw;
      this.pitch = this.desired.pitch;
      this.updateCameraTransform(true);
    }
  }

  getView() {
    return { target: this.target.clone(), distance: this.distance, yaw: this.yaw, pitch: this.pitch };
  }

  /** Project the pointer onto the terrain. */
  pointerToGround(ndc, out) {
    this._raycaster.setFromCamera(ndc, this.camera);
    return this.world.terrain.raycast(this._raycaster.ray, out);
  }

  update(dt) {
    const input = this.input;
    const d = this.desired;

    // Pointer → ground every frame (used by tools as well)
    input.groundValid = this.pointerToGround(input.ndc, input.ground);

    if (this.enabled && !input.pointerOverUI) {
      // --- keyboard pan ---
      const yaw = this.yaw;
      this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      const speed = this.panSpeed * this.distance * dt * (input.shift ? 2.2 : 1);
      let mx = 0, mz = 0;
      if (input.isDown('w') || input.isDown('ArrowUp')) mz += 1;
      if (input.isDown('s') || input.isDown('ArrowDown')) mz -= 1;
      if (input.isDown('a') || input.isDown('ArrowLeft')) mx -= 1;
      if (input.isDown('d') || input.isDown('ArrowRight')) mx += 1;
      if (mx || mz) {
        const len = Math.hypot(mx, mz);
        d.target.addScaledVector(this._forward, (mz / len) * speed);
        d.target.addScaledVector(this._right, (mx / len) * speed);
      }
      if (input.isDown('q')) d.yaw += 1.6 * dt;
      if (input.isDown('e')) d.yaw -= 1.6 * dt;
      // Tilt: T/G always, R/F unless a tool claimed them (input.claimKey('r') — CS2 uses R to rotate a ghost).
      if (input.isDown('r') || input.isHeld('t')) d.pitch += 1.0 * dt;
      if (input.isDown('f') || input.isHeld('g')) d.pitch -= 1.0 * dt;
      if (input.justPressed('Home')) this.setView({ target: { x: 0, y: 0, z: 0 }, distance: 450, yaw: 30 * DEG2RAD, pitch: 42 * DEG2RAD });

      // --- mouse ---
      const drag = input.drag;
      const panDrag = drag && (drag.button === 1 || (drag.button === 0 && input.alt));
      const rotDrag = drag && drag.button === 2;
      if (panDrag) {
        if (!this._panning) {
          this._panning = true;
          this._panStart.copy(drag.startGroundValid ? drag.startGround : d.target);
          this._panPlaneY = this._panStart.y;
        }
        // Grab-the-ground: keep the point under the cursor fixed → intersect with horizontal plane at grab height
        this._raycaster.setFromCamera(input.ndc, this.camera);
        const ray = this._raycaster.ray;
        const t = (this._panPlaneY - ray.origin.y) / ray.direction.y;
        if (Number.isFinite(t) && t > 0 && t < 20000) {
          this._tmp.copy(ray.direction).multiplyScalar(t).add(ray.origin);
          this._tmp2.subVectors(this._panStart, this._tmp);
          this._tmp2.y = 0;
          d.target.add(this._tmp2);
          this.target.add(this._tmp2); // immediate for 1:1 feel
        }
      } else {
        this._panning = false;
      }
      if (rotDrag) {
        d.yaw -= drag.dx * this.rotateSpeed;
        d.pitch += drag.dy * this.rotateSpeed;
      }

      // --- zoom towards cursor ---
      if (input.wheelDelta !== 0) {
        const factor = Math.exp(input.wheelDelta * this.zoomSpeed);
        const newDist = clamp(d.distance * factor, this.minDistance, this.maxDistance);
        const ratio = newDist / d.distance;
        if (input.groundValid && ratio < 1) {
          // move target towards the cursor point proportionally to how much we zoomed in
          this._tmp.subVectors(input.ground, d.target);
          this._tmp.y = 0;
          d.target.addScaledVector(this._tmp, 1 - ratio);
        }
        d.distance = newDist;
      }
    } else {
      this._panning = false;
    }

    // --- clamp & smooth ---
    d.pitch = clamp(d.pitch, this.minPitch, this.maxPitch);
    d.distance = clamp(d.distance, this.minDistance, this.maxDistance);
    this.world.clampToMap(d.target);
    d.target.y = this.world.terrain.getHeight(d.target.x, d.target.z);

    const k = this.smoothing;
    this.target.x = damp(this.target.x, d.target.x, k, dt);
    this.target.y = damp(this.target.y, d.target.y, k, dt);
    this.target.z = damp(this.target.z, d.target.z, k, dt);
    this.distance = damp(this.distance, d.distance, k, dt);
    this.yaw = dampAngle(this.yaw, d.yaw, k, dt);
    this.pitch = damp(this.pitch, d.pitch, k, dt);
    this.updateCameraTransform(false);
  }

  updateCameraTransform() {
    const cam = this.camera;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const offX = Math.sin(this.yaw) * cp * this.distance;
    const offZ = Math.cos(this.yaw) * cp * this.distance;
    const offY = sp * this.distance;
    cam.position.set(this.target.x + offX, this.target.y + offY, this.target.z + offZ);
    // keep camera above terrain
    const groundY = this.world.terrain.getHeight(cam.position.x, cam.position.z) + this.minHeightAboveGround;
    if (cam.position.y < groundY) cam.position.y = groundY;
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
    const near = clamp(this.distance * 0.004, 0.2, 6);
    if (Math.abs(cam.near - near) > 0.01) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
