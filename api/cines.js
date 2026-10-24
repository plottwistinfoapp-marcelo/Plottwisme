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
  const q = `[out:json][timeout:20];(node["amenity"="cinema"](around:${r},${lat},${lon});way["amenity"="cinema"](around:${r},${lat},${lon}););out center tags;`;
  const one = async (url) => {
    const to = withTimeout(9000);
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
  for (const term of ['cinema', 'cine']) {
    const to = withTimeout(6000);
    try {
      const url = `https://photon.komoot.io/api/?q=${term}&lat=${lat}&lon=${lon}&limit=50&osm_tag=amenity:cinema`;
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: to.signal });
      if (!res.ok) continue;
      const data = await res.json();
      (data.features || []).forEach(f => {
        const p = f.properties || {}; const c = (f.geometry && f.geometry.coordinates) || [];
        if (c.length < 2) return;
        const id = (p.osm_type || 'N') + (p.osm_id || (c[0] + ',' + c[1]));
        out.set(id, { type: 'photon', id, lat: c[1], lon: c[0], tags: { name: p.name || '', 'addr:city': p.city || p.county || p.state || '' } });
      });
    } catch (e) { /* sigue con el próximo */ } finally { to.done(); }
  }
  if (!out.size) throw new Error('photon empty');
  return [...out.values()];
}

module.exports = async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  let rKm = Number(req.query.r || 30);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { res.status(400).json({ error: 'lat/lon' }); return; }
  if (!isFinite(rKm) || rKm <= 0) rKm = 30;
  rKm = Math.min(rKm, 150);
  // Redondeo para que pedidos de la misma zona compartan la caché
  const la = Math.round(lat * 100) / 100, lo = Math.round(lon * 100) / 100;
  let elements = null, source = '';
  try { elements = await fromOverpass(la, lo, rKm); source = 'overpass'; } catch (e) {}
  if (!elements) { try { elements = await fromPhoton(la, lo); source = 'photon'; } catch (e) {} }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!elements) { res.setHeader('Cache-Control', 'no-store'); res.status(502).json({ error: 'unavailable' }); return; }
  res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=86400');
  res.status(200).json({ source, elements });
};
