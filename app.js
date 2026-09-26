(function () {
  "use strict";

  const SESSION_KEY = "japan-itinerary-auth-v1";
  const authGate = document.getElementById("authGate");
  const authForm = document.getElementById("authForm");
  const authStatus = document.getElementById("authStatus");
  const passwordInput = document.getElementById("passwordInput");
  const passwordToggle = document.getElementById("passwordToggle");
  const unlockButton = document.getElementById("unlockButton");
  const siteShell = document.getElementById("siteShell");
  const app = document.getElementById("app");
  const tabs = document.getElementById("dateTabs");
  const dateScrollbar = document.getElementById("dateScrollbar");
  const calendarButton = document.getElementById("calendarButton");
  const calendarPanel = document.getElementById("calendarPanel");
  const template = document.getElementById("dayTemplate");
  const readingButton = document.getElementById("readingButton");
  const lockButton = document.getElementById("lockButton");
  let config;
  let days = [];
  let activeId = "";
  let readingMode = false;
  let allDetailsCollapsed = false;
  let calendarMonth = "";
  let sliderTarget = 0;
  let sliderAnimation = 0;
  let sliderDriving = false;

  const bytesToBase64 = (bytes) => {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  };

  const base64ToBytes = (value) => {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));

  async function deriveKey(password, scope) {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const salt = base64ToBytes(scope === "full" ? config.kdf.fullSalt : config.kdf.tokyoSalt);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: config.kdf.hash, salt, iterations: config.kdf.iterations }, material, 256);
    return new Uint8Array(bits);
  }

  async function decryptScope(scope, rawKey) {
    const response = await fetch(`vault/${scope}.json`, { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取加密行程。");
    const envelope = await response.json();
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv), tagLength: 128 }, key, base64ToBytes(envelope.ciphertext));
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    if (payload.schema !== 2 || payload.scope !== scope || !Array.isArray(payload.days)) throw new Error("行程数据格式不正确。");
    return payload;
  }

  function loadSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!session || session.expiresAt <= Date.now() || !["tokyo", "full"].includes(session.scope)) return null;
      const expectedSalt = session.scope === "full" ? config.kdf.fullSalt : config.kdf.tokyoSalt;
      if (session.salt !== expectedSalt) return null;
      return session;
    } catch { return null; }
  }

  function saveSession(scope, rawKey) {
    const salt = scope === "full" ? config.kdf.fullSalt : config.kdf.tokyoSalt;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ scope, key: bytesToBase64(rawKey), salt, expiresAt: Date.now() + config.sessionDays * 86_400_000 }));
  }

  async function unlockWithPassword(password) {
    for (const scope of ["full", "tokyo"]) {
      try {
        const key = await deriveKey(password, scope);
        const payload = await decryptScope(scope, key);
        saveSession(scope, key);
        return payload;
      } catch {}
    }
    throw new Error("密码不正确，请重新输入。");
  }

  async function restoreSession() {
    const session = loadSession();
    if (!session) return false;
    try {
      showSite(await decryptScope(session.scope, base64ToBytes(session.key)));
      return true;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      return false;
    }
  }

  function showSite(payload) {
    days = payload.days;
    activeId = days.some((day) => day.id === location.hash.slice(1)) ? location.hash.slice(1) : days[0]?.id;
    calendarMonth = activeId?.slice(0, 7) || "";
    authGate.hidden = true;
    siteShell.hidden = false;
    lockButton.hidden = config.passwordEnabled === false;
    render();
    requestAnimationFrame(() => tabs.querySelector(`[data-day="${activeId}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" }));
  }

  function showLogin(message = "") {
    siteShell.hidden = true;
    authGate.hidden = false;
    authStatus.textContent = message;
    unlockButton.disabled = false;
    passwordInput.value = "";
    passwordInput.focus();
  }

  function timelineTimeMarkup(time) {
    const range = /^((?:预计|目标|约)?\d{1,2}:\d{2})(–(?:约)?\d{1,2}:\d{2}(?:左右|以后)?|或\d{1,2}:\d{2})$/.exec(time);
    const content = range
      ? `<span class="timeline-time-line">${escapeHtml(range[1])}</span><span class="timeline-time-line">${escapeHtml(range[2])}</span>`
      : escapeHtml(time);
    return `<span class="timeline-time">${content}</span>`;
  }

  function timelineMarkup(entries, openCount = 0, extras = {}, prefix = "event", startIndex = 0) {
    return entries.map((entry, localIndex) => {
      const index = localIndex + startIndex;
      const extra = extras[index] || {};
      let bodyHtml = entry.bodyHtml;
      if (extra.image?.dataUrl) {
        const picture = `<figure class="route-map"><img src="${escapeHtml(extra.image.dataUrl)}" alt="${escapeHtml(extra.image.alt)}" loading="lazy"><figcaption>${escapeHtml(extra.image.note)}</figcaption></figure>`;
        let paragraph = 0;
        bodyHtml = bodyHtml.replace(/<\/p>/g, ending => ending + (paragraph++ === extra.image.afterParagraph ? picture : ""));
      }
      const alerts = (extra.alerts || []).map((item) => {
        const heading = item.bodyHtml.includes(`<strong>${escapeHtml(item.title)}：</strong>`) ? "" : `<strong>${escapeHtml(item.title)}</strong>`;
        return `<aside class="event-alert trace-target" id="${escapeHtml(item.id)}">${heading}<div>${item.bodyHtml}</div></aside>`;
      }).join("");
      const references = (extra.references || []).length ? `<p class="event-references">相关资料：${extra.references.map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`).join("")}</p>` : "";
      const branch = prefix.startsWith("branch-");
      const longMobileTime = !branch && entry.time.length > 18;
      const outsideTime = branch ? "" : timelineTimeMarkup(entry.time);
      const insideTime = branch
        ? `<span class="time-label">${escapeHtml(entry.time)}</span>`
        : longMobileTime ? `<span class="time-label mobile-inline-time">${escapeHtml(entry.time)}</span>` : "";
      return `<div class="timeline-item trace-target${longMobileTime ? " long-mobile-time" : ""}" id="${prefix}-${index}">${outsideTime}<span class="timeline-dot" aria-hidden="true"></span><details class="timeline-card" ${readingMode || (!allDetailsCollapsed && index < openCount) ? "open" : ""}><summary aria-label="${escapeHtml(entry.time)} ${escapeHtml(entry.title)}">${insideTime}<span class="event-title">${escapeHtml(entry.title)}</span></summary><div class="event-body md-content">${bodyHtml}${alerts}${references}</div></details></div>`;
    }).join("");
  }

  function syncDateScrollbar() {
    const maximum = tabs.scrollWidth - tabs.clientWidth;
    dateScrollbar.disabled = maximum <= 0;
    if (!sliderDriving) dateScrollbar.value = maximum > 0 ? String(Math.round(tabs.scrollLeft / maximum * 1000)) : "0";
  }

  function stopSliderAnimation() {
    if (sliderAnimation) cancelAnimationFrame(sliderAnimation);
    sliderAnimation = 0;
    sliderDriving = false;
  }

  function animateSliderScroll() {
    const difference = sliderTarget - tabs.scrollLeft;
    if (Math.abs(difference) < 0.75) {
      tabs.scrollLeft = sliderTarget;
      sliderAnimation = 0;
      sliderDriving = false;
      syncDateScrollbar();
      return;
    }
    tabs.scrollLeft += difference * 0.3;
    sliderAnimation = requestAnimationFrame(animateSliderScroll);
  }

  function renderCalendar() {
    if (calendarPanel.hidden || !calendarMonth) return;
    const months = [...new Set(days.map((day) => day.id.slice(0, 7)))];
    const monthIndex = months.indexOf(calendarMonth);
    const [year, month] = calendarMonth.split("-").map(Number);
    const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
    const totalDays = new Date(year, month, 0).getDate();
    const enabled = new Set(days.map((day) => day.id));
    const cells = Array.from({ length: firstWeekday }, () => `<span class="calendar-empty" aria-hidden="true"></span>`);
    for (let day = 1; day <= totalDays; day++) {
      const id = `${calendarMonth}-${String(day).padStart(2, "0")}`;
      cells.push(`<button class="calendar-day" type="button" data-calendar-day="${id}" ${enabled.has(id) ? "" : "disabled"} ${id === activeId ? 'aria-current="date"' : ""} aria-label="${year}年${month}月${day}日">${day}</button>`);
    }
    calendarPanel.innerHTML = `<div class="calendar-head"><button type="button" data-month-step="-1" aria-label="上个月" ${monthIndex <= 0 ? "disabled" : ""}>‹</button><strong>${year} 年 ${month} 月</strong><button type="button" data-month-step="1" aria-label="下个月" ${monthIndex >= months.length - 1 ? "disabled" : ""}>›</button></div><div class="calendar-grid">${["一", "二", "三", "四", "五", "六", "日"].map((name) => `<span class="calendar-weekday">${name}</span>`).join("")}${cells.join("")}</div>`;
  }

  function setCalendarOpen(open) {
    calendarPanel.hidden = !open;
    calendarButton.setAttribute("aria-expanded", String(open));
    calendarButton.setAttribute("aria-label", open ? "关闭月视图" : "打开月视图");
    if (open) { calendarMonth = activeId.slice(0, 7); renderCalendar(); }
  }

  function createTabs() {
    tabs.innerHTML = days.map((day) => `<button class="date-tab" type="button" role="tab" aria-selected="${day.id === activeId}" data-day="${escapeHtml(day.id)}"><span class="tab-top"><span>${escapeHtml(day.tabDate)} ${escapeHtml(day.weekday)}</span><span>${escapeHtml(day.icon)}</span></span><span class="tab-title">${escapeHtml(day.shortTitle)} · <span class="tab-weather">${escapeHtml(day.weather)}</span></span></button>`).join("");
    tabs.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => selectDay(button.dataset.day)));
    requestAnimationFrame(syncDateScrollbar);
  }

  function selectDay(id) {
    stopSliderAnimation();
    activeId = id;
    history.replaceState(null, "", `#${id}`);
    render();
    tabs.querySelector(`[data-day="${id}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" });
    calendarMonth = id.slice(0, 7);
    renderCalendar();
    app.focus({ preventScroll: true });
  }

  function renderChecklist(day, container, progress) {
    const key = `japan-checklist:${day.id}`;
    const checked = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    container.innerHTML = day.checklist.map((item, index) => {
      const task = typeof item === "string" ? item : item.task;
      const reminder = typeof item === "string" ? "" : `<small class="check-reminder">${escapeHtml(item.reminder)}</small>`;
      const references = typeof item === "string" ? "" : (item.references || []).map((reference) => `<a href="${escapeHtml(reference.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(reference.label)}</a>`).join(" · ");
      return `<label class="check-item trace-target" id="checklist-${index}"><input type="checkbox" data-index="${index}" ${checked.has(index) ? "checked" : ""}><span class="check-text"><span class="check-task">${escapeHtml(task)}</span>${reminder}${references ? `<small class="check-reminder">${references}</small>` : ""}</span></label>`;
    }).join("");
    const update = () => {
      const selected = [...container.querySelectorAll("input:checked")].map((input) => Number(input.dataset.index));
      localStorage.setItem(key, JSON.stringify(selected));
      progress.textContent = `${selected.length} / ${day.checklist.length}`;
    };
    container.addEventListener("change", update); update();
  }

  function linkPlaceNames(root, places) {
    if (!places?.length) return;
    const terms = places.flatMap((place) => place.terms.map((term) => ({ term, place })))
      .sort((left, right) => right.term.length - left.term.length);
    const escaped = terms.map(({ term }) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const matcher = new RegExp(escaped.join("|"), "g");
    const byTerm = new Map(terms.map(({ term, place }) => [term, place]));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("a, button, code, .trace-link-group")) continue;
      matcher.lastIndex = 0;
      if (matcher.test(node.nodeValue)) nodes.push(node);
    }
    for (const node of nodes) {
      matcher.lastIndex = 0;
      const source = node.nodeValue;
      const replacement = document.createDocumentFragment();
      let cursor = 0;
      for (const match of source.matchAll(matcher)) {
        if (match.index > cursor) replacement.append(source.slice(cursor, match.index));
        const place = byTerm.get(match[0]);
        const link = document.createElement("a");
        link.className = "map-place-link";
        link.href = place.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = `在 Google 地图查看${place.label}`;
        link.setAttribute("aria-label", `${match[0]}，在 Google 地图查看`);
        link.textContent = match[0];
        replacement.append(link);
        cursor = match.index + match[0].length;
      }
      replacement.append(source.slice(cursor));
      node.replaceWith(replacement);
    }
  }

  function renderDecision(day, config = day.decision) {
    if (!config) return "";
    const stateKey = `japan-weather:${day.id}${config.id ? ":" + config.id : ""}`;
    const selected = localStorage.getItem(stateKey) || config.options[0].id;
    const option = config.options.find((item) => item.id === selected) || config.options[0];
    const buttons = config.options.map((item) => `<button class="weather-option" type="button" data-weather="${escapeHtml(item.id)}" aria-pressed="${item.id === option.id}"><span>${escapeHtml(item.icon)}</span>${escapeHtml(item.label)}</button>`).join("");
    const branch = option.timeline.length ? timelineMarkup(option.timeline, 1, {}, `branch-${option.id}`) : `<div class="source-content md-content">${option.bodyHtml}</div>`;
    const references = option.references?.length ? `<p class="event-references">相关资料：${option.references.map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`).join("")}</p>` : "";
    return `<div class="timeline-item decision-row trace-target" id="${config.id || "weather-decision"}">${timelineTimeMarkup(config.time)}<span class="timeline-dot" aria-hidden="true"></span><section class="decision-item" data-decision="${escapeHtml(stateKey)}"><div class="decision-header"><span class="decision-kind">天气决策点</span><h4>${escapeHtml(config.title)}</h4></div><div class="weather-switch" role="group" aria-label="选择天气方案">${buttons}</div><p class="decision-note">${escapeHtml(option.note)}</p><div class="branch-plan trace-target" id="decision-${escapeHtml(option.id)}">${branch}${references}</div></section></div>`;
  }

  const traceLabels = {
    "day-overview": "顶部说明", "timelineTitle": "当日时间线", "checklistTitle": "今日总清单",
    "event-0": "航班抵达", "event-1": "京急乘车", "event-2": "品川换乘", "event-3": "品川至三岛",
    "event-4": "酒店入住", "event-5": "出门决策", "event-6": "南口散步", "event-7": "晚饭", "event-8": "返回酒店",
    "hotel-early": "提前抵达提醒", "hotel-after-1730": "入住延误提醒", "hotel-after-19": "晚到提醒",
    "hotel-bad-weather": "天气与身体状况提醒", "rail-disruption": "铁路中断提醒", "flight-hotel-delay": "航班延误提醒",
    "mishima-camera": "实时画面提醒", "mishima-passage": "出门前确认",
    "checklist-0": "清单·航班", "checklist-1": "清单·入境资料", "checklist-2": "清单·酒店",
    "checklist-3": "清单·接驳车", "checklist-4": "清单·新干线", "checklist-5": "清单·天气", "checklist-6": "清单·穿站"
  };

  function tracePlaceLabel(day, target) {
    if (target === "weather-decision") return "天气决策点";
    if (target.startsWith("decision-")) return `方案·${[...(day.decision?.options || []), ...(day.morningDecision?.options || [])].find((option) => `decision-${option.id}` === target)?.label || "天气路线"}`;
    const branch = /^branch-([^-]+)-(\d+)$/.exec(target);
    if (branch) return [...(day.decision?.options || []), ...(day.morningDecision?.options || [])].find((option) => option.id === branch[1])?.timeline[Number(branch[2])]?.title || "天气路线";
    const event = /^event-(\d+)$/.exec(target);
    if (event && day.id !== "2026-11-17") {
      const title = day.timeline[Number(event[1])]?.title || "时间线";
      return title.length > 12 ? `${title.slice(0, 12)}…` : title;
    }
    const checklist = /^checklist-(\d+)$/.exec(target);
    if (checklist && day.id !== "2026-11-17") {
      const item = day.checklist[Number(checklist[1])];
      const task = typeof item === "string" ? item : item?.task || "清单项目";
      return `清单·${task.length > 9 ? `${task.slice(0, 9)}…` : task}`;
    }
    if (traceLabels[target]) return traceLabels[target];
    for (const extra of Object.values(day.timelineExtras || {})) {
      const alert = (extra.alerts || []).find((item) => item.id === target);
      if (alert) return alert.title;
    }
    return target.startsWith("checklist-") ? "清单项目" : "具体位置";
  }

  function traceLocation(day, target) {
    if (target === "day-overview") return { time: "当日概览", timeTarget: target };
    if (target === "weather-decision") return { time: day.decision?.time || "当天", timeTarget: target };
    if (target.startsWith("decision-")) return { time: day.decision?.time || "当天", timeTarget: "weather-decision" };
    const branch = /^branch-([^-]+)-(\d+)$/.exec(target);
    if (branch) return { time: [...(day.decision?.options || []), ...(day.morningDecision?.options || [])].find((option) => option.id === branch[1])?.timeline[Number(branch[2])]?.time || "当天", timeTarget: target };
    if (target === "checklistTitle" || target.startsWith("checklist-")) return { time: "出发前与当天", timeTarget: "checklistTitle" };
    if (target === "timelineTitle") return { time: "当天", timeTarget: target };
    const event = /^event-(\d+)$/.exec(target);
    if (event) return { time: day.timeline[Number(event[1])]?.time || "当天", timeTarget: target };
    for (const [index, extra] of Object.entries(day.timelineExtras || {})) {
      const alert = (extra.alerts || []).find((item) => item.id === target);
      if (alert) {
        const conditionalTime = /^约\d/.test(alert.title) ? alert.title : ({ "flight-hotel-delay": "航班延误时", "hotel-bad-weather": "抵达酒店时", "rail-disruption": "铁路晚点时" }[target]);
        return { time: conditionalTime || day.timeline[Number(index)]?.time || "当天", timeTarget: `event-${index}` };
      }
    }
    return { time: "当天", timeTarget: target };
  }

  function traceMarker(targets, day, sentence) {
    const marker = document.createElement("span");
    marker.className = "trace-link-group";
    const list = Array.isArray(targets) ? targets : [targets];
    list.forEach((target) => {
      const location = traceLocation(day, target);
      for (const [label, destination, mode] of [[location.time, location.timeTarget, "time"], [tracePlaceLabel(day, target), target, "place"]]) {
        const link = document.createElement("a");
        link.className = `trace-chip trace-chip-${mode}`;
        link.href = `#${day.id}`;
        link.dataset.jumpTarget = destination;
        link.dataset.jumpMode = mode;
        link.dataset.sourceSentence = sentence.trim();
        link.textContent = label;
        marker.append(link);
      }
    });
    return marker;
  }

  function addBlockLinks(element, targets, day) {
    // Each source block has an editorially reviewed destination. Keep its text intact;
    // a block that is used in several places gets one paired marker per destination.
    element.append(traceMarker(targets, day, element.textContent || ""));
  }

  function tracedSourceHtml(day) {
    if (!day.traceTargets) return day.fullHtml;
    const holder = document.createElement("div");
    holder.innerHTML = day.fullHtml;
    const blocks = holder.querySelectorAll("h2, h3, p, li, blockquote");
    if (blocks.length !== day.traceTargets.length) throw new Error(`原文映射数量不一致：${day.id}`);
    blocks.forEach((element, index) => {
      if (!element.matches("h2, h3")) addBlockLinks(element, day.traceTargets[index], day);
    });
    return holder.innerHTML;
  }

  function renderSources(day) {
    const routeMap = day.routeImage ? `<details class="source-accordion" ${readingMode ? "open" : ""}><summary>${escapeHtml(day.routeImage.title)}</summary><div class="source-content route-map"><img src="${day.routeImage.dataUrl}" alt="${escapeHtml(day.routeImage.alt)}" loading="lazy"><p>${escapeHtml(day.routeImage.note)}</p></div></details>` : "";
    return routeMap + `<details class="source-accordion" ${readingMode ? "open" : ""}><summary>完整计划与资料${day.traceTargets ? " · 已逐段对应" : ""}</summary><div class="source-content md-content">${tracedSourceHtml(day)}</div></details>`;
  }

  function bindDecision(day) {
    app.querySelectorAll("[data-decision]").forEach(decision => {
      decision.querySelectorAll("[data-weather]").forEach(button => button.addEventListener("click", () => {
        localStorage.setItem(decision.dataset.decision, button.dataset.weather);
        render();
      }));
    });
  }

  function render() {
    const day = days.find((item) => item.id === activeId) || days[0];
    if (!day) { app.innerHTML = "<p>暂无行程数据。</p>"; return; }
    activeId = day.id; createTabs();
    const fragment = template.content.cloneNode(true);
    fragment.querySelector(".day-kicker").textContent = `${day.tabDate} · ${day.weekday}`;
    fragment.querySelector(".day-title").textContent = day.title;
    fragment.querySelector(".context-chips").innerHTML = day.context.map((item) => `<span class="context-chip">${escapeHtml(item)}</span>`).join("");
    fragment.querySelector(".boundary").textContent = day.boundary;
    if (day.overviewHtml) fragment.querySelector(".boundary").insertAdjacentHTML("afterend", `<div class="overview-copy md-content trace-target" id="day-overview">${day.overviewHtml}</div>`);
    else fragment.querySelector(".day-hero").id = "day-overview";
    if (Number.isInteger(day.decisionAfterIndex)) {
      const split = day.decisionAfterIndex + 1;
      const selected = localStorage.getItem(`japan-weather:${day.id}`) || day.decision.options[0].id;
      const safeToContinue = !day.decision.skipSharedFor?.includes(selected);
      fragment.querySelector(".timeline").innerHTML = timelineMarkup(day.timeline.slice(0, split), day.defaultOpenCount, day.timelineExtras)
        + renderDecision(day)
        + (safeToContinue ? timelineMarkup(day.timeline.slice(split), day.defaultOpenCount, day.timelineExtras, "event", split) : "");
    } else {
      fragment.querySelector(".timeline").innerHTML = timelineMarkup(day.timeline, day.defaultOpenCount, day.timelineExtras) + renderDecision(day);
    }
    if (day.morningDecision) fragment.querySelector("#event-0").insertAdjacentHTML("afterend", renderDecision(day, day.morningDecision));
    fragment.querySelector(".source-accordions").innerHTML = renderSources(day);
    app.replaceChildren(fragment);
    renderChecklist(day, app.querySelector(".checklist"), app.querySelector(".check-progress"));
    linkPlaceNames(app, day.mapPlaces);
    bindDecision(day);
    readingButton.setAttribute("aria-pressed", String(readingMode));
    readingButton.innerHTML = readingMode ? '<span aria-hidden="true">−</span> 收起详情' : '<span aria-hidden="true">☰</span> 展开全文';
    document.title = `${day.tabDate} ${day.shortTitle}｜日本旅行计划`;
  }

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    unlockButton.disabled = true; authStatus.textContent = "正在验证…";
    try { showSite(await unlockWithPassword(passwordInput.value)); passwordInput.value = ""; }
    catch (error) { authStatus.textContent = error.message; unlockButton.disabled = false; passwordInput.select(); }
  });
  passwordToggle.addEventListener("click", () => {
    const showing = passwordInput.type === "text";
    passwordInput.type = showing ? "password" : "text";
    passwordToggle.textContent = showing ? "显示" : "隐藏";
    passwordToggle.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
  });
  readingButton.addEventListener("click", () => {
    allDetailsCollapsed = readingMode;
    readingMode = !readingMode;
    render();
  });
  calendarButton.addEventListener("click", () => setCalendarOpen(calendarPanel.hidden));
  calendarPanel.addEventListener("click", (event) => {
    const monthControl = event.target.closest("[data-month-step]");
    if (monthControl && !monthControl.disabled) {
      const months = [...new Set(days.map((day) => day.id.slice(0, 7)))];
      calendarMonth = months[months.indexOf(calendarMonth) + Number(monthControl.dataset.monthStep)];
      renderCalendar();
      return;
    }
    const date = event.target.closest("[data-calendar-day]");
    if (date && !date.disabled) { selectDay(date.dataset.calendarDay); setCalendarOpen(false); }
  });
  dateScrollbar.addEventListener("input", () => {
    sliderTarget = (tabs.scrollWidth - tabs.clientWidth) * Number(dateScrollbar.value) / 1000;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stopSliderAnimation();
      tabs.scrollLeft = sliderTarget;
      syncDateScrollbar();
      return;
    }
    sliderDriving = true;
    if (!sliderAnimation) sliderAnimation = requestAnimationFrame(animateSliderScroll);
  });
  tabs.addEventListener("scroll", syncDateScrollbar, { passive: true });
  window.addEventListener("resize", syncDateScrollbar);
  app.addEventListener("click", (event) => {
    const link = event.target.closest("[data-jump-target]");
    if (!link) return;
    event.preventDefault();
    const day = days.find((item) => item.id === activeId);
    const option = /^decision-(.+)$/.exec(link.dataset.jumpTarget);
    const branch = /^branch-([^-]+)-\d+$/.exec(link.dataset.jumpTarget);
    const requestedOption = branch?.[1] || (option && link.dataset.jumpMode === "place" ? option[1] : null);
    if (requestedOption && day?.decision) {
      const morning = day.morningDecision?.options.some(item => item.id === requestedOption);
      localStorage.setItem(`japan-weather:${activeId}${morning ? ":" + day.morningDecision.id : ""}`, requestedOption);
      render();
    }
    let target = document.getElementById(link.dataset.jumpTarget);
    if (!target && day?.decision?.skipSharedFor?.includes(localStorage.getItem(`japan-weather:${activeId}`))) {
      localStorage.setItem(`japan-weather:${activeId}`, day.decision.options[0].id);
      render();
      target = document.getElementById(link.dataset.jumpTarget);
    }
    if (!target) return;
    const details = target.id === "weather-decision" ? null : target.matches("details") ? target : target.closest("details") || target.querySelector("details");
    if (details) details.open = true;
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const sentence = normalize(link.dataset.sourceSentence || "");
    const exact = link.dataset.jumpMode === "place" && sentence && [...target.querySelectorAll("p, li, small, .check-text, a")].find((element) => normalize(element.textContent || "").includes(sentence));
    const timeDestination = link.dataset.jumpMode === "time" ? target.querySelector(".timeline-time") || details?.querySelector("summary") : null;
    const destination = exact || timeDestination || target;
    destination.scrollIntoView({ block: "center", behavior: "smooth" });
    destination.classList.remove("trace-flash");
    void destination.offsetWidth;
    destination.classList.add("trace-flash");
  });
  lockButton.addEventListener("click", () => { localStorage.removeItem(SESSION_KEY); days = []; history.replaceState(null, "", location.pathname); document.title = "日本旅行计划"; showLogin(); });
  window.addEventListener("hashchange", () => { const requested = location.hash.slice(1); if (days.some((day) => day.id === requested)) { activeId = requested; calendarMonth = requested.slice(0, 7); render(); renderCalendar(); } });

  (async function bootstrap() {
    try {
      const response = await fetch("config.json", { cache: "no-store" });
      if (!response.ok) throw new Error();
      config = await response.json();
      if (config.passwordEnabled === false) {
        const dataResponse = await fetch(config.dataUrl, { cache: "no-store" });
        if (!dataResponse.ok) throw new Error();
        const payload = await dataResponse.json();
        if (payload.schema !== 2 || !Array.isArray(payload.days)) throw new Error();
        showSite(payload);
      } else if (!(await restoreSession())) showLogin();
    } catch { showLogin("网站配置暂时无法读取，请稍后重试。"); }
  })();
})();
