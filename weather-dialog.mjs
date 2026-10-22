import { weatherContext, weatherDescription, weatherPresentation } from './weather.mjs?v=20261020-details';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const measure = (value, unit, digits = 0) => Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '暂无数据';
const fetchedTime = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);

export function createWeatherDialog({ client, debugStartDate, onWeather, now = () => new Date(), clockLabel = () => '' }) {
  const dialog = document.getElementById('weatherDialog');
  const locations = document.getElementById('weatherLocations');
  const detail = document.getElementById('weatherDetail');
  const refreshButton = document.getElementById('weatherRefresh');
  const fetched = document.getElementById('weatherFetched');
  let day;
  let selectedId;
  let opener;
  let generation = 0;
  let hourlyOpen = false;
  let busy = false;

  function context() {
    return { ...weatherContext(day, debugStartDate(), now()), location: day.weatherPlan.locations.find(p => p.id === selectedId) };
  }

  function renderLocations() {
    locations.innerHTML = day.weatherPlan.locations.map(point => `<button type="button" role="tab" id="weather-location-${escape(point.id)}" data-location="${escape(point.id)}" aria-selected="${point.id === selectedId}" tabindex="${point.id === selectedId ? '0' : '-1'}" aria-controls="weatherDetail">${escape(point.label)}</button>`).join('');
    detail.setAttribute('aria-labelledby', `weather-location-${selectedId}`);
  }

  function render(state) {
    const ctx = context();
    const data = state.data;
    const view = weatherPresentation(ctx, state);
    const debug = debugStartDate();
    const scrollTop = detail.scrollTop;
    const hadFocus = detail.contains(document.activeElement);
    const focusWasHourly = document.activeElement?.matches('.weather-hourly summary');
    const dateLabel = debug ? `调试：行程 ${day.tabDate} → 天气 ${ctx.date}` : `${ctx.date} · ${ctx.historical ? '近期历史天气' : '天气预报'}`;
    let body = `<p class="weather-query-date">${escape(dateLabel)}${debug && ctx.historical ? ' · 近期历史天气' : ''}</p>`;
    if (state.simulation) body += `<p class="weather-simulation-label">${escape(state.simulation)} · 模拟数据，不代表实际天气</p>`;
    if (clockLabel()) body += `<p class="weather-simulation-label">${escape(clockLabel())}</p>`;
    if (data) {
      body += `<section class="weather-summary"><span class="weather-big-icon" aria-hidden="true">${view.icon}</span><div><h3>${escape(ctx.location.label)}</h3><p>${escape(weatherDescription(data.code).label)} <strong>${measure(data.min, '°', 0)}–${measure(data.max, '°C', 0)}</strong></p><small>全天最低–最高温</small></div></section>`;
      const metrics = [
        ['最高降雨概率', measure(data.probability, '%')], ['全天降水量', measure(data.precipitation, ' mm', 1)],
        ['最大风速', measure(data.wind, ' km/h')], ['最大阵风', measure(data.gust, ' km/h')],
        ['日出', data.sunrise || '暂无数据'], ['日落', data.sunset || '暂无数据']
      ];
      body += `<dl class="weather-metrics">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;
      const fuji = ctx.location.fujiView;
      const rows = (data.hourly || []).map(hour => {
        const condition = hour.code === null ? { icon: '❓', label: '暂无数据' } : weatherDescription(hour.code);
        return `<tr><th scope="row">${hour.time}</th><td><span aria-hidden="true">${condition.icon}</span> ${escape(condition.label)}</td><td>${measure(hour.temperature, '°C')}</td><td>${measure(hour.probability, '%')}</td><td>${measure(hour.precipitation, ' mm', 1)}</td><td>${measure(hour.wind, ' km/h')}</td>${fuji ? `<td>${measure(hour.cloud, '%')}</td><td>${measure(hour.visibility === null ? null : hour.visibility / 1000, ' km', 1)}</td>` : ''}</tr>`;
      }).join('');
      body += `<details class="weather-hourly" ${hourlyOpen ? 'open' : ''}><summary>逐小时详情 <span>06:00–20:00</span></summary><p class="weather-hourly-hint">日本当地时间 · 可左右滑动查看${fuji ? '；云量与能见度仅供参考，不能保证看见富士山。' : ''}</p>${rows ? `<div class="weather-hourly-scroll" tabindex="0" role="region" aria-label="逐小时天气表，可左右滑动"><table><thead><tr><th scope="col">时间</th><th scope="col">天气</th><th scope="col">气温</th><th scope="col">降雨概率</th><th scope="col">降水量</th><th scope="col">风速</th>${fuji ? '<th scope="col">云量</th><th scope="col">能见度</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p>暂无逐小时数据。</p>'}</details>`;
    } else {
      const message = state.status === 'future' ? '尚未进入预报期，临近日期后自动显示。' : state.status === 'past' ? '该日期已超出近期历史天气范围。' : busy ? '正在获取天气…' : '暂时无法获取天气，请稍后刷新重试。';
      body += `<section class="weather-empty"><span aria-hidden="true">☀️❓</span><h3>${escape(ctx.location.label)}</h3><p>${message}</p></section>`;
    }
    body += `<p class="weather-plan-note">${escape(ctx.scheduled ? '默认地点按计划时段选择；手动切换后保持你的选择。' : '默认显示当天主要活动地点。')} ${escape(day.weatherPlan.note || '')}</p>`;
    detail.innerHTML = body;
    const hours = detail.querySelector('details');
    hours?.addEventListener('toggle', () => { if (hours.isConnected) hourlyOpen = hours.open; });
    detail.scrollTop = scrollTop;
    if (hadFocus) (focusWasHourly ? detail.querySelector('summary') : detail)?.focus({ preventScroll: true });
    refreshButton.disabled = busy || ctx.range !== 'available' || ['future', 'past'].includes(state.status);
    refreshButton.textContent = busy ? '刷新中…' : '刷新天气';
    const status = state.status === 'stale' ? (state.failed ? '刷新失败，保留上次数据。' : '显示上次数据，正在检查更新。') : !data && state.status === 'unavailable' ? '获取失败。' : '';
    fetched.textContent = `${status}${state.fetchedAt ? `${state.simulation ? '模拟数据时间' : '获取于日本时间'} ${fetchedTime(state.fetchedAt)}` : ''}`;
    const source = dialog.querySelector('.weather-dialog-footer a');
    source.textContent = state.simulation ? '模拟数据（本地生成）' : '天气来源 Open-Meteo';
    if (state.simulation) source.removeAttribute('href');
    else source.href = 'https://open-meteo.com/';
    detail.setAttribute('aria-busy', String(busy));
  }

  async function refresh(force = false) {
    if (!dialog.open || !day) return;
    const token = ++generation;
    const currentDay = day;
    const ctx = context();
    busy = ctx.range === 'available';
    render(client.snapshot(ctx));
    const state = await client.request(ctx, { force });
    if (token !== generation || !dialog.open) return;
    busy = false;
    render(state);
    onWeather(currentDay, ctx, state);
  }

  async function selectLocation(id, focus = false) {
    selectedId = id;
    hourlyOpen = detail.querySelector('details')?.open || false;
    detail.scrollTop = 0;
    renderLocations();
    if (focus) locations.querySelector('[aria-selected="true"]').focus({ preventScroll: true });
    await refresh();
  }
  locations.addEventListener('click', event => {
    const button = event.target.closest('[data-location]');
    if (button) selectLocation(button.dataset.location, true);
  });
  locations.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const points = day.weatherPlan.locations;
    const index = points.findIndex(p => p.id === selectedId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + points.length) % points.length;
    selectLocation(points[next].id, true);
    locations.querySelector('[aria-selected="true"]').scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  refreshButton.addEventListener('click', () => refresh(true));
  document.getElementById('weatherClose').addEventListener('click', () => dialog.close());
  let backdropDown = false;
  const outside = event => { const rect = dialog.getBoundingClientRect(); return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom; };
  dialog.addEventListener('pointerdown', event => { backdropDown = event.target === dialog && outside(event); });
  dialog.addEventListener('click', event => { if (backdropDown && event.target === dialog && outside(event)) dialog.close(); backdropDown = false; });
  dialog.addEventListener('close', () => {
    generation++;
    document.body.classList.remove('weather-viewing');
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
  return {
    open(selectedDay, button) {
      day = selectedDay;
      selectedId = weatherContext(day, debugStartDate(), now()).location.id;
      opener = button;
      hourlyOpen = false;
      document.getElementById('weatherDialogTitle').textContent = `${day.tabDate} · 天气详情`;
      renderLocations();
      detail.scrollTop = 0;
      dialog.showModal();
      locations.querySelector('[aria-selected="true"]').scrollIntoView({ block: 'nearest', inline: 'nearest' });
      document.body.classList.add('weather-viewing');
      refresh();
    },
    refresh() { if (!busy) refresh(); },
    invalidate() { generation++; busy = false; },
    close() { if (dialog.open) dialog.close(); }
  };
}
