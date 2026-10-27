// 3D поверх кадра облёта: зелёные подсветки квартир, задняя сторона спрятана невидимым домом-окклюдером.
// Данные — экспорт из UE (Docs/BUILDING.md): data/building/*.glb, камера — data/orbit_main/camera.json.
// Координаты glTF = UE (X, Z, Y) * 0.01 — то же преобразование применяем к камере.
// Маска дома из рендера (orbitFrame.mask, белый = виден наш дом) умножается на готовый слой: там, где дом
// в кадре закрыт деревьями, соседними домами и т.п., подсветки не видны.
// ?debug=1 — окклюдер виден каркасом, подсветки включены сразу; ?apts=1 — подсветки включены сразу;
// ?mask=0 — без маски; ?all=1 — все 64 квартиры как доступные, без фильтра по фиду.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
// BVH для лучей в дом-окклюдер (~150 тыс. треугольников): поворот на квартиру из списка пускает сотни лучей.
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const DATA = 'data/';
const OCCLUDER = ['building_A_shell', 'building_B_shell', 'building_AB_shell'];
// Цвета — из материалов UE (состояние 2, «прошла фильтр»): заливка #9ECAB8, обводка #6C9E8F.
// Прозрачность в UE 0.02–0.05 при emissive; здесь подбирается на глаз под кадр.
const FILL = { color: 0x9ecab8, opacity: 0.35 };
const OUTLINE = { color: 0xb6d5c4, opacity: 0.7 };
// Квартиры не в продаже («Показать недоступные» в панели квартир) — состояние 5 в UE: заливка тёмно-серая
// linear 0.047 (≈ #3D3D3D, opacity 0.6 у A и 0.5 у B), обводка серая linear 0.505 (≈ #BCBCBC).
const FILL_UNAVAILABLE = { color: 0x3d3d3d, opacity: 0.5 };
const OUTLINE_UNAVAILABLE = { color: 0xbcbcbc, opacity: 0.7 };
// Выбранная квартира (как состояние 0 в UE): заливки нет, контур ярче.
// Обводка из UE — тонкая лента (в кадре ~1 px), поэтому поверх рисуется граница заливки толстой линией.
const OUTLINE_SELECTED = { color: 0xffffff, opacity: 1, widthPx: 3 };
const TAP_PX = 8;   // сдвиг пальца, после которого это уже свайп облёта, а не тап
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const screen = document.getElementById('screen');
const canvas = document.getElementById('overlay');
const button = document.getElementById('apts');

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(39, 4 / 3, 10, 2000);  // метры

let cam = null;           // camera.json
let visible = DEBUG || params.has('apts');   // режим «квартиры» (центральная кнопка)
const highlights = new THREE.Group();
highlights.visible = visible;
highlights.renderOrder = 1;
scene.add(highlights);
const occluder = new THREE.Group();
scene.add(occluder);
const apartments = new Map();   // apartmentId → { node, available, fills: [Mesh], outlines: [Mesh], outlineMat }
let selected = null;
let hlRoot = null;    // сцена highlights.glb

// Окклюдер пишет только глубину; polygonOffset отодвигает его, чтобы подсветки, лежащие вплотную к фасаду,
// не мерцали (z-fighting).
const occluderMat = DEBUG
  ? new THREE.MeshBasicMaterial({ color: 0xff3355, wireframe: true, transparent: true, opacity: 0.25 })
  : new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide,
                                  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
const fillMat = new THREE.MeshBasicMaterial({ color: FILL.color, transparent: true, opacity: FILL.opacity,
                                              depthWrite: false, side: THREE.DoubleSide });
const outlineMat = new THREE.MeshBasicMaterial({ color: OUTLINE.color, transparent: true, opacity: OUTLINE.opacity,
                                                 depthWrite: false, side: THREE.DoubleSide });
const fillUnavailMat = new THREE.MeshBasicMaterial({ color: FILL_UNAVAILABLE.color, transparent: true,
                                                     opacity: FILL_UNAVAILABLE.opacity,
                                                     depthWrite: false, side: THREE.DoubleSide });
const outlineUnavailMat = new THREE.MeshBasicMaterial({ color: OUTLINE_UNAVAILABLE.color, transparent: true,
                                                        opacity: OUTLINE_UNAVAILABLE.opacity,
                                                        depthWrite: false, side: THREE.DoubleSide });
const outlineSelMat = new THREE.MeshBasicMaterial({ color: OUTLINE_SELECTED.color, transparent: true,
                                                    opacity: OUTLINE_SELECTED.opacity,
                                                    depthWrite: false, side: THREE.DoubleSide });
const contourMat = new LineMaterial({ color: OUTLINE_SELECTED.color, linewidth: OUTLINE_SELECTED.widthPx,
                                     transparent: true, opacity: OUTLINE_SELECTED.opacity, depthWrite: false });

// Контур квартиры — рёбра заливки, принадлежащие одному треугольнику (граница куска фасада).
// Вершины сначала сшиваются: в render data они разрезаны по нормалям/UV. Если граница пустая (замкнутый объём) —
// рёбра с изломом больше 40°.
function buildContour(fills) {
  const pts = [];
  for (const m of fills) {
    m.updateWorldMatrix(true, false);
    const g = mergeVertices(m.geometry.clone().deleteAttribute('normal').deleteAttribute('uv')
                              .applyMatrix4(m.matrixWorld), 1e-3);
    const pos = g.attributes.position, idx = g.index.array, count = new Map();
    for (let t = 0; t < idx.length; t += 3)
      for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
        const k = a < b ? a * 4194304 + b : b * 4194304 + a;
        count.set(k, (count.get(k) || 0) + 1);
      }
    let n = 0;
    for (const [k, c] of count) {
      if (c !== 1) continue;
      const a = Math.floor(k / 4194304), b = k % 4194304;
      pts.push(pos.getX(a), pos.getY(a), pos.getZ(a), pos.getX(b), pos.getY(b), pos.getZ(b));
      n++;
    }
    if (!n) pts.push(...new THREE.EdgesGeometry(g, 40).attributes.position.array);
  }
  const line = new LineSegments2(new LineSegmentsGeometry().setPositions(pts), contourMat);
  line.renderOrder = 4;
  return line;
}

// Маска: прямоугольник кадра (та же обрезка, что у фона) с blend dst *= mask по цвету и альфе
// (canvas premultiplied — умножение обоих каналов даёт корректную прозрачность, края маски сглажены).
// Одна текстура: при смене кадра меняется только её картинка.
const USE_MASK = params.get('mask') !== '0';
const maskTex = new THREE.Texture();
maskTex.colorSpace = THREE.NoColorSpace;   // значения маски — как есть, без sRGB-преобразования
maskTex.generateMipmaps = false;
maskTex.minFilter = THREE.LinearFilter;
const maskMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: maskTex }, rect: { value: new THREE.Vector4() } },   // rect: left, bottom, right, top (NDC)
  vertexShader: `
    uniform vec4 rect;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(mix(rect.xy, rect.zw, uv), 0.0, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D map;
    varying vec2 vUv;
    void main() { float m = texture2D(map, vUv).r; gl_FragColor = vec4(m); }`,
  depthTest: false, depthWrite: false, transparent: true,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor,
});
const maskQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), maskMat);
maskQuad.frustumCulled = false;
const maskScene = new THREE.Scene();
maskScene.add(maskQuad);

function applyMask(f) {
  if (!USE_MASK || !f.mask) return;
  if (maskTex.image !== f.mask) { maskTex.image = f.mask; maskTex.needsUpdate = true; }
  // Кадр w×h с углом в (x, y) canvas (ось y вниз) → NDC.
  maskMat.uniforms.rect.value.set(f.x / f.width * 2 - 1, 1 - (f.y + f.coverH) / f.height * 2,
                                  (f.x + f.coverW) / f.width * 2 - 1, 1 - f.y / f.height * 2);
  renderer.autoClear = false;
  renderer.render(maskScene, camera);
  renderer.autoClear = true;
}

const ue = (x, y, z) => new THREE.Vector3(x * 0.01, z * 0.01, y * 0.01);   // UE см → glTF м
const rad = THREE.MathUtils.degToRad;

// Камера кадра облёта с углом a (°): позиция кадра 0, повёрнутая вокруг pivot по Z, yaw = startYaw + a.
// (Формула сверена с frames[] в camera.json.)
function placeCamera(a) {
  const P = cam.orbit.pivot, L = cam.frames[0].location;
  const c = Math.cos(rad(a)), s = Math.sin(rad(a));
  const x = L[0] - P[0], y = L[1] - P[1];
  camera.position.copy(ue(P[0] + x * c - y * s, P[1] + x * s + y * c, L[2]));
  const yaw = rad(cam.orbit.startYaw + a), pitch = rad(cam.frames[0].rotation.pitch);
  const fwd = ue(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
  camera.up.copy(ue(-Math.sin(pitch) * Math.cos(yaw), -Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch)));
  camera.lookAt(camera.position.clone().add(fwd));
}

function render() {
  const f = window.orbitFrame;
  if (!cam || !f) return;
  if (canvas.width !== f.width || canvas.height !== f.height) renderer.setSize(f.width, f.height, false);
  contourMat.resolution.set(f.width, f.height);
  contourMat.linewidth = OUTLINE_SELECTED.widthPx * f.width / f.designW;   // px экрана дизайна → px canvas
  placeCamera(f.angle);
  // Тот же кадр, что у фона: полный кадр (квадрат или старый 4:3) размером coverW×coverH с углом в (x, y) canvas.
  // Угол по горизонтали один у всех наборов, вертикальный — из пропорций картинки: так 3D сходится и с кадрами,
  // снятыми до смены сенсора (camera.json может быть уже от квадрата, а кадры в web/renders — ещё 4:3).
  camera.aspect = f.coverW / f.coverH;
  camera.fov = 2 * Math.atan(Math.tan(cam.camera.hFovDeg * Math.PI / 360) / camera.aspect) * 180 / Math.PI;
  camera.setViewOffset(f.coverW, f.coverH, -f.x, -f.y, f.width, f.height);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  if (visible) applyMask(f);
  placeIcons(f);
}

// Иконки зон (САД / ЛОББИ в index.html) стоят в мировых точках UE: актёры BP_CourtyardItem / BP_LobbyItem
// (сабуровень Dev), их WidgetComponent — Space = Screen, Pivot (0.5, 0.5), т. е. центр плашки в точке актёра.
// Как в UE, домом и деревьями не перекрываются. В режиме «квартиры» (подсветки включены) скрыты.
const PLACES = {
  garden: [-9410, -1770, 14340],   // BP_CourtyardItem_C_1, WBP_Courtyard
  lobby:  [-6100,   210, 14340],   // BP_LobbyItem_C_1, WBP_Lobby
};
// Кадры облёта HQ (orbit_NNN, шаг 2°), на которых иконка видна; на остальных точка за домом — скрыта
// (подобрано пользователем по ?frame, 2026-10-27). Диапазон включительно, from > to — через 0 (orbit_179 → orbit_000).
const SHOWN_FRAMES = {
  garden: [[0, 107]],
  lobby:  [[85, 14]],
};
const HQ_STEP_DEG = 2;
function shownAt(place, angle) {
  const k = Math.round(((angle % 360 + 360) % 360) / HQ_STEP_DEG) % (360 / HQ_STEP_DEG);
  return (SHOWN_FRAMES[place] || []).some(([a, b]) => a <= b ? k >= a && k <= b : k >= a || k <= b);
}
const placeEls = [...document.querySelectorAll('[data-place]')]
  .map(el => ({ el, place: el.dataset.place, p: ue(...PLACES[el.dataset.place]) }));
const ndc = new THREE.Vector3();
function placeIcons(f) {
  const k = f.designW / f.width;   // px canvas → px экрана дизайна
  for (const { el, place, p } of placeEls) {
    ndc.copy(p).project(camera);
    // В режиме «квартиры» иконки скрыты; за домом — по таблице кадров SHOWN_FRAMES.
    const inFront = !visible && ndc.z > -1 && ndc.z < 1 && shownAt(place, f.angle);
    el.style.display = inFront ? 'flex' : 'none';
    if (!inFront) continue;
    const x = (ndc.x + 1) / 2 * f.width * k, y = (1 - ndc.y) / 2 * f.height * k;
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }
}

// Центр квартиры и направление её фасада (горизонталь, наружу от центра облёта) — мировые координаты glTF.
// Нормаль — сумма нормалей треугольников заливки по площади, каждая развёрнута наружу (обход вершин в UE любой).
function aptGeom(apt) {
  if (apt.geom) return apt.geom;
  hlRoot.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  apt.fills.forEach(m => box.expandByObject(m));
  const c = box.getCenter(new THREE.Vector3());
  const P = cam.orbit.pivot, out = c.clone().sub(ue(P[0], P[1], P[2])).setY(0).normalize();
  const n = new THREE.Vector3(), v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const m of apt.fills) {
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const count = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < count; t += 3) {
      for (let j = 0; j < 3; j++) v[j].fromBufferAttribute(pos, idx ? idx.getX(t + j) : t + j).applyMatrix4(m.matrixWorld);
      e1.subVectors(v[1], v[0]).cross(e2.subVectors(v[2], v[0]));
      n.addScaledVector(e1, e1.dot(out) < 0 ? -1 : 1);
    }
  }
  n.setY(0);
  if (n.lengthSq() < 1e-9) n.copy(out);
  // Точки для проверки видимости: вершины заливки, сдвинутые на 0.3 м к центру (не на самом ребре), не больше 32.
  const pts = [];
  for (const m of apt.fills) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  }
  const step = Math.max(1, Math.ceil(pts.length / 32));
  const samples = pts.filter((_, i) => i % step === 0).map(p => p.lerp(c, 0.3 / Math.max(0.3, p.distanceTo(c))));
  return apt.geom = { c, n: n.normalize(), samples };
}

// Лучший угол облёта на квартиру (строка списка панели), кадры через 2°: доля точек квартиры, до которых луч из камеры
// не упирается в дом-окклюдер, × насколько фасад смотрит в камеру; штраф — за поворот и за край экрана.
// Сначала грубо через 10°, потом точнее ±8° вокруг лучшего.
function bestAngle(id) {
  const { c, n, samples } = aptGeom(apartments.get(id));
  const from = window.orbitFrame ? window.orbitFrame.angle : 0, to = new THREE.Vector3();
  const score = a => {
    placeCamera(a);
    let seen = 0;
    for (const p of samples) {
      to.subVectors(p, camera.position);
      const dist = to.length();
      raycaster.set(camera.position, to.normalize());
      const wall = raycaster.intersectObject(occluder, true)[0];
      if (!wall || wall.distance + OCCLUSION_TOLERANCE_M >= dist) seen++;
    }
    to.subVectors(c, camera.position).normalize();
    const front = Math.max(0, -(to.x * n.x + to.z * n.z));
    const turn = Math.abs(((a - from) % 360 + 540) % 360 - 180);
    // Квартира у бокового края экрана (узкий телефон режет кадр по бокам) — хуже: проекция с обрезкой текущего вида.
    camera.updateMatrixWorld();
    const edge = Math.max(0, Math.abs(c.clone().project(camera).x) - 0.5);
    return seen / samples.length * (0.4 + 0.6 * front) - turn / 180 * 0.1 - edge;
  };
  let best = from, bestScore = -Infinity;
  const tryAngle = a => { a = (a % 360 + 360) % 360; const s = score(a); if (s > bestScore) { bestScore = s; best = a; } };
  for (let a = 0; a < 360; a += 10) tryAngle(a);
  const coarse = best;
  for (let a = coarse - 8; a <= coarse + 8; a += 2) tryAngle(a);
  return best;
}

// Где центр квартиры по высоте полного кадра облёта с углом a (0 — верх, 1 — низ): index.html по нему поднимает кадр
// так, чтобы квартира встала между логотипом и карточкой (телефон).
function frameY(id, a) {
  const f = window.orbitFrame;
  if (!f) return null;
  const { c } = aptGeom(apartments.get(id));
  placeCamera(a);
  camera.aspect = f.coverW / f.coverH;
  camera.fov = 2 * Math.atan(Math.tan(cam.camera.hFovDeg * Math.PI / 360) / camera.aspect) * 180 / Math.PI;
  camera.clearViewOffset();
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return (1 - c.clone().project(camera).y) / 2;   // камеру вернёт render()
}

// Выбор квартиры: заливка выбранной скрыта, контур — outlineSelMat. id = null — снять выбор.
// Наружу — событие 'apartmentselect' на #screen с detail.id и detail.frameY (см. frameY) для угла a.
function select(id, a = window.orbitFrame ? window.orbitFrame.angle : 0) {
  if (id === selected) return;
  const set = (apt, on) => {
    if (!apt) return;
    if (on && !apt.contour) highlights.add(apt.contour = buildContour(apt.fills));
    if (apt.contour) apt.contour.visible = on;
    apt.fills.forEach(m => { m.visible = !on; });
    apt.outlines.forEach(m => { m.material = on ? outlineSelMat : apt.outlineMat; m.renderOrder = on ? 3 : 2; });
  };
  set(apartments.get(selected), false);
  selected = id;
  set(apartments.get(selected), true);
  const fy = id && cam ? frameY(id, a) : null;
  screen.dispatchEvent(new CustomEvent('apartmentselect', { detail: { id, frameY: fy } }));
  render();
}

function setVisible(v) {
  visible = v;
  highlights.visible = v;
  button.classList.toggle('on', v);
  screen.classList.toggle('apts-on', v);   // панель квартир слева (ПК) — index.html
  if (!v) select(null);
  render();
}
button.addEventListener('click', () => setVisible(!visible));
screen.addEventListener('apartmentclear', () => select(null));   // крестик попапа квартиры в index.html
// Строка списка панели квартир (index.html) — выбрать квартиру.
// Облёт поворачивается на неё (window.orbitRotateTo из index.html).
screen.addEventListener('apartmentpick', e => {
  const id = e.detail.id;
  if (!apartments.has(id) || !cam) return;
  const a = bestAngle(id);
  window.orbitRotateTo?.(a);
  select(id, a);
});
button.classList.toggle('on', visible);
screen.classList.toggle('apts-on', visible);

// Фильтры панели квартир (index.html, window.aptFilterIds: Set или null — все): подсветки не прошедших фильтр
// спрятаны и не выбираются; выбранная, не прошедшая фильтр, снимается. Квартиры не в продаже видны, только если
// включено «Показать недоступные» (window.aptUnavailable — проверка id по корпусу и этажу).
function applyFilter() {
  const ids = window.aptFilterIds, unavailable = window.aptUnavailable;
  for (const [id, apt] of apartments) apt.node.visible = apt.available ? !ids || ids.has(id) : !!unavailable?.(id);
  if (selected && !apartments.get(selected)?.node.visible) select(null);
  render();
}
screen.addEventListener('apartmentfilter', applyFilter);
screen.addEventListener('orbitframe', render);

// Тап по квартире. Луч бьёт и в окклюдер: квартира выбирается, только если её подсветка не за домом
// (подсветка лежит снаружи фасада, допуск — на fallback-геометрию окклюдера).
const raycaster = new THREE.Raycaster();
const OCCLUSION_TOLERANCE_M = 1;
function pick(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1,
                                            -((clientY - r.top) / r.height) * 2 + 1), camera);
  // Без контуров; квартиры, спрятанные фильтром, пропускаем (луч их не замечает сам).
  const visibleHit = h => { let o = h.object; while (o) { if (!o.visible) return false; o = o.parent; } return true; };
  const hit = hlRoot && raycaster.intersectObject(hlRoot, true).find(visibleHit);
  if (!hit) return null;
  const wall = raycaster.intersectObject(occluder, true)[0];
  if (wall && wall.distance + OCCLUSION_TOLERANCE_M < hit.distance) return null;
  let o = hit.object;
  while (o && !apartments.has(o.name)) o = o.parent;
  return o ? o.name : null;
}
const pano = document.getElementById('pano');
let down = null;
pano.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
pano.addEventListener('pointerup', e => {
  if (!down || !visible || !cam) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > TAP_PX) return;
  const id = pick(e.clientX, e.clientY);
  select(id === selected ? null : id);   // повторный тап или тап мимо — снять выбор
});

const loader = new GLTFLoader();
const load = name => loader.loadAsync(DATA + 'building/' + name + '.glb');
// Фид CRM застройщика (crm.js): зелёные подсветки только у активных квартир, остальные — серые «недоступные».
// Фида нет — все 64 активные (null). ?all=1 — тоже все, для проверки.
const ACTIVE_STATUSES = ['AVAILABLE'];
const loadFeed = () => params.has('all') ? Promise.resolve(null) : window.aptFeed.catch(() => null);

(async () => {
  cam = await (await fetch(DATA + 'orbit_main/camera.json')).json();

  for (const g of await Promise.all(OCCLUDER.map(load))) {
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      o.material = occluderMat; o.renderOrder = 0;
      o.geometry.computeBoundsTree();
      o.raycast = acceleratedRaycast;
    });
    occluder.add(g.scene);
  }

  const [hl, feed] = await Promise.all([load('highlights'), loadFeed()]);
  // Узлы верхнего уровня = apartmentId, например 1-07-01; внутри — меши заливки и обводки.
  // Неактивные квартиры (нет в фиде или статус не из ACTIVE_STATUSES) — серые и спрятаны, пока не включено
  // «Показать недоступные» (applyFilter).
  for (const node of [...hl.scene.children]) {
    const available = !feed || ACTIVE_STATUSES.includes(feed[node.name]?.status);
    const apt = { node, available, fills: [], outlines: [], outlineMat: available ? outlineMat : outlineUnavailMat };
    node.traverse(o => {
      if (!o.isMesh) return;
      const outline = o.material.name === 'outline';
      o.material = outline ? apt.outlineMat : available ? fillMat : fillUnavailMat;
      o.renderOrder = outline ? 2 : 1;
      (outline ? apt.outlines : apt.fills).push(o);
    });
    apartments.set(node.name, apt);
  }
  highlights.add(hlRoot = hl.scene);
  applyFilter();
  const pre = params.get('apt');   // ?apt=1-07-01 — сразу выбрать квартиру (для проверки)
  if (pre && apartments.has(pre)) select(pre);
  render();
})().catch(e => console.error('overlay:', e));
