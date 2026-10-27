// Plottwistme: busca cines cerca de un punto, del lado del servidor (Vercel).
// Así el celular no habla directo con Overpass, que bloquea o rechaza muchos pedidos desde navegadores.
// Uso: /api/cines?lat=-27.49&lon=-55.12&r=30   (r en km, máximo 150)
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const UA = 'Plottwistme/1.0 (https://plottwisme.vercel.app; plottwist.infoapp@gmail.com)';

const withTimeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };

async function fromOverpass(lat, lon, rKm) {
  const r = Math.round(rKm * 1000);
  const a = `(around:${r},${lat},${lon})`;
  // Cines, y también teatros con "cine" en el nombre (muchos "Cine Teatro" están cargados como teatro)
  const q = `[out:json][timeout:20];(node["amenity"="cinema"]${a};way["amenity"="cinema"]${a};node["amenity"="theatre"]["name"~"cine",i]${a};way["amenity"="theatre"]["name"~"cine",i]${a};);out center tags;`;
  const one = async (url) => {
    const to = withTimeout(8000);
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Referer': 'https://plottwisme.vercel.app/' }, signal: to.signal });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.elements)) throw new Error('bad data');
      return data.elements;
    } finally { to.done(); }
  };
  return await new Promise((resolve, reject) => {
    let failed = 0;
    MIRRORS.forEach(u => one(u).then(resolve, () => { failed++; if (failed === MIRRORS.length) reject(new Error('overpass failed')); }));
  });
}

async function fromPhoton(lat, lon) {
  const out = new Map();
  const searches = [['cinema', 'amenity:cinema'], ['cine', 'amenity:cinema'], ['cine', 'amenity:theatre']];
  await Promise.all(searches.map(async ([term, tag]) => {
    const to = withTimeout(5000);
    try {
      const url = `https://photon.komoot.io/api/?q=${term}&lat=${lat}&lon=${lon}&limit=50&osm_tag=${tag}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: to.signal });
      if (!res.ok) return;
      const data = await res.json();
      (data.features || []).forEach(f => {
        const p = f.properties || {}; const c = (f.geometry && f.geometry.coordinates) || [];
        if (c.length < 2) return;
        if (tag === 'amenity:theatre' && !/cine/i.test(p.name || '')) return;
        const id = (p.osm_type || 'N') + (p.osm_id || (c[0] + ',' + c[1]));
        out.set(id, { type: 'photon', id, lat: c[1], lon: c[0], tags: { name: p.name || '', 'addr:city': p.city || p.county || p.state || '' } });
      });
    } catch (e) { /* sigue con el otro */ } finally { to.done(); }
  }));
  if (!out.size) throw new Error('photon empty');
  return [...out.values()];
}

async function fromNominatim(lat, lon, rKm) {
  // Caja alrededor del punto (≈ radio pedido)
  const dLat = rKm / 111, dLon = rKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const box = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map(n => n.toFixed(4)).join(',');
  const out = new Map();
  await Promise.all(['cinema', 'cine'].map(async (term) => {
    const to = withTimeout(6000);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${term}&viewbox=${box}&bounded=1&limit=50&extratags=0`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es' }, signal: to.signal });
      if (!res.ok) return;
      const data = await res.json();
      (data || []).forEach(p => {
        const isCine = p.type === 'cinema' || (p.type === 'theatre' && /cine/i.test(p.name || ''));
        if (!isCine) return;
        const id = (p.osm_type || 'n')[0].toUpperCase() + p.osm_id;
        out.set(id, { type: 'nominatim', id, lat: Number(p.lat), lon: Number(p.lon), tags: { name: p.name || '', 'addr:city': '' } });
      });
    } catch (e) {} finally { to.done(); }
  }));
  if (!out.size) throw new Error('nominatim empty');
  return [...out.values()];
}

// Junta resultados de varias fuentes sin repetir el mismo cine (mismo nombre a menos de 400 m)
function mergeLists(lists) {
  const all = [];
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const pos = (e) => ({ lat: e.lat ?? (e.center && e.center.lat), lon: e.lon ?? (e.center && e.center.lon) });
  const close = (a, b) => { const A = pos(a), B = pos(b); return Math.abs(A.lat - B.lat) < 0.004 && Math.abs(A.lon - B.lon) < 0.004; };
  lists.forEach(list => (list || []).forEach(e => {
    const n = norm(e.tags && e.tags.name);
    if (all.some(x => close(x, e) && (norm(x.tags && x.tags.name) === n || !n))) return;
    all.push(e);
  }));
  return all;
}

module.exports = async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  let rKm = Number(req.query.r || 30);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { res.status(400).json({ error: 'lat/lon' }); return; }
  if (!isFinite(rKm) || rKm <= 0) rKm = 30;
  rKm = Math.min(rKm, 150);
  // Redondeo para que pedidos de la misma zona compartan la caché
  const la = Math.round(lat * 100) / 100, lo = Math.round(lon * 100) / 100;
  // Preguntamos a las tres fuentes a la vez y juntamos lo que llegue en hasta 6 segundos.
  // Overpass es la más completa; Photon y Nominatim completan cuando Overpass falla o tarda.
  const settle = (p) => p.then(e => e, () => null);
  const ov = settle(fromOverpass(la, lo, rKm));
  const ph = settle(fromPhoton(la, lo));
  const no = settle(fromNominatim(la, lo, rKm));
  const results = { ov: null, ph: null, no: null };
  ov.then(v => { results.ov = v; }); ph.then(v => { results.ph = v; }); no.then(v => { results.no = v; });
  // Esperamos a Overpass hasta 6 s (o a que terminen las tres). Después juntamos lo que haya llegado.
  await Promise.race([ov.then(v => v || Promise.all([ph, no])), Promise.all([ov, ph, no]), new Promise(r => setTimeout(r, 6000))]);
  // Si Overpass llegó primero, damos medio segundo a las otras para sumar cines que le falten
  if (results.ov && (!results.ph || !results.no)) await Promise.race([Promise.all([ph, no]), new Promise(r => setTimeout(r, 500))]);
  const elements = mergeLists([results.ov, results.ph, results.no]);
  const source = [results.ov && 'overpass', results.ph && 'photon', results.no && 'nominatim'].filter(Boolean).join('+');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!source) { res.setHeader('Cache-Control', 'no-store'); res.status(502).json({ error: 'unavailable' }); return; }
  // Con Overpass: 12 h de caché. Solo con respaldo (puede estar incompleto): 1 h. Sin resultados: 15 min.
  res.setHeader('Cache-Control', !elements.length ? 'public, s-maxage=900' : (results.ov ? 'public, s-maxage=43200, stale-while-revalidate=86400' : 'public, s-maxage=3600'));
  res.status(200).json({ source, elements });
};
