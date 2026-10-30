// Панорама 360 точки обзора на весь экран (Docs/RENDER.md, раздел 4; данные — data/pano/camera.json).
// Куб из 6 граней renders/Pano_Test/<id>/<грань>.webp (в camera.json имена .png из UE — подменяем на .webp), сняты из точки камеры с FOV 90° по осям мира UE.
// Каждая грань — квадрат на расстоянии 1 от камеры, углы считаются из её поворота UE и переводятся тем же
// преобразованием, что overlay.js (glTF = UE (X, Z, Y)), — поэтому ориентация граней не зависит от соглашений
// CubeTexture, а 3D-сцену UE при необходимости можно положить сверху той же камерой.
// Палец/мышь — поворот (взгляд идёт за пальцем), щипок/колесо — приближение. Старт — направление камеры
// приложения в момент съёмки (startView.yaw), горизонт ровный.
// Эквиректангулярная развёртка 2:1 (плагин PanoramicCaptureCustom, ue/pano_plugin.py) — у точки поле equirect
// (путь от renders/Pano_Test/) и equirectYaw — куда смотрит центр картинки; рисуется сферой из направлений UE.
// equirectTiles (16K, ue/pano_shots.py 16k) — развёртка плитками: <имя>/tiles.json и <ряд>_<столбец>.webp
// (tools/compress_renders.py), каждая плитка — свой кусок сферы.
// Варианты одной точки (сравнение настроек съёмки), defaultVariant основной — какой открыть по кнопке «360»,
// variantHidden — скрыть вариант из переключателя: точка с variantOf = <id основной> и variantLabel — кнопки
// вверху переключают грани, направление взгляда сохраняется. Кнопки «360» на этаже — только у основных.
// Наружу: window.pano.open(id), событие 'panoclose' на #panoView. ?pano=<id> — сразу открыть (для проверки).
// Виды из окон квартир (data/views/camera.json, ue/pano_shots.py batch views): window.pano.openViews(<ID квартиры>)
// или ?views=<ID>. Развёртка — только сектор (crop), поворот ограничен, как в приложении UE (BP_POV_Camera):
// центр взгляда — yaw в пределах limits (от перпендикуляра к окну), наклон — limits.pitchMin…Max; край кадра не
// выходит за снятый сектор. Панель внизу — копия WBP_WindowView приложения: карточка с мини-планом
// (T_ViewLocation) и локатором точки, данные квартиры, точки-индикаторы, стрелки по бокам, крестик под карточкой.
import * as THREE from 'three';

const DIR = RENDERS + 'Pano_Test/';
const VIEWS_DIR = RENDERS + 'Views_Test/';
// Вертикальный угол камеры вьюера, °. ?fov=N — стартовый угол (проверка резкости при приближении).
// Отдалять дальше старта нельзя — широкий угол сильно искажает пространство (решение 2026-10-30, было 100).
const FOV_MIN = 35, FOV_MAX = 80;
const FOV_START = Math.max(FOV_MIN, Math.min(FOV_MAX, +new URLSearchParams(location.search).get('fov') || 80));
const PITCH_LIMIT = 85;

const root = document.getElementById('panoView');
const canvas = document.getElementById('panoCanvas');
const loading = document.getElementById('panoLoading');
const variantsBar = document.getElementById('panoVariants');
const nav = document.getElementById('panoNav');
const viewName = document.getElementById('panoViewName');

// Группы точек обзора и их порядок — как у стрелок приложения (WBP_SwitchLobby / WBP_SwitchCourtYard, разобрано
// 2026-10-21): стрелки листают по кругу внутри группы, подпись «ВИД n» — номер в группе с 1. Лобби — индексы
// массива lobby Cameras по порядку; сад — garden Cameras 0, 1, 2 = BP_GardenCamera3, 2, 1. Массаж и макияж —
// по одной точке, без стрелок и номера (только крестик). Бассейн не снимаем.
const GROUPS = [
  ['BP_LobbyCamera1', 'BP_LobbyCamera2', 'BP_LobbyCamera3'],                                           // Gallery
  ['BP_LobbyCamera4', 'BP_LobbyCamera5'],                                                              // GuestRoom
  ['BP_GymCamera1', 'BP_GymCamera2', 'BP_GymCamera3'],                                                 // Gym
  ['BP_LobbyCamera6', 'BP_LobbyCamera7', 'BP_LobbyCamera8', 'BP_LobbyCamera9', 'BP_LobbyCamera10'],    // Reception
  ['BP_GardenCamera3', 'BP_GardenCamera2', 'BP_GardenCamera1'],                                        // сад
];
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

// Материал панорамы: текстура с mipmap-сдвигом MIP_BIAS к более детальному уровню. Без него браузер при уменьшении
// подмешивает более мелкий уровень и картинка мягче, чем позволяет экран (16K выходила как 8K, проверено 2026-10-23).
const MIP_BIAS = -0.5;
function panoMaterial(texture) {
  const m = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  m.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
      `diffuseColor *= texture2D(map, vMapUv, ${MIP_BIAS.toFixed(2)});`);
  };
  return m;
}

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
  return new THREE.Mesh(g, panoMaterial(texture));
}

// Сфера под развёртку: u = 0.5 — yaw центра, u растёт вправо (по часовой сверху, как yaw UE), v = 0 — зенит.
// crop {yawMin, yawMax, pitchMin, pitchMax} — развёртка только сектора (виды из окон): u по yawMin…yawMax, v по pitchMax…pitchMin.
// part {u0, u1, v0, v1} — текстура — только этот кусок развёртки (плитка), доли от её ширины и высоты, v0 — верх.
function sphereMesh(texture, centerYaw, crop, part = { u0: 0, u1: 1, v0: 0, v1: 1 }) {
  const span = crop ? crop.yawMax - crop.yawMin : 360;
  const top = crop ? crop.pitchMax : 90, bottom = crop ? crop.pitchMin : -90;
  if (crop) centerYaw = (crop.yawMin + crop.yawMax) / 2;
  const W = Math.max(8, Math.round(128 * span / 360 * (part.u1 - part.u0)));
  const H = Math.max(8, Math.round(64 * (part.v1 - part.v0))), pos = [], uv = [], idx = [];
  for (let j = 0; j <= H; j++)
    for (let i = 0; i <= W; i++) {
      const u = part.u0 + i / W * (part.u1 - part.u0), v = part.v0 + j / H * (part.v1 - part.v0);
      const { f } = basis(top - v * (top - bottom), centerYaw + (u - 0.5) * span);
      const p = ue(...f);
      pos.push(p.x, p.y, p.z); uv.push(i / W, 1 - j / H);
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
  return new THREE.Mesh(g, panoMaterial(texture));
}

function loadTexture(url) {
  return loader.loadAsync(url).then(tex => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  });
}

// Развёртка точки: одна картинка или плитки (equirectTiles). Меши или null, если не загрузилось.
async function equirectMeshes(point) {
  const yaw = point.equirectYaw ?? point.startView.yaw;
  const base = DIR + point.equirect.replace(/\.png$/i, '');
  try {
    if (!point.equirectTiles) return [sphereMesh(await loadTexture(base + '.webp'), yaw)];
    const t = await fetch(base + '/tiles.json').then(r => r.json());
    const cells = [];
    for (let r = 0; r < t.rows; r++)
      for (let c = 0; c < t.cols; c++) cells.push([r, c]);
    return await Promise.all(cells.map(([r, c]) => loadTexture(`${base}/${r}_${c}.webp`).then(tex => sphereMesh(tex, yaw, null, {
      u0: c * t.tile / t.width, u1: Math.min(t.width, (c + 1) * t.tile) / t.width,
      v0: r * t.tile / t.height, v1: Math.min(t.height, (r + 1) * t.tile) / t.height,
    }))));
  } catch (e) {
    return null;
  }
}

// Убрать меши со сцены и выгрузить их текстуры из видеопамяти: 16K — ~700 МБ, без этого телефон падает
// после пары переключений вариантов.
function clearMeshes() {
  for (const m of cube.children) {
    m.geometry.dispose();
    m.material.map?.dispose();
    m.material.dispose();
  }
  cube.clear();
}

function resize() {
  const r = root.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
}

// Вид из окна: как BP_POV_Camera — центр взгляда в пределах limits; плюс край кадра не выходит за снятый сектор
// (crop = limits ± 45°: при угле по ширине до 90° это ровно пределы приложения, шире — поворот меньше).
function clampView() {
  const lim = viewPoint.limits, crop = viewPoint.crop;
  const vHalf = view.fov / 2, hHalf = THREE.MathUtils.radToDeg(Math.atan(Math.tan(rad(vHalf)) * camera.aspect));
  const near = (a, ref) => ref + ((a - ref) % 360 + 540) % 360 - 180;   // угол a, ближайший к ref (±180)
  let lo = lim.yawMin, hi = lim.yawMax;
  if (crop) { lo = Math.max(lo, crop.yawMin + hHalf); hi = Math.min(hi, crop.yawMax - hHalf); }
  const mid = (lim.yawMin + lim.yawMax) / 2;
  view.yaw = lo > hi ? mid : Math.max(lo, Math.min(hi, near(view.yaw, mid)));
  const plo = Math.max(lim.pitchMin, -PITCH_LIMIT);
  let phi = lim.pitchMax;
  if (crop) phi = Math.min(phi, crop.pitchMax - vHalf);
  view.pitch = plo > phi ? phi : Math.max(plo, Math.min(phi, view.pitch));
}

function render() {
  if (!openId) return;
  resize();
  view.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, view.pitch));
  view.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, view.fov));
  if (viewPoint) clampView();
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
    .sort((a, b) => (a.variantLabel || a.id).localeCompare(b.variantLabel || b.id, undefined, { numeric: true }));   // 6K, 8K, 16K
  variantsBar.replaceChildren(...(group.length < 2 ? [] : group.map(p => {
    const b = document.createElement('button');
    b.className = 'lg';
    b.textContent = p.variantLabel || p.id;
    if (p.variantNote) b.title = p.variantNote;
    b.classList.toggle('on', p.id === point.id);
    b.onclick = () => { if (p.id !== openId) open(p.id, true); };
    return b;
  })));
}

async function open(id, keepView = false) {
  openId = id;
  viewPoint = null;
  root.classList.remove('views');
  root.classList.add('open');
  loading.textContent = 'Загрузка…'; loading.style.display = '';
  if (!keepView) clearMeshes();   // при смене варианта старые грани видны, пока грузятся новые
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
  showNav(point.variantOf || point.id);
  if (!keepView) view = { yaw: point.startView.yaw, pitch: 0, fov: FOV_START };
  const faces = point.equirect
    ? await equirectMeshes(point) || [null]
    : await Promise.all(Object.entries(data.faces).map(([name, rot]) =>
    loader.loadAsync(DIR + point.faces[name].replace(/\.png$/i, '.webp')).then(tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      return faceMesh(rot, tex);
    }).catch(() => null)));
  const drop = () => faces.forEach(m => { if (m) { m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); } });
  if (openId !== id) { drop(); return; }   // пока грузилось, закрыли или открыли другую
  if (faces.includes(null)) { drop(); loading.textContent = `Нет панорамы web/${DIR}${point.equirect || id + '/'} — запустите sync.cmd`; return; }
  clearMeshes();
  cube.add(...faces);
  loading.style.display = 'none';
  render();
}

// Стрелки и «ВИД n»: группа точки — только из тех, что есть в camera.json.
let navGroup = [], navIndex = 0;
function showNav(baseId) {
  const g = GROUPS.find(g => g.includes(baseId)) || [baseId];
  navGroup = g.filter(id => id === baseId || data.points.some(p => p.id === id));
  navIndex = navGroup.indexOf(baseId);
  nav.classList.toggle('single', navGroup.length < 2);
  viewName.textContent = `ВИД ${g.indexOf(baseId) + 1}`;
}
function step(d) {
  if (navGroup.length < 2) return;
  open(navGroup[(navIndex + d + navGroup.length) % navGroup.length]);
}
document.getElementById('panoPrev').onclick = () => step(-1);
document.getElementById('panoNext').onclick = () => step(1);

// --- Виды из окон квартир -----------------------------------------------------------------------------------------
let viewsData = null, aptsData = null, viewPoint = null, viewApt = null, viewIndex = 0;
const wv = {
  dots: document.getElementById('wvDots'), locator: document.getElementById('wvLocator'),
  id: document.getElementById('wvId'), rows: document.getElementById('wvRows'),
};
function loadViews() {
  return viewsData ||= fetch('data/views/camera.json', { cache: 'no-cache' }).then(r => r.json())
    .then(d => (viewsData = d)).catch(() => (viewsData = { apartments: {} }));
}
function loadApts() {
  return aptsData ||= fetch('data/apartments/apartments.json').then(r => r.json())
    .then(d => (aptsData = d)).catch(() => (aptsData = {}));
}
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const money = v => Math.ceil(v).toLocaleString('ru-RU').replace(/\s/g, ' ');

// Текст карточки — как GetApartmentInfoText приложения: номер из фида, спальни, площадь (вверх до целого), этаж, цена.
function showAptInfo(id) {
  const a = aptsData[id];
  wv.id.textContent = a ? a.number : id;
  const rows = a ? [
    `${a.rooms} ${plural(a.rooms, 'спальня', 'спальни', 'спален')}`,
    `${Math.ceil(a.area)} м²`,
    `${a.floor} этаж`,
    a.price ? `${money(a.price)} ₽` : '',
  ] : [`${+id.split('-')[1]} этаж`];
  wv.rows.replaceChildren(...rows.map(t => Object.assign(document.createElement('div'), { textContent: t })));
}

// Локатор на мини-плане — WBP_WindowView.Set Locator Appearance: позиция от центра плана по мировым X, Y точки
// (Get A / Get B Coordinates: корпус A — ID на «1-», иначе B), поворот = перпендикуляр + 39°, ось — левый край по центру.
function placeLocator(p) {
  const [x, y] = p.location, cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const [lx, ly] = viewApt.startsWith('1-')
    ? [cl(0.021898 * x - 0.017711 * y + 179.647463, -89.5, -11.5), cl(0.017688 * x + 0.021897 * y + 157.729715, -13.75, 64.25)]
    : [cl(0.021666 * x - 0.018559 * y + 174.618272, 32.5, 92.5), cl(0.017695 * x + 0.020656 * y + 158.863986, -65.75, 40.25)];
  wv.locator.style.transform = `translate(${lx}px, ${ly - 31}px) rotate(${p.limits.perpendicular + 39}deg)`;
}

// Точки-индикаторы (Set Dots Visibility / Appearance): до 8, при одном виде не видны.
function showDots(count) {
  wv.dots.replaceChildren(...Array.from({ length: count > 1 ? Math.min(count, 8) : 0 }, (_, i) => {
    const d = document.createElement('i');
    d.classList.toggle('on', i === viewIndex);
    return d;
  }));
}

async function openViews(aptId) {
  openId = `views:${aptId}`;
  viewApt = aptId;
  viewPoint = null;
  root.classList.add('open', 'views');
  variantsBar.replaceChildren();
  loading.textContent = 'Загрузка…'; loading.style.display = '';
  clearMeshes();
  await Promise.all([loadViews(), loadApts()]);
  showAptInfo(aptId);
  const apt = viewsData.apartments[aptId];
  if (!apt) { showDots(0); wv.locator.style.visibility = 'hidden'; loading.textContent = 'Виды из окон этой квартиры ещё не сняты'; return; }
  showView(apt.firstView ?? 0);   // как Init First View: точка с bIsFirstView, иначе первая
}

async function showView(index) {
  const apt = viewsData.apartments[viewApt];
  const id = openId;
  viewIndex = index;
  viewPoint = null;
  showDots(apt.count);
  clearMeshes();
  const p = apt.points.find(q => q.index === index);
  wv.locator.style.visibility = p ? '' : 'hidden';
  if (!p) { loading.textContent = 'Этот вид не снят'; loading.style.display = ''; return; }
  placeLocator(p);
  loading.textContent = 'Загрузка…'; loading.style.display = '';
  const mesh = await loader.loadAsync(VIEWS_DIR + p.equirect.replace(/\.png$/i, '.webp')).then(tex => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return sphereMesh(tex, p.equirectYaw, p.crop);
  }).catch(() => null);
  if (openId !== id || viewIndex !== index) return;   // пока грузилось, переключили или закрыли
  if (!mesh) { loading.textContent = `Нет ${VIEWS_DIR}${p.equirect} — запустите sync.cmd`; return; }
  viewPoint = p;
  view = { yaw: p.startView.yaw, pitch: p.startView.pitch, fov: FOV_START };   // поза точки, как в приложении
  cube.add(mesh);
  loading.style.display = 'none';
  render();
}
// Стрелки — по кругу, как OnClicked(Left/RightButton) приложения.
function viewStep(d) {
  const n = viewsData?.apartments[viewApt]?.count || 0;
  if (n > 1) showView((viewIndex + d + n) % n);
}
document.getElementById('wvPrev').onclick = () => viewStep(-1);
document.getElementById('wvNext').onclick = () => viewStep(1);
document.getElementById('wvClose').onclick = () => close();

function close() {
  openId = null;
  viewPoint = null;
  root.classList.remove('views');
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

window.pano = { open, openViews, close };
const qs = new URLSearchParams(location.search);
if (qs.has('pano')) open(qs.get('pano'));
if (qs.has('views')) openViews(qs.get('views'));
