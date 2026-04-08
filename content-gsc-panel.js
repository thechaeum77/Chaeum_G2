(() => {
  const MESSAGE_TYPE_FETCH_FEED = "chaeum-g2-fetch-feed";
  const STORAGE_KEY_PENDING_INSPECT = "pendingInspectRequest";
  const STORAGE_KEY_FEED_CACHE = "feedCacheByResource";
  const PANEL_ID = "chaeum-g2-panel";
  const STYLE_ID = "chaeum-g2-panel-style";
  const TOGGLE_BUTTON_ID = "chaeum-g2-toggle";
  const PANEL_HIDDEN_CLASS = "cg2-hidden";

  function sanitizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  async function loadSites() {
    return mergeSitesWithCurrentSelection([]);
  }

  function buildResourceId(site) {
    if (site.propertyType === "domain") {
      return `sc-domain:${site.propertyValue.replace(/^sc-domain:/i, "")}`;
    }

    return site.propertyValue;
  }

  function buildInspectUrl(site) {
    return `https://search.google.com/search-console?resource_id=${encodeURIComponent(buildResourceId(site))}`;
  }

  async function savePendingInspect(site, targetUrl) {
    await chrome.storage.local.set({
      [STORAGE_KEY_PENDING_INSPECT]: {
        resourceId: buildResourceId(site),
        targetUrl,
        savedAt: Date.now()
      }
    });
  }

  async function loadCachedFeedItems(site) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_FEED_CACHE);
      const cache = stored?.[STORAGE_KEY_FEED_CACHE];
      const entry = cache?.[buildResourceId(site)];
      if (!entry || !Array.isArray(entry.items)) return [];
      return entry.items;
    } catch {
      return [];
    }
  }

  async function saveCachedFeedItems(site, items) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_FEED_CACHE);
      const cache = stored?.[STORAGE_KEY_FEED_CACHE] && typeof stored[STORAGE_KEY_FEED_CACHE] === "object"
        ? stored[STORAGE_KEY_FEED_CACHE]
        : {};

      cache[buildResourceId(site)] = {
        items: Array.isArray(items) ? items.slice(0, 8) : [],
        savedAt: Date.now()
      };

      await chrome.storage.local.set({
        [STORAGE_KEY_FEED_CACHE]: cache
      });
    } catch {
      // Ignore cache persistence failures.
    }
  }

  function isTargetUrlCompatible(site, targetUrl) {
    try {
      const target = new URL(targetUrl);

      if (site.propertyType === "domain") {
        const propertyHost = sanitizeText(site.propertyValue)
          .replace(/^sc-domain:/i, "")
          .replace(/\.$/, "")
          .toLowerCase();
        const targetHost = target.hostname.toLowerCase();

        return targetHost === propertyHost || targetHost.endsWith(`.${propertyHost}`);
      }

      const propertyUrl = new URL(site.propertyValue);
      return target.href.startsWith(propertyUrl.href);
    } catch {
      return false;
    }
  }

  function getCompatibilityMessage(site, targetUrl) {
    if (site.propertyType === "domain") {
      const targetHost = new URL(targetUrl).hostname;
      return `현재 속성은 ${site.propertyValue} 범위만 검사할 수 있습니다. ${targetHost} 주소를 검사하려면 해당 호스트 또는 상위 도메인 속성으로 등록해 주세요.`;
    }

    return `현재 속성은 ${site.propertyValue} 접두어만 검사할 수 있습니다. 검사할 URL이 이 접두어로 시작하는지 확인해 주세요.`;
  }

  function getCurrentTargetUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get("page") || "";
  }

  function getCurrentResourceId() {
    const params = new URLSearchParams(window.location.search);
    return sanitizeText(params.get("resource_id"));
  }

  function createSiteFromResourceId(resourceId) {
    const normalized = sanitizeText(resourceId);
    if (!normalized) return null;

    if (normalized.startsWith("sc-domain:")) {
      const domain = normalized.replace(/^sc-domain:/i, "").trim().toLowerCase();
      if (!domain) return null;

      return {
        id: `current-${domain}`,
        label: domain,
        propertyType: "domain",
        propertyValue: domain,
        rssUrl: ""
      };
    }

    return {
      id: `current-${normalized}`,
      label: normalized,
      propertyType: "url-prefix",
      propertyValue: normalized,
      rssUrl: ""
    };
  }

  function mergeSitesWithCurrentSelection(sites) {
    const currentSite = createSiteFromResourceId(getCurrentResourceId());
    const normalizedSites = Array.isArray(sites) ? sites : [];

    if (!currentSite) {
      return normalizedSites;
    }

    const currentResourceId = buildResourceId(currentSite);
    const matchedSite = normalizedSites.find(site => buildResourceId(site) === currentResourceId);

    if (!matchedSite) {
      return [currentSite, ...normalizedSites];
    }

    const mergedCurrentSite = {
      ...currentSite,
      ...matchedSite,
      id: matchedSite.id || currentSite.id,
      label: matchedSite.label || currentSite.label,
      rssUrl: matchedSite.rssUrl || currentSite.rssUrl
    };

    return [
      mergedCurrentSite,
      ...normalizedSites.filter(site => buildResourceId(site) !== currentResourceId)
    ];
  }

  function buildFeedCandidates(site) {
    const candidates = [];
    const pushCandidate = value => {
      const candidate = sanitizeText(value);
      if (!candidate || candidates.includes(candidate)) return;
      candidates.push(candidate);
    };

    pushCandidate(site.rssUrl);

    if (site.propertyType === "domain") {
      const host = sanitizeText(site.propertyValue).replace(/^sc-domain:/i, "");
      if (host) {
        pushCandidate(`https://${host}/rss`);
        pushCandidate(`https://${host}/feed`);
        pushCandidate(`https://${host}/atom.xml`);
      }

      return candidates;
    }

    try {
      const propertyUrl = new URL(site.propertyValue);
      const trimmedPath = propertyUrl.pathname.endsWith("/")
        ? propertyUrl.pathname.slice(0, -1)
        : propertyUrl.pathname;

      pushCandidate(`${propertyUrl.origin}${trimmedPath}/rss`);
      pushCandidate(`${propertyUrl.origin}${trimmedPath}/feed`);
      pushCandidate(`${propertyUrl.origin}${trimmedPath}/atom.xml`);
      pushCandidate(`${propertyUrl.origin}/rss`);
      pushCandidate(`${propertyUrl.origin}/feed`);
      pushCandidate(`${propertyUrl.origin}/atom.xml`);
    } catch {
      // Ignore invalid property values and fall back to saved RSS only.
    }

    return candidates;
  }

  async function fetchFeedItemsForSite(site) {
    const candidates = buildFeedCandidates(site);

    for (const feedUrl of candidates) {
      try {
        const items = await fetchFeedItems(feedUrl);
        if (items.length > 0) {
          return { items, feedUrl };
        }
      } catch {
        // Try the next RSS candidate.
      }
    }

    throw new Error("feed_fetch_failed");
  }

  function formatDateText(value) {
    if (!value) return "";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  }

  function parseFeedXml(xmlText) {
    const xml = new DOMParser().parseFromString(xmlText, "text/xml");
    if (xml.querySelector("parsererror")) {
      return [];
    }

    const rssItems = Array.from(xml.querySelectorAll("item")).map(item => ({
      title: sanitizeText(item.querySelector("title")?.textContent) || "제목 없음",
      link: sanitizeText(item.querySelector("link")?.textContent),
      publishedAt: sanitizeText(item.querySelector("pubDate")?.textContent)
    }));

    if (rssItems.length > 0) {
      return rssItems.filter(item => item.link).slice(0, 8);
    }

    const atomItems = Array.from(xml.querySelectorAll("entry")).map(entry => {
      const linkEl = entry.querySelector("link[rel='alternate']") || entry.querySelector("link");
      return {
        title: sanitizeText(entry.querySelector("title")?.textContent) || "제목 없음",
        link: sanitizeText(linkEl?.getAttribute("href") || linkEl?.textContent),
        publishedAt:
          sanitizeText(entry.querySelector("published")?.textContent) ||
          sanitizeText(entry.querySelector("updated")?.textContent)
      };
    });

    return atomItems.filter(item => item.link).slice(0, 8);
  }

  async function fetchFeedItems(feedUrl) {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE_FETCH_FEED,
      feedUrl
    });

    if (!response || !response.ok || typeof response.text !== "string") {
      throw new Error("feed_fetch_failed");
    }

    return parseFeedXml(response.text);
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 110px;
        right: 18px;
        z-index: 2147483646;
        width: 320px;
        max-height: calc(100vh - 140px);
        display: flex;
        flex-direction: column;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(203, 213, 225, 0.9);
        border-radius: 18px;
        box-shadow: 0 20px 50px rgba(15, 23, 42, 0.18);
        backdrop-filter: blur(12px);
        overflow: hidden;
        font-family: "Segoe UI", "Noto Sans KR", sans-serif;
      }

      #${PANEL_ID}.${PANEL_HIDDEN_CLASS} {
        display: none;
      }

      #${TOGGLE_BUTTON_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        background: #0f766e;
        color: #fff;
        box-shadow: 0 16px 36px rgba(15, 23, 42, 0.24);
        font-family: "Segoe UI", "Noto Sans KR", sans-serif;
        font-size: 14px;
        font-weight: 800;
        cursor: pointer;
      }

      #${TOGGLE_BUTTON_ID}:hover {
        background: #0b5f59;
      }

      #${PANEL_ID} * {
        box-sizing: border-box;
      }

      #${PANEL_ID} .cg2-head {
        padding: 16px 16px 12px;
        border-bottom: 1px solid #e5e7eb;
      }

      #${PANEL_ID} .cg2-title {
        margin: 0;
        font-size: 18px;
        font-weight: 800;
        color: #111827;
      }

      #${PANEL_ID} .cg2-desc {
        margin: 6px 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: #6b7280;
      }

      #${PANEL_ID} .cg2-body {
        padding: 14px 16px 16px;
        overflow: auto;
      }

      #${PANEL_ID} .cg2-label {
        display: block;
        margin-bottom: 6px;
        font-size: 12px;
        font-weight: 700;
        color: #374151;
      }

      #${PANEL_ID} .cg2-input {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        padding: 11px 12px;
        font-size: 13px;
        color: #111827;
        background: #fff;
      }

      #${PANEL_ID} .cg2-status {
        margin: 10px 0 14px;
        min-height: 18px;
        font-size: 12px;
        color: #6b7280;
      }

      #${PANEL_ID} .cg2-list {
        display: grid;
        gap: 10px;
      }

      #${PANEL_ID} .cg2-site {
        border: 1px solid #dbe3eb;
        background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
        border-radius: 14px;
        padding: 12px;
      }

      #${PANEL_ID} .cg2-site-title {
        margin: 0 0 4px;
        font-size: 14px;
        font-weight: 800;
        color: #0f172a;
      }

      #${PANEL_ID} .cg2-site-meta {
        margin: 0 0 10px;
        font-size: 11px;
        line-height: 1.5;
        color: #64748b;
        word-break: break-all;
      }

      #${PANEL_ID} .cg2-site-button,
      #${PANEL_ID} .cg2-feed-button {
        width: 100%;
        border: 0;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
      }

      #${PANEL_ID} .cg2-site-button {
        background: #0f766e;
        color: #fff;
      }

      #${PANEL_ID} .cg2-feed-button {
        margin-top: 8px;
        background: #e0f2fe;
        color: #075985;
      }

      #${PANEL_ID} .cg2-empty {
        border: 1px dashed #cbd5e1;
        border-radius: 14px;
        padding: 16px;
        text-align: center;
        font-size: 13px;
        color: #64748b;
        line-height: 1.6;
      }

      #${PANEL_ID} .cg2-feed-list {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }

      #${PANEL_ID} .cg2-feed-item {
        display: block;
        padding: 10px;
        border-radius: 10px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        text-decoration: none;
        color: #0f172a;
      }

      #${PANEL_ID} .cg2-feed-item-title {
        display: block;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.5;
      }

      #${PANEL_ID} .cg2-feed-item-date {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        color: #64748b;
      }

      #${PANEL_ID} .cg2-feed-empty {
        margin-top: 10px;
        font-size: 12px;
        color: #64748b;
        line-height: 1.6;
      }

      @media (max-width: 1440px) {
        #${PANEL_ID} {
          width: 290px;
        }
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function setStatus(panel, message, isError = false) {
    const statusEl = panel.querySelector(".cg2-status");
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.style.color = isError ? "#b91c1c" : "#6b7280";
  }

  function createPanel() {
    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.classList.add(PANEL_HIDDEN_CLASS);
    panel.innerHTML = `
      <div class="cg2-head">
        <h2 class="cg2-title">채움 G2</h2>
        <p class="cg2-desc">저장한 블로그 목록을 불러와 URL 검사와 색인 생성 요청을 빠르게 실행합니다.</p>
      </div>
      <div class="cg2-body">
        <label class="cg2-label" for="cg2-target-url">검사할 URL</label>
        <input id="cg2-target-url" class="cg2-input" type="url" placeholder="https://example.com/post/123">
        <div class="cg2-status"></div>
        <div class="cg2-list"></div>
      </div>
    `;

    return panel;
  }

  function createToggleButton(panel) {
    const button = document.createElement("button");
    button.id = TOGGLE_BUTTON_ID;
    button.type = "button";
    button.textContent = "채움 G2 열기";
    button.setAttribute("aria-expanded", "false");

    button.addEventListener("click", () => {
      const willOpen = panel.classList.contains(PANEL_HIDDEN_CLASS);
      panel.classList.toggle(PANEL_HIDDEN_CLASS, !willOpen);
      button.textContent = willOpen ? "채움 G2 닫기" : "채움 G2 열기";
      button.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });

    return button;
  }

  function renderFeedItems(feedListEl, inputEl, panel, items) {
    feedListEl.innerHTML = "";

    for (const item of items) {
      const link = document.createElement("a");
      link.className = "cg2-feed-item";
      link.href = "#";
      link.innerHTML = `
        <span class="cg2-feed-item-title"></span>
        <span class="cg2-feed-item-date"></span>
      `;

      link.querySelector(".cg2-feed-item-title").textContent = item.title;
      link.querySelector(".cg2-feed-item-date").textContent = formatDateText(item.publishedAt) || item.link;

      link.addEventListener("click", event => {
        event.preventDefault();
        inputEl.value = item.link;
        setStatus(panel, "RSS 글 URL을 입력창에 채웠습니다. 같은 카드의 검사 실행 버튼을 누르세요.");
      });

      feedListEl.appendChild(link);
    }
  }

  async function renderSites(panel, sites) {
    const listEl = panel.querySelector(".cg2-list");
    const inputEl = panel.querySelector("#cg2-target-url");
    if (!listEl || !inputEl) return;

    listEl.innerHTML = "";

    if (!sites.length) {
      listEl.innerHTML = `
        <div class="cg2-empty">
          현재 선택된 Search Console 속성을 찾지 못했습니다.<br>
          속성을 하나 선택한 뒤 다시 시도해 주세요.
        </div>
      `;
      setStatus(panel, "현재 선택된 속성을 읽지 못했습니다.", true);
      return;
    }

    setStatus(panel, `현재 선택된 속성 ${sites.length}개를 불러왔습니다.`);

    for (const site of sites) {
      const card = document.createElement("div");
      card.className = "cg2-site";
      card.innerHTML = `
        <p class="cg2-site-title"></p>
        <p class="cg2-site-meta"></p>
        <button class="cg2-site-button" type="button">이 블로그로 검사 실행</button>
        <button class="cg2-feed-button" type="button">RSS 최신 글 불러오기</button>
        <div class="cg2-feed-list"></div>
      `;

      card.querySelector(".cg2-site-title").textContent = site.label || site.propertyValue;
      card.querySelector(".cg2-site-meta").textContent =
        `${site.propertyType === "domain" ? "도메인 속성" : "URL 접두어"} | ${site.propertyValue}`;
      const feedListEl = card.querySelector(".cg2-feed-list");

      if (feedListEl) {
        const cachedItems = await loadCachedFeedItems(site);
        if (cachedItems.length > 0) {
          renderFeedItems(feedListEl, inputEl, panel, cachedItems);
        }
      }

      card.querySelector(".cg2-site-button")?.addEventListener("click", async () => {
        const targetUrl = sanitizeText(inputEl.value);

        if (!targetUrl) {
          setStatus(panel, "먼저 검사할 URL을 입력해 주세요.", true);
          inputEl.focus();
          return;
        }

        try {
          new URL(targetUrl);
        } catch {
          setStatus(panel, "올바른 URL 형식이 아닙니다.", true);
          inputEl.focus();
          return;
        }

        if (!isTargetUrlCompatible(site, targetUrl)) {
          setStatus(panel, getCompatibilityMessage(site, targetUrl), true);
          inputEl.focus();
          return;
        }

        setStatus(panel, `${site.label || site.propertyValue} 속성으로 검사 페이지를 여는 중입니다.`);
        await savePendingInspect(site, targetUrl);
        window.location.href = buildInspectUrl(site);
      });

      card.querySelector(".cg2-feed-button")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        if (!(button instanceof HTMLButtonElement) || !feedListEl) return;

        button.disabled = true;
        button.textContent = "RSS 불러오는 중...";
        feedListEl.innerHTML = "";
        setStatus(panel, `${site.label || site.propertyValue} RSS를 불러오는 중입니다.`);

        try {
          const { items } = await fetchFeedItemsForSite(site);

          if (!items.length) {
            feedListEl.innerHTML = `<div class="cg2-feed-empty">RSS에서 글을 찾지 못했습니다.</div>`;
            setStatus(panel, "RSS는 열렸지만 글 목록을 추출하지 못했습니다.", true);
            return;
          }

          renderFeedItems(feedListEl, inputEl, panel, items);
          await saveCachedFeedItems(site, items);
          setStatus(panel, `RSS 최신 글 ${items.length}개를 불러왔습니다.`);
        } catch {
          feedListEl.innerHTML = `<div class="cg2-feed-empty">RSS를 불러오지 못했습니다.</div>`;
          setStatus(panel, "RSS 요청에 실패했습니다. RSS 주소를 확인해 주세요.", true);
        } finally {
          button.disabled = false;
          button.textContent = "RSS 최신 글 불러오기";
        }
      });

      listEl.appendChild(card);
    }
  }

  async function mountPanel() {
    if (window.top !== window.self) return;
    if (document.getElementById(PANEL_ID)) return;

    injectStyle();

    const panel = createPanel();
    const toggleButton = createToggleButton(panel);
    const inputEl = panel.querySelector("#cg2-target-url");
    if (inputEl) {
      inputEl.value = getCurrentTargetUrl();
    }

    (document.body || document.documentElement).appendChild(panel);
    (document.body || document.documentElement).appendChild(toggleButton);

    const refreshPanel = async () => {
      const currentInputEl = panel.querySelector("#cg2-target-url");
      if (currentInputEl) {
        currentInputEl.value = getCurrentTargetUrl();
      }

      const sites = await loadSites();
      await renderSites(panel, sites);
    };

    await refreshPanel();

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes[STORAGE_KEY_FEED_CACHE]) return;

      refreshPanel()
        .catch(() => setStatus(panel, "RSS 목록을 새로고침하지 못했습니다.", true));
    });

    let lastHref = window.location.href;
    window.setInterval(() => {
      if (window.location.href === lastHref) return;
      lastHref = window.location.href;
      refreshPanel().catch(() => {});
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      mountPanel().catch(() => {});
    }, { once: true });
  } else {
    mountPanel().catch(() => {});
  }
})();
