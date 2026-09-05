// A wobbly strawberry jelly on a plate, rendered with three.js' WebGPU
// renderer (falls back to WebGL 2 automatically where WebGPU is missing).
//
// Interaction:
//   * click / tap the jelly  -> it gets poked and boings
//   * press and drag         -> you pull it around; let go and it snaps back
//
// The soft-body simulation lives in jelly-physics.js (no three.js dependency).

import * as THREE from 'three';
import { color, normalView, positionViewDirection } from 'three/tsl';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  buildJellyProfile,
  buildLatheMesh,
  computeNormals,
  JellySim,
} from './jelly-physics.js';

const PAGE_BACKGROUND = 0x5e686e;
const JELLY_COLOR = 0xff3366;

async function main() {
  const stage = document.getElementById('jelly-stage');
  const canvas = document.getElementById('jelly-canvas');
  const hint = document.getElementById('jelly-hint');
  if (!stage || !canvas) return;

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAGE_BACKGROUND);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  const cameraTarget = new THREE.Vector3(0, 0.72, 0);

  // Image-based lighting makes the glossy, translucent surface read as food.
  // It is optional: if it fails for any reason the analytic lights still work.
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
  } catch (err) {
    console.warn('jelly: environment lighting unavailable', err);
  }

  // ------------------------------------------------------------------ lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x3a4147, 0.9);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff4e8, 2.4);
  key.position.set(2.5, 5, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 14;
  key.shadow.camera.left = -3;
  key.shadow.camera.right = 3;
  key.shadow.camera.top = 3;
  key.shadow.camera.bottom = -3;
  key.shadow.bias = -0.0015;
  key.shadow.radius = 4;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xbfe0ff, 1.2);
  rim.position.set(-3, 3, -4);
  scene.add(rim);

  // ------------------------------------------------------------------- plate
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(1.75, 1.55, 0.12, 72),
    new THREE.MeshStandardNodeMaterial({ color: 0xf6f1e7, roughness: 0.35, metalness: 0 })
  );
  plate.position.y = -0.06;
  plate.receiveShadow = true;
  scene.add(plate);

  // ------------------------------------------------------------------- jelly
  const meshData = buildLatheMesh(buildJellyProfile(), 56);
  const sim = new JellySim(meshData);
  const normals = new Float32Array(sim.count * 3);
  computeNormals(sim.positions, meshData.index, normals);

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(sim.positions, 3);
  const normalAttr = new THREE.BufferAttribute(normals, 3);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  normalAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('normal', normalAttr);
  geometry.setIndex(new THREE.BufferAttribute(meshData.index, 1));
  // Generous fixed bounds: the surface deforms every frame, and raycasting +
  // frustum culling only need a conservative sphere.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 3.5);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-3, -1, -3), new THREE.Vector3(3, 3.5, 3));

  const jellyMaterial = new THREE.MeshPhysicalNodeMaterial({
    color: JELLY_COLOR,
    roughness: 0.12,
    metalness: 0,
    transmission: 0.82,
    thickness: 1.4,
    ior: 1.38,
    attenuationColor: new THREE.Color(0xff1f5a),
    attenuationDistance: 0.9,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    specularIntensity: 1,
  });

  // TSL: a soft fresnel rim so the edges glow like light passing through
  // a real jelly. Purely cosmetic, so a failure here is not fatal.
  try {
    const facing = normalView.dot(positionViewDirection).abs();
    const fresnel = facing.oneMinus().pow(3.0);
    jellyMaterial.emissiveNode = color(0xff7fa3).mul(fresnel).mul(0.45);
  } catch (err) {
    console.warn('jelly: TSL rim light unavailable', err);
  }

  const jelly = new THREE.Mesh(geometry, jellyMaterial);
  jelly.castShadow = true;
  scene.add(jelly);

  // ------------------------------------------------------------------ sizing
  function resize() {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // pull the camera back on narrow (portrait) stages so the jelly fits
    const distance = 4.9 * Math.max(1, 1.35 / camera.aspect);
    camera.position.set(0, 0.55 + 0.32 * distance, distance);
    camera.lookAt(cameraTarget);
    camera.updateProjectionMatrix();
  }
  resize();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(stage);
  } else {
    window.addEventListener('resize', resize);
  }

  // ------------------------------------------------------------- interaction
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const hitPoint = new THREE.Vector3();
  const localPoint = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  let dragging = false;
  let activePointer = null;
  let interacted = false;

  function updatePointer(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  }

  function intersectJelly() {
    const hits = raycaster.intersectObject(jelly, false);
    return hits.length ? hits[0] : null;
  }

  function markInteracted() {
    if (interacted) return;
    interacted = true;
    if (hint) hint.classList.add('jelly-hint--hidden');
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (activePointer !== null) return;
    updatePointer(event);
    const hit = intersectJelly();
    if (!hit) return;
    event.preventDefault();
    activePointer = event.pointerId;
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }

    localPoint.copy(hit.point);
    jelly.worldToLocal(localPoint);
    sim.poke(localPoint.x, localPoint.y, localPoint.z, 1.0);
    sim.grabStart(sim.nearestNode(localPoint.x, localPoint.y, localPoint.z));

    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir, hit.point);
    dragging = true;
    canvas.classList.add('jelly-canvas--grabbing');
    markInteracted();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
      if (event.pointerId !== activePointer) return;
      updatePointer(event);
      if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
        localPoint.copy(hitPoint);
        jelly.worldToLocal(localPoint);
        sim.grabMove(localPoint.x, localPoint.y, localPoint.z);
      }
      return;
    }
    if (event.pointerType === 'mouse') {
      updatePointer(event);
      canvas.classList.toggle('jelly-canvas--hover', intersectJelly() !== null);
    }
  });

  function release(event) {
    if (event && activePointer !== null && event.pointerId !== activePointer) return;
    if (dragging) sim.grabEnd();
    dragging = false;
    activePointer = null;
    canvas.classList.remove('jelly-canvas--grabbing');
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', release);
  window.addEventListener('blur', () => release(null));

  // ------------------------------------------------------------- render loop
  const clock = new THREE.Clock();
  let nextIdleNudge = 4 + Math.random() * 4;
  let visible = true;

  function frame() {
    const dt = clock.getDelta();

    // an occasional idle wobble keeps it looking alive
    nextIdleNudge -= dt;
    if (nextIdleNudge <= 0) {
      nextIdleNudge = 6 + Math.random() * 6;
      if (!dragging && sim.energy < 1e-4) {
        const angle = Math.random() * Math.PI * 2;
        sim.poke(Math.cos(angle) * 0.75, 0.6 + Math.random() * 0.8, Math.sin(angle) * 0.75, 0.35);
      }
    }

    if (sim.update(dt)) {
      computeNormals(sim.positions, meshData.index, normals);
      positionAttr.needsUpdate = true;
      normalAttr.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }

  function setRunning(run) {
    if (run) {
      clock.getDelta(); // drop the time we spent paused
      renderer.setAnimationLoop(frame);
    } else {
      renderer.setAnimationLoop(null);
    }
  }

  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      setRunning(visible);
    }, { threshold: 0.05 }).observe(stage);
  } else {
    setRunning(true);
  }

  // land on the plate with a satisfying plop
  sim.squash(1.1);
  renderer.render(scene, camera);
  stage.classList.remove('jelly-stage--failed');
  stage.classList.add('jelly-stage--ready');
  window.__jellyReady = true;
}

main().catch((err) => {
  console.warn('jelly: could not start', err);
  const stage = document.getElementById('jelly-stage');
  if (stage) stage.classList.add('jelly-stage--failed');
});
