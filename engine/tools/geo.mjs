import { getJSON, cached, DAY } from '../util.mjs';

const geocodeUncached = async name => {
  const query = String(name).replace(/[?.!]+$/, '').trim();
  const tries = [query, query.split(',')[0].trim()];
  for (const attempt of tries) {
    const data = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(attempt)}&count=5&language=en&format=json`, { timeout: 5000 });
    const results = data.results || [];
    if (!results.length) continue;
    const country = query.includes(',') ? query.split(',').slice(1).join(',').trim().toLowerCase() : null;
    const fitting = country ? results.filter(r => [r.country, r.country_code, r.admin1].some(v => v && v.toLowerCase() === country)) : results;
    const best = (fitting.length ? fitting : results).sort((a, b) => (b.population || 0) - (a.population || 0))[0];
    return {
      name: best.name, country: best.country, admin: best.admin1, countryCode: best.country_code,
      latitude: best.latitude, longitude: best.longitude, timezone: best.timezone, population: best.population, elevation: best.elevation,
      label: [best.name, best.admin1 && best.admin1 !== best.name ? best.admin1 : null, best.country].filter(Boolean).join(', ')
    };
  }
  return null;
};
export const geocode = cached('geo', 30 * DAY, geocodeUncached);

export function placeFrom(text, extra = []) {
  const q = String(text).replace(/[?!.]+$/, '');
  const trailing = /\s+(?:right now|now|today|tonight|tomorrow|this week(?:end)?|next week|currently|at the moment|please|in (?:celsius|fahrenheit)|in \d+ days|(?:on |this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:morning|afternoon|evening)|over the weekend)\b.*$/i;
  const m = q.match(/\b(?:in|at|for|of|near|from)\s+([A-Z\p{Lu}][\p{L}\-' .]+(?:,\s*[\p{L} .]+)?)$/u) ||
            q.match(/\b(?:in|at|for|near)\s+([\p{L}\-' .]+?(?:,\s*[\p{L} .]+)?)(?:\s+(?:right now|now|today|tonight|tomorrow|this week|next week|currently)\b.*)?$/iu);
  let place = m?.[1]?.replace(trailing, '').split(/\s+(?:and|but|or|so|then|because|if|should|will|would|do|does|is|are|can|could)\b|,(?=\s*(?:and|but|should|will|is|do|can)\b)/i)[0].trim();
  if (!place) {
    const stripped = q.replace(new RegExp(`\\b(${['what', "what's", 'whats', 'is', 'the', 'current', 'right now', 'today', 'tomorrow', 'forecast', 'weather', 'like', 'time', 'local', 'it', 'there', ...extra].join('|')})\\b`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
    if (stripped && stripped.split(' ').length <= 4) place = stripped;
  }
  return place && place.length > 1 ? place : null;
}

export function haversine(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
