// Weather display only: no itinerary decisions or geolocation permissions.
export const CACHE_TTL = 30 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const DAY_MS = 86400000;
const jpFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export function japanClock(now = new Date()) {
  const parts = Object.fromEntries(jpFormatter.formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function queryDate(dayId, debugStartDate, itineraryStartDate) {
  if (!debugStartDate) return dayId;
  const offset = (Date.parse(`${dayId}T00:00:00Z`) - Date.parse(`${itineraryStartDate}T00:00:00Z`)) / DAY_MS;
  return new Date(Date.parse(`${debugStartDate}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

export function weatherContext(day, debugStartDate, now = new Date()) {
  const date = queryDate(day.id, debugStartDate, day.weatherPlan.itineraryStartDate);
  const clock = japanClock(now);
  const forecastOffset = Math.round((Date.parse(date) - Date.parse(clock.date)) / DAY_MS);
  let locationId = day.weatherPlan.default;
  if (date === clock.date) {
    for (const [time, id] of day.weatherPlan.schedule) {
      if (time <= clock.time) locationId = id;
    }
  }
  return {
    date, location: day.weatherPlan.locations.find(p => p.id === locationId),
    historical: forecastOffset < 0,
    range: forecastOffset > 15 ? 'future' : forecastOffset < -92 ? 'past' : 'available',
    scheduled: date === clock.date
  };
}

export function weatherDescription(code) {
  if (code === 0) return { icon: '☀️', label: '晴' };
  if (code === 1 || code === 2) return { icon: '🌤️', label: code === 1 ? '大致晴朗' : '晴间多云' };
  if (code === 3) return { icon: '☁️', label: '阴天' };
  if ([45, 48].includes(code)) return { icon: '🌫️', label: '有雾' };
  if ([51, 53, 55].includes(code)) return { icon: '🌦️', label: '毛毛雨' };
  if ([56, 57, 66, 67].includes(code)) return { icon: '🌧️', label: '冻雨' };
  if ([61, 63, 65].includes(code)) return { icon: '🌧️', label: '有雨' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: '🌨️', label: '有雪' };
  if ([80, 81, 82].includes(code)) return { icon: '🌦️', label: '阵雨' };
  if ([95, 96, 99].includes(code)) return { icon: '⛈️', label: '雷雨' };
  return { icon: '☀️❓', label: '天气状况未知' };
}

export function parseWeather(payload, date) {
  const daily = payload?.daily;
  const index = daily?.time?.indexOf(date) ?? -1;
  const values = ['weather_code', 'temperature_2m_min', 'temperature_2m_max'].map(k => daily?.[k]?.[index]);
  if (index < 0 || !values.every(Number.isFinite) || values[1] > values[2]) throw new Error('天气数据不完整');
  const number = value => Number.isFinite(value) ? value : null;
  const time = value => typeof value === 'string' && value.startsWith(`${date}T`) && /^\d{2}:\d{2}$/.test(value.slice(11)) ? value.slice(11) : null;
  const hourly = (payload.hourly?.time || []).flatMap((stamp, i) => {
    if (typeof stamp !== 'string' || !stamp.startsWith(`${date}T`) || !/^\d{2}:00$/.test(stamp.slice(11))) return [];
    const hour = Number(stamp.slice(11, 13));
    if (hour < 6 || hour > 20) return [];
    return [{ time: stamp.slice(11), code: number(payload.hourly.weather_code?.[i]),
      temperature: number(payload.hourly.temperature_2m?.[i]),
      probability: number(payload.hourly.precipitation_probability?.[i]),
      precipitation: number(payload.hourly.precipitation?.[i]),
      wind: number(payload.hourly.wind_speed_10m?.[i]),
      cloud: number(payload.hourly.cloud_cover?.[i]), visibility: number(payload.hourly.visibility?.[i]) }];
  });
  return { code: values[0], min: values[1], max: values[2],
    probability: number(daily.precipitation_probability_max?.[index]),
    precipitation: number(daily.precipitation_sum?.[index]),
    wind: number(daily.wind_speed_10m_max?.[index]), gust: number(daily.wind_gusts_10m_max?.[index]),
    sunrise: time(daily.sunrise?.[index]), sunset: time(daily.sunset?.[index]), hourly };
}

function validCachedData(data) {
  const optional = ['probability', 'precipitation', 'wind', 'gust'];
  return data && ['code', 'min', 'max'].every(k => Number.isFinite(data[k])) && data.min <= data.max
    && optional.every(k => data[k] === null || Number.isFinite(data[k]))
    && ['sunrise', 'sunset'].every(k => data[k] === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(data[k]))
    && Array.isArray(data.hourly) && data.hourly.every(row => row && /^([01]\d|2[0-3]):00$/.test(row.time)
      && ['code', 'temperature', 'probability', 'precipitation', 'wind', 'cloud', 'visibility'].every(k => row[k] === null || Number.isFinite(row[k])));
}

export function createWeatherClient({ fetcher = globalThis.fetch, storage, now = Date.now, timeoutMs = 12000 } = {}) {
  const memory = new Map();
  const pending = new Map();
  const retryAt = new Map();
  const keyFor = context => `japan-forecast-v2:${context.location.latitude},${context.location.longitude}:${context.date}`;
  function read(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      const cached = JSON.parse(storage?.getItem(key) || 'null');
      if (cached && Number.isFinite(cached.fetchedAt) && cached.fetchedAt <= now()
          && validCachedData(cached.data)) {
        memory.set(key, cached);
        return cached;
      }
    } catch { /* Storage may be disabled or malformed. */ }
    return null;
  }
  function snapshot(context) {
    if (context.range !== 'available') return { status: context.range };
    const key = keyFor(context);
    const cached = read(key);
    if (cached) return { status: !retryAt.has(key) && now() - cached.fetchedAt < CACHE_TTL ? 'ready' : 'stale', ...cached, failed: retryAt.has(key) };
    return { status: retryAt.has(key) ? 'unavailable' : 'loading' };
  }
  async function request(context, { force = false } = {}) {
    if (context.range !== 'available') return snapshot(context);
    const key = keyFor(context);
    const cached = read(key);
    if (pending.has(key)) return pending.get(key);
    if (!force && cached && !retryAt.has(key) && now() - cached.fetchedAt < CACHE_TTL) return snapshot(context);
    if (!force && (retryAt.get(key) || 0) > now()) return snapshot(context);
    const task = Promise.resolve().then(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast');
        for (const [name, value] of Object.entries({
          latitude: context.location.latitude, longitude: context.location.longitude,
          start_date: context.date, end_date: context.date, timezone: 'Asia/Tokyo',
          daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset',
          hourly: 'weather_code,temperature_2m,precipitation_probability,precipitation,wind_speed_10m,cloud_cover,visibility',
          temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm'
        })) url.searchParams.set(name, value);
        const response = await fetcher(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
        const data = parseWeather(await response.json(), context.date);
        const entry = { data, fetchedAt: now() };
        memory.set(key, entry);
        try { storage?.setItem(key, JSON.stringify(entry)); } catch { /* In-memory caching still works. */ }
        retryAt.delete(key);
      } catch {
        retryAt.set(key, now() + RETRY_DELAY);
      } finally {
        clearTimeout(timeout);
        pending.delete(key);
      }
      return snapshot(context);
    });
    pending.set(key, task);
    return task;
  }
  return { snapshot, request };
}

export function weatherPresentation(context, state) {
  if (state.simulation) {
    const view = weatherPresentation(context, { ...state, simulation: null });
    return { ...view, text: `模拟 · ${view.text}` };
  }
  if (state.status === 'future') return { icon: '☀️❓', text: '尚未进入预报期' };
  if (state.status === 'past') return { icon: '☀️❓', text: '超出近期历史范围' };
  if (!state.data) return { icon: '☀️❓', text: state.status === 'loading' ? '天气加载中…' : '天气暂不可用' };
  const description = weatherDescription(state.data.code);
  const prefix = state.status === 'stale' ? '旧数据 · ' : context.historical ? '历史 · ' : '';
  return { icon: description.icon, text: `${prefix}${description.label} ${Math.round(state.data.min)}–${Math.round(state.data.max)}°C` };
}
