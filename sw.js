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

module.exports = async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  let rKm = Number(req.query.r || 30);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { res.status(400).json({ error: 'lat/lon' }); return; }
  if (!isFinite(rKm) || rKm <= 0) rKm = 30;
  rKm = Math.min(rKm, 150);
  // Redondeo para que pedidos de la misma zona compartan la caché
  const la = Math.round(lat * 100) / 100, lo = Math.round(lon * 100) / 100;
  // Preguntamos a los dos a la vez. Overpass es más completo: si Photon contesta primero,
  // esperamos a Overpass como mucho 2 segundos más; si no llega, usamos Photon.
  let elements = null, source = '';
  const ov = fromOverpass(la, lo, rKm).then(e => ({ e, s: 'overpass' }));
  const ph = fromPhoton(la, lo).then(e => ({ e, s: 'photon' }));
  ov.catch(() => {}); ph.catch(() => {});
  const first = await Promise.any([ov, ph]).catch(() => null);
  if (first && first.s === 'overpass') { elements = first.e; source = 'overpass'; }
  else if (first && first.s === 'photon') {
    // Si Photon no trajo nada dentro del radio, esperamos a Overpass todo lo que haga falta
    const km = (e) => { const R = 6371, dLa = (e.lat - la) * Math.PI / 180, dLo = (e.lon - lo) * Math.PI / 180; const x = Math.sin(dLa / 2) ** 2 + Math.cos(la * Math.PI / 180) * Math.cos(e.lat * Math.PI / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
    const near = first.e.filter(e => km(e) <= rKm).length;
    const better = await Promise.race([ov.catch(() => null), new Promise(r => setTimeout(() => r(null), near ? 2000 : 9000))]);
    if (better) { elements = better.e; source = 'overpass'; } else { elements = first.e; source = 'photon'; }
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!elements) { res.setHeader('Cache-Control', 'no-store'); res.status(502).json({ error: 'unavailable' }); return; }
  // Si no hay resultados, guardamos poco tiempo (15 min) por si fue un problema pasajero
  res.setHeader('Cache-Control', elements.length ? 'public, s-maxage=43200, stale-while-revalidate=86400' : 'public, s-maxage=900');
  res.status(200).json({ source, elements });
};
