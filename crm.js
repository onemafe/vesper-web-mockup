// Квартиры из CRM застройщика (Profitbase): XML-фид в формате Яндекс.Недвижимости — тот же, что читает приложение UE
// (AApartmentLoader, https://www.vespermoscow.com/upload/tfeeds/pogodinskaya-3d.xml). Напрямую с vespermoscow.com
// браузер его не прочтёт (сервер не отдаёт CORS-заголовок), поэтому сайт берёт его со своего адреса — crm/feed.xml:
//  - GitHub Pages — копию раз в 20 минут обновляет GitHub Action (.github/workflows/crm.yml);
//  - локально (serve.cmd) — tools/serve_nocache.py отдаёт по этому адресу живой фид.
// Нет фида — снимок data/apartments/apartments.json (tools/apartments_export.py).
// window.aptFeed — Promise<{ apartmentId: { number, floor, rooms, area, price, status, statusText } }> для index.html
// и overlay.js. В фиде только квартиры в продаже; остальных нет.
(() => {
  const HOUSE_IDS = ['150546', '150547'];   // корпуса 1 и 2, как HouseIds в AApartmentLoader
  // id как у подсветок в UE: номер фида 1-07-702 → 1-07-02 (UVesperXMLParser::NormalizeApartmentID).
  const apartmentId = number => {
    const [b, f, n] = number.split('-').map(Number);
    return `${b}-${String(f).padStart(2, '0')}-${String(n % 100).padStart(2, '0')}`;
  };
  const num = s => (s === '' || isNaN(+s) ? null : +s);

  function parse(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const offers = doc.getElementsByTagNameNS('*', 'offer');
    if (!offers.length) throw new Error('в фиде нет квартир');
    const child = (el, name) => [...el.children].find(c => c.localName === name);
    const get = (el, ...path) => {
      for (const name of path) if (!(el = el && child(el, name))) return '';
      return el.textContent.trim();
    };
    const out = {};
    for (const o of offers) {
      if (!HOUSE_IDS.includes(get(o, 'house', 'id'))) continue;
      const number = get(o, 'number');
      out[apartmentId(number)] = {
        number, floor: num(get(o, 'floor')), rooms: num(get(o, 'rooms')),
        area: num(get(o, 'area', 'value')), price: num(get(o, 'price', 'value')),
        status: get(o, 'status'), statusText: get(o, 'status-humanized'),
      };
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  }

  const ok = r => { if (!r.ok) throw new Error(r.status + ' ' + r.url); return r; };
  window.aptFeed = fetch('crm/feed.xml', { cache: 'no-cache' }).then(ok).then(r => r.text()).then(parse)
    .catch(e => {
      console.warn('CRM: фид недоступен, беру снимок apartments.json —', e.message);
      return fetch('data/apartments/apartments.json').then(ok).then(r => r.json());
    });
})();
