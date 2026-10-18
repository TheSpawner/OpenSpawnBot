import { getJSON, getText, cached, MINUTE, HOUR, DAY } from '../util.mjs';
import { geocode, placeFrom, haversine } from './geo.mjs';
import { spell } from '../search.mjs';

const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail' };
const usesFahrenheit = place => ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW'].includes(place.countryCode);
const OFF_EARTH = /\b(moon|sun|mars|venus|mercury|jupiter|saturn|uranus|neptune|pluto|space|orbit|galaxy|milky way|andromeda|iss|space station|alpha centauri|proxima)\b/i;
const sameName = (asked, found) => {
  const a = asked.toLowerCase().replace(/^the\s+/, '').split(',')[0].trim(), b = found.name.toLowerCase();
  return a === b || b.includes(a) || a.includes(b) || [found.label, found.country, found.admin].some(x => x && x.toLowerCase().includes(a));
};
const needPlace = async (name) => {
  if (!name) throw new Error('which place?');
  if (OFF_EARTH.test(name)) throw new Error(`"${name}" is not a place on Earth`);
  const place = await geocode(name);
  if (place && sameName(name, place)) return place;
  const suggestion = await spell(name).catch(() => null);
  const fixed = suggestion && suggestion.toLowerCase() !== name.toLowerCase() ? suggestion.replace(/\s*\(.*\)$/, '').split(',')[0] : null;
  if (fixed) {
    const again = await geocode(fixed);
    if (again && sameName(fixed, again)) return { ...again, corrected: `${name} → ${again.name}` };
  }
  throw new Error(`could not find a place called "${name}"`);
};
const placeArgs = { place: { type: 'string', description: 'the city, region or country named in the request' } };

const forecast = cached('weather', 15 * MINUTE, async (lat, lon, imperial) => getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max&timezone=auto&forecast_days=7${imperial ? '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch' : ''}`));

function daysAsked(q, days) {
  if (/\btomorrow\b/i.test(q)) return days.slice(1, 2);
  if (/\bweekend\b/i.test(q)) { const w = days.filter(d => [0, 6].includes(new Date(d.date + 'T12:00').getDay())); if (w.length) return w.slice(0, 2); }
  const named = q.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[1]?.toLowerCase();
  if (named) { const hit = days.find(d => new Date(d.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() === named); if (hit) return [hit]; }
  if (/\b(this week|next few days|coming days)\b/i.test(q)) return days.slice(0, 5);
  return days.slice(0, 1);
}
const SNOW = new Set([71, 73, 75, 77, 85, 86]);
function wardrobe(q, days, imperial, T, label) {
  const asksCoat = /\b(jacket|coat|sweater|hoodie|jumper|layers?|warm clothes|what (should|do) i wear|bundle up)\b/i.test(q);
  const asksRain = /\b(umbrella|rain(ing|y)?|drizzle|wet|showers?)\b/i.test(q);
  const asksShorts = /\b(shorts|t-?shirt|sandals|beach weather|swim)\b/i.test(q);
  const asksSnow = /\bsnow(ing|y)?\b/i.test(q);
  if (!asksCoat && !asksRain && !asksShorts && !asksSnow) {
    if (!/\b(tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next few days)\b/i.test(q)) return null;
    const asked = daysAsked(q, days);
    const line = d => `${d.label} in ${label}: ${d.sky}, high ${d.max}${T}, low ${d.min}${T}, ${d.rain ?? 0}% chance of rain.`;
    const text = asked.map(line).join(' ');
    return { direct: asked.length === 1 ? `**${asked[0].sky.replace(/^./, c => c.toUpperCase())}**, ${asked[0].max}${T} / ${asked[0].min}${T}` : `**${asked.map(d => d.label).join(' & ')}**`, reason: text, fact: text };
  }
  const chosen = daysAsked(q, days);
  if (!chosen.length) return null;
  const f = t => imperial ? t : t * 9 / 5 + 32;
  const low = Math.min(...chosen.map(d => d.min)), high = Math.max(...chosen.map(d => d.max)), rain = Math.max(...chosen.map(d => d.rain ?? 0));
  const when = chosen.length > 1 ? chosen.map(d => d.label).join(' and ') : chosen[0].label.toLowerCase();
  const range = `${when}: low ${low}${T}, high ${high}${T}, ${rain}% chance of rain`;
  let answer, reason;
  if (asksSnow) {
    const snowy = chosen.filter(d => SNOW.has(d.code));
    answer = snowy.length ? `**Yes**, snow is forecast ${snowy.map(d => d.label.toLowerCase()).join(' and ')} in ${label}.` : `**No** snow is forecast ${when} in ${label}.`;
  } else if (asksRain) {
    answer = rain >= 50 ? `**Yes**, take an umbrella: there is a ${rain}% chance of rain ${when} in ${label}.`
      : rain >= 25 ? `**Maybe**: there is a ${rain}% chance of rain ${when} in ${label}, so a small umbrella would not hurt.`
      : `**No**, rain is unlikely ${when} in ${label} (${rain}% chance).`;
  } else if (asksShorts) {
    answer = f(high) >= 75 ? `**Yes**, it is shorts weather ${when} in ${label}, with a high of ${high}${T}.` : f(high) >= 68 ? `**Borderline**: ${when} in ${label} peaks at ${high}${T}, fine in the sun but cool in the shade.` : `**No**, it is not really shorts weather ${when} in ${label}: the high is only ${high}${T}.`;
  } else {
    answer = f(low) < 45 ? `**Yes**, bring a warm jacket: ${when} in ${label} goes down to ${low}${T}.`
      : f(low) < 58 || f(high) < 65 ? `**Yes**, a light jacket is a good idea: ${when} in ${label} ranges from ${low}${T} to ${high}${T}.`
      : `**Probably not**: ${when} in ${label} stays between ${low}${T} and ${high}${T}.`;
    if (rain >= 50) answer += ` Rain is likely too (${rain}%), so make it a waterproof one.`;
  }
  reason = `Forecast for ${range}.`;
  return { direct: answer, reason, fact: answer.replace(/\*\*/g, '') + ` (${range}.)` };
}

const weather = {
  id: 'weather', title: 'Weather', family: 'World', standalone: true,
  description: 'Current weather conditions and the forecast for the next few days in any place',
  decides: true,
  examples: ['what is the weather in Paris', 'will it rain tomorrow in London', 'temperature in Tokyo right now', 'weather forecast for Chicago this week', 'is it cold in Moscow', 'how hot is it in Dubai', 'Lagos weather', 'do I need an umbrella in Seattle today', 'is it snowing in Denver', 'do I need a jacket in Chicago tomorrow', 'should I bring a coat to Boston this weekend', 'is it shorts weather in LA today', 'what should I wear in New York tomorrow', 'will it be cold in Denver this weekend'],
  pattern: /\b(weather|forecast|temperature|rain(ing|y)?|snow(ing|y)?|umbrella|humid(ity)?|windy|sunny|how (hot|cold|warm)|jacket|coat|sweater|hoodie|shorts weather|what (should|do) i wear|(cold|hot|warm|chilly) (out|outside|today|tomorrow|this weekend))\b/i,
  args: placeArgs,
  extract: q => { const place = placeFrom(q, ['rain', 'raining', 'snow', 'snowing', 'cold', 'hot', 'warm', 'umbrella', 'need', 'an', 'do', 'i', 'will', 'temperature', 'how', 'this week', 'week', 'jacket', 'coat', 'sweater', 'hoodie', 'wear', 'bring', 'should', 'shorts', 'gonna', 'going to', 'this weekend', 'weekend']); return place ? { place } : null; },
  async run({ place: name }, ctx = {}) {
    const place = await needPlace(name);
    const imperial = usesFahrenheit(place);
    const data = await forecast(place.latitude, place.longitude, imperial);
    const c = data.current, d = data.daily, T = imperial ? '°F' : '°C', W = imperial ? 'mph' : 'km/h';
    const days = d.time.map((date, i) => ({ date, label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' }), max: Math.round(d.temperature_2m_max[i]), min: Math.round(d.temperature_2m_min[i]), rain: d.precipitation_probability_max[i], sky: WMO[d.weather_code[i]] || 'mixed', code: d.weather_code[i] }));
    const facts = [
      `Right now in ${place.label} it is ${Math.round(c.temperature_2m)}${T} (feels like ${Math.round(c.apparent_temperature)}${T}) with ${WMO[c.weather_code] || 'mixed conditions'}, humidity ${c.relative_humidity_2m}% and wind ${Math.round(c.wind_speed_10m)} ${W}.`,
      ...days.map(day => `${day.label} (${day.date}): ${day.sky}, high ${day.max}${T}, low ${day.min}${T}, ${day.rain ?? 0}% chance of precipitation.`)
    ];
    const result = {
      facts, sources: [{ title: `Open-Meteo forecast for ${place.label}`, url: `https://open-meteo.com/en/docs#latitude=${place.latitude}&longitude=${place.longitude}` }],
      card: { kind: 'weather', place: place.label, now: { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), sky: WMO[c.weather_code], code: c.weather_code, humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m) }, unit: T, windUnit: W, days }
    };
    const verdict = wardrobe(ctx.question || '', days, imperial, T, place.label);
    if (verdict) Object.assign(result, { direct: verdict.direct, body: verdict.reason, exact: true, facts: [verdict.fact, ...facts] });
    return result;
  }
};

const air = {
  id: 'air_quality', title: 'Air quality', family: 'World', standalone: true,
  description: 'Current air quality index, pollution and pollen in a place',
  examples: ['air quality in Delhi', 'how polluted is Beijing today', 'AQI in Los Angeles', 'is the air safe to breathe in Lahore', 'pm2.5 level in Paris', 'pollen count in London'],
  pattern: /\b(air quality|aqi|pollution|polluted|smog|pm ?2\.?5|pm10|pollen)\b/i,
  args: placeArgs,
  extract: q => { const place = placeFrom(q, ['air', 'quality', 'aqi', 'pollution', 'polluted', 'how', 'level', 'pollen', 'count', 'smog']); return place ? { place } : null; },
  async run({ place: name }) {
    const place = await needPlace(name);
    const data = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.latitude}&longitude=${place.longitude}&current=us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,grass_pollen,birch_pollen`);
    const c = data.current;
    const band = c.us_aqi <= 50 ? 'Good' : c.us_aqi <= 100 ? 'Moderate' : c.us_aqi <= 150 ? 'Unhealthy for sensitive groups' : c.us_aqi <= 200 ? 'Unhealthy' : c.us_aqi <= 300 ? 'Very unhealthy' : 'Hazardous';
    return {
      facts: [`The current US Air Quality Index in ${place.label} is ${c.us_aqi} (${band}). PM2.5 is ${c.pm2_5} µg/m³, PM10 is ${c.pm10} µg/m³, ozone ${c.ozone} µg/m³, NO₂ ${c.nitrogen_dioxide} µg/m³.` + (c.grass_pollen != null ? ` Grass pollen ${c.grass_pollen} grains/m³.` : '')],
      card: { kind: 'big', headline: `AQI ${c.us_aqi}`, detail: `${band} · ${place.label} · PM2.5 ${c.pm2_5} µg/m³` },
      sources: [{ title: 'Open-Meteo Air Quality (CAMS)', url: 'https://open-meteo.com/en/docs/air-quality-api' }]
    };
  }
};

const sun = {
  id: 'sun', title: 'Sunrise & sunset', family: 'World', standalone: true,
  description: 'Sunrise, sunset and day length for a place',
  examples: ['when is sunset in Paris', 'sunrise time in New York tomorrow', 'what time does the sun set in Reykjavik', 'how long is the day in Oslo', 'golden hour in Rome'],
  pattern: /\b(sunrise|sunset|sun (rise|set)|daylight|day length|golden hour|dawn|dusk)\b/i,
  args: placeArgs,
  extract: q => { const place = placeFrom(q, ['sunrise', 'sunset', 'when', 'time', 'does', 'sun', 'set', 'rise', 'how', 'long', 'day', 'golden', 'hour']); return place ? { place } : null; },
  async run({ place: name }) {
    const place = await needPlace(name);
    const data = await forecast(place.latitude, place.longitude, false);
    const fmtTime = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    const rise = data.daily.sunrise.map(s => fmtTime(s + 'Z')), set = data.daily.sunset.map(s => fmtTime(s + 'Z'));
    const lengths = data.daily.sunrise.map((s, i) => (new Date(data.daily.sunset[i] + 'Z') - new Date(s + 'Z')) / 60000);
    const hm = m => `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
    return {
      facts: [`Today in ${place.label}: sunrise at ${rise[0]}, sunset at ${set[0]}, ${hm(lengths[0])} of daylight (local time).`, `Tomorrow: sunrise ${rise[1]}, sunset ${set[1]}.`],
      card: { kind: 'big', headline: `↑ ${rise[0]}  ↓ ${set[0]}`, detail: `${place.label} · ${hm(lengths[0])} of daylight · local time` },
      sources: [{ title: 'Open-Meteo astronomy', url: 'https://open-meteo.com' }]
    };
  }
};

const quakes = {
  id: 'earthquakes', title: 'Earthquakes', family: 'World', standalone: false,
  description: 'Recent significant earthquakes worldwide or near a place',
  examples: ['recent earthquakes', 'was there an earthquake today', 'latest earthquake in Japan', 'biggest earthquakes this week', 'earthquake near California'],
  pattern: /\b(earthquakes?|quakes?|seismic|tremors?)\b/i,
  extract: q => ({ place: placeFrom(q, ['earthquake', 'earthquakes', 'recent', 'latest', 'biggest', 'today', 'this', 'week', 'there', 'was', 'an', 'any']) || '' }),
  async run({ place: name }) {
    const data = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson');
    let events = data.features.map(f => ({ mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time), url: f.properties.url, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], depth: f.geometry.coordinates[2] }));
    let where = 'worldwide';
    if (name) {
      const place = await geocode(name).catch(() => null);
      const needle = name.toLowerCase();
      const byName = events.filter(e => e.place?.toLowerCase().includes(needle));
      if (byName.length) events = byName;
      else if (place) events = events.filter(e => haversine(place, { latitude: e.lat, longitude: e.lon }) < 1500);
      where = `near ${place?.label || name}`;
    }
    const top = events.sort((a, b) => b.time - a.time).slice(0, 6);
    const biggest = [...events].sort((a, b) => b.mag - a.mag)[0];
    const facts = top.length ? [
      `USGS recorded ${events.length} earthquakes of magnitude 4.5 or more ${where} in the past 7 days.`,
      ...top.map(e => `M${e.mag.toFixed(1)} — ${e.place} — ${e.time.toUTCString().slice(0, 22)} UTC, depth ${Math.round(e.depth)} km.`),
      biggest ? `The strongest was M${biggest.mag.toFixed(1)}, ${biggest.place}.` : ''
    ].filter(Boolean) : [`USGS recorded no earthquakes of magnitude 4.5+ ${where} in the past 7 days.`];
    return { facts, card: { kind: 'list', title: `Earthquakes M4.5+ ${where}, last 7 days`, items: top.map(e => ({ label: `M${e.mag.toFixed(1)}`, text: e.place, meta: e.time.toUTCString().slice(5, 22), url: e.url })) }, sources: [{ title: 'USGS Earthquake Hazards Program', url: 'https://earthquake.usgs.gov/earthquakes/map/' }] };
  }
};

const where = {
  id: 'place', title: 'Place finder', family: 'World', standalone: false,
  description: 'Where a place is: country, region, coordinates, elevation and population of a city',
  examples: ['where is Timbuktu', 'what country is Kyoto in', 'gps coordinates of Mount Everest', 'where is Zanzibar on the map', 'where is Kyoto located', 'which country is Zanzibar part of', 'latitude and longitude of Cairo'],
  pattern: /^where is\b|\bwhat country is\b|\bwhich country\b|\bcoordinates of\b|\blatitude\b|\belevation of\b|\bwhere is .* located/i,
  args: placeArgs,
  extract: q => { const m = q.match(/(?:where is|what country is|which country is|coordinates of|elevation of|latitude and longitude of|location of)\s+(.+?)(?:\s+(?:located|in|part of))?\??$/i); return m ? { place: m[1] } : null; },
  async run({ place: name }) {
    const place = await needPlace(name);
    return {
      facts: [`${place.name} is in ${[place.admin, place.country].filter(Boolean).join(', ')}, at latitude ${place.latitude.toFixed(4)}, longitude ${place.longitude.toFixed(4)}${place.elevation != null ? `, elevation ${Math.round(place.elevation)} m` : ''}. Time zone: ${place.timezone}.`],
      card: { kind: 'map', place: place.label, lat: place.latitude, lon: place.longitude },
      sources: [{ title: `OpenStreetMap: ${place.label}`, url: `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=10/${place.latitude}/${place.longitude}` }]
    };
  }
};

const distance = {
  id: 'distance', title: 'Distance', family: 'World', standalone: true, feedsMath: true,
  description: 'Straight-line distance between two places',
  examples: ['distance from London to Paris', 'how far is Tokyo from Sydney', 'how many miles between New York and Los Angeles', 'how far apart are Berlin and Rome', 'km from Lagos to Abuja'],
  pattern: /\b(distance|how far|miles between|km between|kilometers between|far apart)\b/i,
  args: { from: { type: 'string' }, to: { type: 'string' } },
  extract(q) {
    const m = q.match(/(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+?)(?:\s+in\s+(?:miles|km|kilometers))?\??$/i) || q.match(/how far is\s+(.+?)\s+from\s+(.+?)\??$/i) || q.match(/how far apart are\s+(.+?)\s+and\s+(.+?)\??$/i);
    return m ? { from: m[1].trim(), to: m[2].trim() } : null;
  },
  async run({ from, to }) {
    const [a, b] = await Promise.all([needPlace(from), needPlace(to)]);
    const km = haversine(a, b);
    return {
      facts: [`The straight-line (great-circle) distance from ${a.label} to ${b.label} is ${Math.round(km).toLocaleString()} km (${Math.round(km * 0.621371).toLocaleString()} miles). Road or flight distance is longer.`],
      card: { kind: 'big', headline: `${Math.round(km).toLocaleString()} km`, detail: `${Math.round(km * 0.621371).toLocaleString()} mi · ${a.label} → ${b.label} · great-circle` },
      sources: [{ title: 'Great-circle distance from Open-Meteo geocoding', url: 'https://open-meteo.com/en/docs/geocoding-api' }]
    };
  }
};

const COUNTRY = { usa: 'US', 'united states': 'US', us: 'US', america: 'US', uk: 'GB', 'united kingdom': 'GB', britain: 'GB', england: 'GB', germany: 'DE', france: 'FR', spain: 'ES', italy: 'IT', canada: 'CA', mexico: 'MX', brazil: 'BR', japan: 'JP', china: 'CN', india: 'IN', australia: 'AU', nigeria: 'NG', 'south africa': 'ZA', netherlands: 'NL', sweden: 'SE', norway: 'NO', poland: 'PL', ireland: 'IE', portugal: 'PT', switzerland: 'CH', austria: 'AT', belgium: 'BE', denmark: 'DK', finland: 'FI', 'new zealand': 'NZ', argentina: 'AR', 'south korea': 'KR', korea: 'KR', ukraine: 'UA', turkey: 'TR', egypt: 'EG', kenya: 'KE', greece: 'GR', russia: 'RU', philippines: 'PH', indonesia: 'ID', singapore: 'SG', colombia: 'CO', chile: 'CL', peru: 'PE', serbia: 'RS', croatia: 'HR', 'czech republic': 'CZ', czechia: 'CZ', hungary: 'HU', romania: 'RO' };
const holidays = {
  id: 'holidays', title: 'Public holidays', family: 'World', standalone: true,
  description: 'Public holidays in a country for a year, and the next upcoming holiday',
  examples: ['public holidays in Germany 2026', 'next holiday in the UK', 'bank holidays in England this year', 'what holidays are there in Japan', 'when is the next public holiday in the US', 'is Monday a holiday in Canada'],
  pattern: /\b(public|bank|national|federal) holidays?\b|\bnext holiday\b|\bholidays in\b/i,
  args: { country: { type: 'string' } },
  extract: q => { const m = q.toLowerCase().match(new RegExp(`\\b(${Object.keys(COUNTRY).sort((a, b) => b.length - a.length).join('|')})\\b`)); return m ? { country: m[1], year: q.match(/\b20\d\d\b/)?.[0] } : null; },
  async run({ country, year }) {
    const code = COUNTRY[String(country).toLowerCase()] || String(country).toUpperCase().slice(0, 2);
    const y = Number(year) || new Date().getFullYear();
    const list = await getJSON(`https://date.nager.at/api/v3/PublicHolidays/${y}/${code}`);
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = list.filter(h => h.date >= today);
    const facts = [`${list.length} public holidays in ${country} in ${y}${upcoming[0] ? `; the next is ${upcoming[0].name} on ${upcoming[0].date}` : ''}.`, ...list.map(h => `${h.date}: ${h.name}${h.localName !== h.name ? ` (${h.localName})` : ''}${h.global ? '' : ' — regional'}`)];
    return { facts, card: { kind: 'list', title: `Public holidays — ${country}, ${y}`, items: list.map(h => ({ label: h.date.slice(5), text: h.name, meta: h.global ? '' : 'regional', dim: h.date < today })) }, sources: [{ title: 'Nager.Date public holiday API', url: `https://date.nager.at/PublicHoliday/Country/${code}/${y}` }] };
  }
};

export default [weather, air, sun, quakes, where, distance, holidays];
