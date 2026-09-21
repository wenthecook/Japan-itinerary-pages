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
  const template = document.getElementById("dayTemplate");
  const readingButton = document.getElementById("readingButton");
  const lockButton = document.getElementById("lockButton");
  let config;
  let days = [];
  let activeId = "";
  let readingMode = false;

  const bytesToBase64 = (bytes) => {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  };

  const base64ToBytes = (value) => {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };

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
    if (payload.schema !== 1 || payload.scope !== scope || !Array.isArray(payload.days)) throw new Error("行程数据格式不正确。");
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
      const payload = await decryptScope(session.scope, base64ToBytes(session.key));
      showSite(payload);
      return true;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      return false;
    }
  }

  function showSite(payload) {
    days = payload.days;
    activeId = days.some((day) => day.id === location.hash.slice(1)) ? location.hash.slice(1) : days[0]?.id;
    authGate.hidden = true;
    siteShell.hidden = false;
    render();
  }

  function showLogin(message = "") {
    siteShell.hidden = true;
    authGate.hidden = false;
    authStatus.textContent = message;
    unlockButton.disabled = false;
    passwordInput.value = "";
    passwordInput.focus();
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  function inlineMarkdown(value) {
    return escapeHtml(value)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function renderMarkdown(markdown) {
    const lines = markdown.trim().split(/\r?\n/);
    let html = "";
    let paragraph = [];
    let listType = null;
    const flushParagraph = () => { if (paragraph.length) html += `<p>${inlineMarkdown(paragraph.join(" "))}</p>`; paragraph = []; };
    const closeList = () => { if (listType) html += `</${listType}>`; listType = null; };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { flushParagraph(); closeList(); continue; }
      const heading = trimmed.match(/^(#{3,4})\s+(.+)$/);
      const unordered = trimmed.match(/^[-*]\s+(.+)$/);
      const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (heading) {
        flushParagraph(); closeList();
        const level = heading[1].length;
        html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      } else if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? "ul" : "ol";
        if (listType !== nextType) { closeList(); listType = nextType; html += `<${listType}>`; }
        html += `<li>${inlineMarkdown((unordered || ordered)[1])}</li>`;
      } else if (quote) {
        flushParagraph(); closeList(); html += `<blockquote>${inlineMarkdown(quote[1])}</blockquote>`;
      } else { closeList(); paragraph.push(trimmed); }
    }
    flushParagraph(); closeList();
    return html;
  }

  function splitSections(markdown) {
    const result = [];
    const lines = markdown.split(/\r?\n/);
    let current = { title: "行程概要", content: [] };
    for (const line of lines) {
      const match = line.match(/^##\s+(.+)$/);
      if (match) {
        if (current.content.join("\n").trim()) result.push({ ...current, content: current.content.join("\n") });
        current = { title: match[1].trim(), content: [] };
      } else if (!line.startsWith("# ")) current.content.push(line);
    }
    if (current.content.join("\n").trim()) result.push({ ...current, content: current.content.join("\n") });
    return result;
  }

  function splitTimeline(markdown) {
    const entries = [];
    const matches = [...markdown.matchAll(/^\*\*([^*]+?)｜([^*]+?)\*\*\s*$/gm)];
    matches.forEach((match, index) => {
      const start = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
      entries.push({ time: match[1].trim(), title: match[2].trim(), body: markdown.slice(start, end).trim() });
    });
    return entries;
  }

  function timelineMarkup(entries, openCount = 0) {
    return entries.map((entry, index) => `<div class="timeline-item"><span class="timeline-dot" aria-hidden="true"></span><details class="timeline-card" ${readingMode || index < openCount ? "open" : ""}><summary><span class="time-label">${inlineMarkdown(entry.time)}</span><span class="event-title">${inlineMarkdown(entry.title)}</span></summary><div class="event-body md-content">${renderMarkdown(entry.body || "详细内容将在临近出发时补充。")}</div></details></div>`).join("");
  }

  const sectionByTitle = (sections, title) => sections.find((section) => section.title === title);

  function createTabs() {
    tabs.innerHTML = days.map((day) => `<button class="date-tab" type="button" role="tab" aria-selected="${day.id === activeId}" data-day="${day.id}"><span class="tab-top"><span>${day.tabDate} ${day.weekday}</span><span>${day.icon}</span></span><span class="tab-title">${day.shortTitle} · <span class="tab-weather">${day.weather}</span></span></button>`).join("");
    tabs.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => selectDay(button.dataset.day)));
  }

  function selectDay(id) {
    activeId = id;
    history.replaceState(null, "", `#${id}`);
    render();
    tabs.querySelector(`[data-day="${id}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    app.focus({ preventScroll: true });
  }

  function renderChecklist(day, container, progress) {
    const key = `japan-checklist:${day.id}`;
    const checked = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    container.innerHTML = day.checklist.map((item, index) => `<label class="check-item"><input type="checkbox" data-index="${index}" ${checked.has(index) ? "checked" : ""}><span>${escapeHtml(item)}</span></label>`).join("");
    const update = () => {
      const selected = [...container.querySelectorAll("input:checked")].map((input) => Number(input.dataset.index));
      localStorage.setItem(key, JSON.stringify(selected));
      progress.textContent = `${selected.length} / ${day.checklist.length}`;
    };
    container.addEventListener("change", update); update();
  }

  function renderDecision(day, sections) {
    if (!day.decision) return "";
    const stateKey = `japan-weather:${day.id}`;
    const selected = localStorage.getItem(stateKey) || day.decision.options[0].id;
    const buttons = day.decision.options.map((option) => `<button class="weather-option" type="button" data-weather="${option.id}" aria-pressed="${option.id === selected}"><span>${option.icon}</span>${option.label}</button>`).join("");
    const option = day.decision.options.find((item) => item.id === selected);
    const section = option.section ? sectionByTitle(sections, option.section) : null;
    const branch = section ? timelineMarkup(splitTimeline(section.content), 1) : `<div class="source-content md-content">${renderMarkdown(option.note)}</div>`;
    return `<section class="decision-item" data-decision><div class="decision-header"><span class="decision-time">${day.decision.time} · 天气决策点</span><h4>${day.decision.title}</h4></div><div class="weather-switch" role="group" aria-label="选择天气方案">${buttons}</div><p class="decision-note">${option.note}</p><div class="branch-plan">${branch}</div></section>`;
  }

  function timelineAndConsumed(day, sections) {
    const consumed = new Set();
    let html = "";
    if (day.timelineStart) {
      const start = day.markdown.indexOf(day.timelineStart);
      const end = day.markdown.indexOf(`## ${day.timelineEndHeading}`);
      html = timelineMarkup(splitTimeline(day.markdown.slice(start, end > start ? end : undefined)), day.defaultOpenCount);
    } else {
      (day.timelineSections || []).forEach((title) => { const section = sectionByTitle(sections, title); if (section) { consumed.add(title); html += timelineMarkup(splitTimeline(section.content), day.defaultOpenCount); } });
      if (day.decision) { day.decision.options.forEach((option) => option.section && consumed.add(option.section)); html += renderDecision(day, sections); }
      (day.commonSections || []).forEach((title) => { const section = sectionByTitle(sections, title); if (section) { consumed.add(title); html += timelineMarkup(splitTimeline(section.content), 0); } });
    }
    return { html, consumed };
  }

  function renderSources(day, sections, consumed) {
    const routeMap = day.routeImage ? `<details class="source-accordion" ${readingMode ? "open" : ""}><summary>${escapeHtml(day.routeImageTitle)}</summary><div class="source-content route-map"><img src="${day.routeImage}" alt="${escapeHtml(day.routeImageAlt)}" loading="lazy"><p>${escapeHtml(day.routeImageNote)}</p></div></details>` : "";
    const accordions = sections.filter((section) => !consumed.has(section.title)).map((section, index) => {
      let content = section.content;
      if (day.timelineStart && section.title !== day.timelineEndHeading) { const markerIndex = content.indexOf(day.timelineStart); if (markerIndex >= 0) content = content.slice(0, markerIndex); }
      if (!content.trim()) return "";
      return `<details class="source-accordion" ${readingMode || index === 0 ? "open" : ""}><summary>${escapeHtml(section.title)}</summary><div class="source-content md-content">${renderMarkdown(content)}</div></details>`;
    }).join("");
    return routeMap + accordions;
  }

  function bindDecision(day) {
    const decision = app.querySelector("[data-decision]");
    if (!decision) return;
    decision.querySelectorAll("[data-weather]").forEach((button) => button.addEventListener("click", () => { localStorage.setItem(`japan-weather:${day.id}`, button.dataset.weather); render(); }));
  }

  function render() {
    const day = days.find((item) => item.id === activeId) || days[0];
    if (!day) { app.innerHTML = "<p>暂无行程数据。</p>"; return; }
    activeId = day.id; createTabs();
    const sections = splitSections(day.markdown);
    const fragment = template.content.cloneNode(true);
    fragment.querySelector(".day-kicker").textContent = `${day.tabDate} · ${day.weekday}`;
    fragment.querySelector(".day-title").textContent = day.markdown.match(/^#\s+.+?｜(.+)$/m)?.[1] || day.shortTitle;
    fragment.querySelector(".context-chips").innerHTML = day.context.map((item) => `<span class="context-chip">${escapeHtml(item)}</span>`).join("");
    fragment.querySelector(".boundary").textContent = day.boundary;
    const { html, consumed } = timelineAndConsumed(day, sections);
    fragment.querySelector(".timeline").innerHTML = html;
    fragment.querySelector(".source-accordions").innerHTML = renderSources(day, sections, consumed);
    app.replaceChildren(fragment);
    renderChecklist(day, app.querySelector(".checklist"), app.querySelector(".check-progress"));
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
  readingButton.addEventListener("click", () => { readingMode = !readingMode; render(); });
  lockButton.addEventListener("click", () => { localStorage.removeItem(SESSION_KEY); days = []; history.replaceState(null, "", location.pathname); document.title = "日本旅行计划"; showLogin(); });
  window.addEventListener("hashchange", () => { const requested = location.hash.slice(1); if (days.some((day) => day.id === requested)) { activeId = requested; render(); } });

  (async function bootstrap() {
    try {
      const response = await fetch("config.json", { cache: "no-store" });
      if (!response.ok) throw new Error();
      config = await response.json();
      if (!(await restoreSession())) showLogin();
    } catch { showLogin("网站配置暂时无法读取，请稍后重试。"); }
  })();
})();
