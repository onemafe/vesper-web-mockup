// Панорама 360 точки обзора на весь экран (Docs/RENDER.md, раздел 4; данные — data/pano/camera.json).
// Куб из 6 граней renders/Pano_Test/<id>/<грань>.webp (в camera.json имена .png из UE — подменяем на .webp), сняты из точки камеры с FOV 90° по осям мира UE.
// Каждая грань — квадрат на расстоянии 1 от камеры, углы считаются из её поворота UE и переводятся тем же
// преобразованием, что overlay.js (glTF = UE (X, Z, Y)), — поэтому ориентация граней не зависит от соглашений
// CubeTexture, а 3D-сцену UE при необходимости можно положить сверху той же камерой.
// Палец/мышь — поворот (взгляд идёт за пальцем), щипок/колесо — приближение. Старт — направление камеры
// приложения в момент съёмки (startView.yaw), горизонт ровный.
// Эквиректангулярная развёртка 2:1 (плагин PanoramicCaptureCustom, ue/pano_plugin.py) — у точки поле equirect
// (путь от renders/Pano_Test/) и equirectYaw — куда смотрит центр картинки; рисуется сферой из направлений UE.
// Варианты одной точки (сравнение настроек съёмки), defaultVariant основной — какой открыть по кнопке «360»,
// variantHidden — скрыть вариант из переключателя: точка с variantOf = <id основной> и variantLabel — кнопки
// вверху переключают грани, направление взгляда сохраняется. Кнопки «360» на этаже — только у основных.
// Наружу: window.pano.open(id), событие 'panoclose' на #panoView. ?pano=<id> — сразу открыть (для проверки).
import * as THREE from 'three';

const DIR = 'renders/Pano_Test/';
const FOV_START = 80, FOV_MIN = 35, FOV_MAX = 100;   // вертикальный угол камеры вьюера, °
const PITCH_LIMIT = 85;

const root = document.getElementById('panoView');
const canvas = document.getElementById('panoCanvas');
const loading = document.getElementById('panoLoading');
const variantsBar = document.getElementById('panoVariants');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV_START, 1, 0.01, 10);
const cube = new THREE.Group();
scene.add(cube);
const loader = new THREE.TextureLoader();

const rad = THREE.MathUtils.degToRad;
const ue = (x, y, z) => new THREE.Vector3(x, z, y);   // как overlay.js, без перевода см → м: здесь всё в единицах грани
// Базис камеры UE по повороту (roll = 0): вперёд, вправо, вверх.
function basis(pitch, yaw) {
  const p = rad(pitch), y = rad(yaw);
  return {
    f: [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)],
    r: [-Math.sin(y), Math.cos(y), 0],
    u: [-Math.sin(p) * Math.cos(y), -Math.sin(p) * Math.sin(y), Math.cos(p)],
  };
}

let data = null;          // camera.json
let view = { yaw: 0, pitch: 0, fov: FOV_START };
let openId = null;

function faceMesh(rot, texture) {
  const { f, r, u } = basis(rot.pitch, rot.yaw);
  const k = Math.tan(rad(data.image.fovDeg / 2));   // полуширина грани при расстоянии 1 (90° → 1)
  const corner = (sx, sy) => ue(...[0, 1, 2].map(i => f[i] + k * (sx * r[i] + sy * u[i])));
  // Порядок: левый верх, правый верх, левый низ, правый низ; uv — как у картинки (v вверх).
  const pts = [corner(-1, 1), corner(1, 1), corner(-1, -1), corner(1, -1)];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(p => [p.x, p.y, p.z]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
}

// Сфера под развёртку: u = 0.5 — yaw центра, u растёт вправо (по часовой сверху, как yaw UE), v = 0 — зенит.
function sphereMesh(texture, centerYaw) {
  const W = 128, H = 64, pos = [], uv = [], idx = [];
  for (let j = 0; j <= H; j++)
    for (let i = 0; i <= W; i++) {
      const u = i / W, v = j / H;
      const { f } = basis(90 - v * 180, centerYaw + (u - 0.5) * 360);
      const p = ue(...f);
      pos.push(p.x, p.y, p.z); uv.push(u, 1 - v);
    }
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const a = j * (W + 1) + i, b = a + W + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
}

function resize() {
  const r = root.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
}

function render() {
  if (!openId) return;
  resize();
  view.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, view.pitch));
  view.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, view.fov));
  const { f } = basis(view.pitch, view.yaw);
  camera.fov = view.fov;
  camera.updateProjectionMatrix();
  camera.position.set(0, 0, 0);
  camera.up.set(0, 1, 0);   // UE Z вверх → glTF Y
  camera.lookAt(ue(...f));
  renderer.render(scene, camera);
}

function loadData() {
  return data ||= fetch('data/pano/camera.json', { cache: 'no-cache' }).then(r => r.json()).then(d => (data = d));
}

// Кнопки вариантов точки: основная + все с variantOf = её id (по variantLabel). Один вариант — кнопок нет.
function showVariants(point) {
  const baseId = point.variantOf || point.id;
  // variantHidden — вариант скрыт из переключателя (файлы и запись остаются для истории проб).
  const group = data.points.filter(p => (p.id === baseId || p.variantOf === baseId) && !p.variantHidden)
    .sort((a, b) => (a.variantLabel || a.id).localeCompare(b.variantLabel || b.id));
  variantsBar.replaceChildren(...(group.length < 2 ? [] : group.map(p => {
    const b = document.createElement('button');
    b.textContent = p.variantLabel || p.id;
    if (p.variantNote) b.title = p.variantNote;
    b.classList.toggle('on', p.id === point.id);
    b.onclick = () => { if (p.id !== openId) open(p.id, true); };
    return b;
  })));
}

async function open(id, keepView = false) {
  openId = id;
  root.classList.add('open');
  loading.textContent = 'Загрузка…'; loading.style.display = '';
  if (!keepView) cube.clear();   // при смене варианта старые грани видны, пока грузятся новые
  let point;
  try {
    await loadData();
    point = data.points.find(p => p.id === id);
    if (!point) throw new Error(`нет панорамы ${id}`);
    // Кнопка «360» открывает основную точку; у неё может быть вариант по умолчанию (defaultVariant)
    // или сама она скрыта — тогда первый видимый вариант.
    if (!keepView && (point.defaultVariant || point.variantHidden)) {
      const alt = data.points.find(p => p.id === point.defaultVariant && !p.variantHidden)
        || data.points.find(p => p.variantOf === point.id && !p.variantHidden);
      if (alt) { point = alt; openId = id = alt.id; }
    }
  } catch (e) {
    console.error('pano:', e);
    loading.textContent = 'Нет data/pano/camera.json или панорамы — запустите sync.cmd';
    return;
  }
  showVariants(point);
  if (!keepView) view = { yaw: point.startView.yaw, pitch: 0, fov: FOV_START };
  const webp = path => DIR + path.replace(/\.png$/i, '.webp');
  const faces = point.equirect
    ? [await loader.loadAsync(webp(point.equirect)).then(tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        return sphereMesh(tex, point.equirectYaw ?? point.startView.yaw);
      }).catch(() => null)]
    : await Promise.all(Object.entries(data.faces).map(([name, rot]) =>
    loader.loadAsync(DIR + point.faces[name].replace(/\.png$/i, '.webp')).then(tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      return faceMesh(rot, tex);
    }).catch(() => null)));
  if (openId !== id) return;   // пока грузилось, закрыли или открыли другую
  if (faces.includes(null)) { loading.textContent = `Нет граней web/${DIR}${id}/ — запустите sync.cmd`; return; }
  cube.clear();
  cube.add(...faces);
  loading.style.display = 'none';
  render();
}

function close() {
  openId = null;
  root.classList.remove('open');
  root.dispatchEvent(new Event('panoclose'));
}

// Жесты: один палец — поворот (картинка идёт за пальцем), два — щипок.
const ptrs = new Map();
let pinch = null;
root.addEventListener('pointerdown', e => {
  if (e.target.closest('button')) return;
  root.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinch = null;
});
root.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  const prev = ptrs.get(e.pointerId), p = { x: e.clientX, y: e.clientY };
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 1) {
    const degPerPx = view.fov / root.getBoundingClientRect().height;
    view.yaw -= (p.x - prev.x) * degPerPx;     // yaw UE растёт вправо (по часовой сверху)
    view.pitch += (p.y - prev.y) * degPerPx;
    render();
    return;
  }
  const [a, b] = [...ptrs.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  if (pinch) { view.fov *= pinch / d; render(); }
  pinch = d;
});
const up = e => { ptrs.delete(e.pointerId); pinch = null; };
root.addEventListener('pointerup', up);
root.addEventListener('pointercancel', up);
root.addEventListener('wheel', e => { e.preventDefault(); view.fov *= Math.exp(e.deltaY * 0.001); render(); }, { passive: false });
addEventListener('resize', render);
document.getElementById('panoClose').onclick = close;

window.pano = { open, close };
const qs = new URLSearchParams(location.search);
if (qs.has('pano')) open(qs.get('pano'));
