(() => {
  const MESSAGE_TYPE_NOTIFY = "chaeum-g2-notify";
  const STORAGE_KEY_PENDING_INSPECT = "pendingInspectRequest";
  const REQUEST_BUTTON_KEYWORDS = [
    "색인 생성 요청",
    "requestindexing"
  ];
  const INDEXED_KEYWORDS = [
    "url이google에등록되어있음",
    "urlisongoogle",
    "pageisindexed"
  ];
  const NOT_INDEXED_KEYWORDS = [
    "url이google에등록되어있지않음",
    "google에등록되어있지않음",
    "urlisnotongoogle",
    "pagenotindexed"
  ];
  const HANDLED_TARGET_TTL_MS = 3 * 60 * 1000;

  let requestFlowActive = false;
  let activeTargetKey = "";
  const handledTargetTimestamps = new Map();

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function normalizeUrlForCompare(value) {
    try {
      return new URL(String(value || "")).href;
    } catch {
      return normalizeText(value);
    }
  }

  function buildTargetKey(resourceId, targetUrl) {
    return `${normalizeText(resourceId)}|${normalizeUrlForCompare(targetUrl)}`;
  }

  function pruneHandledTargetCache() {
    const now = Date.now();
    for (const [key, timestamp] of handledTargetTimestamps) {
      if (now - timestamp > HANDLED_TARGET_TTL_MS) {
        handledTargetTimestamps.delete(key);
      }
    }
  }

  function isRecentlyHandledTarget(targetKey) {
    pruneHandledTargetCache();
    const lastHandledAt = handledTargetTimestamps.get(targetKey);
    if (!lastHandledAt) return false;
    return Date.now() - lastHandledAt <= HANDLED_TARGET_TTL_MS;
  }

  function markHandledTarget(targetKey) {
    pruneHandledTargetCache();
    handledTargetTimestamps.set(targetKey, Date.now());
  }

  function isVisibleElement(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isClickable(element) {
    if (!isVisibleElement(element)) return false;
    if (element.disabled) return false;
    if (element.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function collectCandidatesInRoot(root, selector, out) {
    if (!root || typeof root.querySelectorAll !== "function") return;

    for (const element of root.querySelectorAll(selector)) {
      out.push(element);
    }

    for (const node of root.querySelectorAll("*")) {
      if (node.shadowRoot) {
        collectCandidatesInRoot(node.shadowRoot, selector, out);
      }
    }
  }

  function findInspectionInput() {
    const selectors = [
      'input[aria-label*="URL"]',
      'input[aria-label*="검사"]',
      'input[aria-label*="Inspect"]',
      'input[placeholder*="URL"]',
      'input[placeholder*="검사"]',
      'input[placeholder*="Inspect"]',
      'input[type="search"]',
      'input[role="combobox"]'
    ];

    for (const selector of selectors) {
      const candidates = [];
      collectCandidatesInRoot(document, selector, candidates);
      const input = candidates.find(isClickable);
      if (input) return input;
    }

    return null;
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(input) {
    const eventInit = {
      key: "Enter",
      code: "Enter",
      which: 13,
      keyCode: 13,
      bubbles: true,
      cancelable: true
    };

    input.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    input.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    input.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function elementMatchesKeywords(element, keywords) {
    const text = normalizeText(element.textContent || "");
    const label = normalizeText(element.getAttribute("aria-label") || "");
    return keywords.some(keyword => text.includes(keyword) || label.includes(keyword));
  }

  function findRequestIndexingButton() {
    const candidates = [];
    const selectors = ["button", "a[role='button']", "div[role='button']", "span[role='button']"];

    for (const selector of selectors) {
      collectCandidatesInRoot(document, selector, candidates);
    }

    return candidates.find(
      element => isClickable(element) && elementMatchesKeywords(element, REQUEST_BUTTON_KEYWORDS)
    ) || null;
  }

  function detectInspectionState() {
    const pageText = normalizeText(document.body?.innerText || "");
    if (!pageText) return "unknown";

    if (NOT_INDEXED_KEYWORDS.some(keyword => pageText.includes(keyword))) {
      return "not_indexed";
    }

    if (INDEXED_KEYWORDS.some(keyword => pageText.includes(keyword))) {
      return "indexed";
    }

    return "unknown";
  }

  async function notify(title, message) {
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE_NOTIFY,
        title,
        message
      });
    } catch {
      // Ignore notification failures.
    }
  }

  function getCurrentResourceId() {
    const params = new URLSearchParams(window.location.search);
    return normalizeText(params.get("resource_id"));
  }

  async function getPendingInspectRequest() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_PENDING_INSPECT);
      const request = stored?.[STORAGE_KEY_PENDING_INSPECT];
      if (!request || typeof request.targetUrl !== "string") return null;

      if (request.resourceId && normalizeText(request.resourceId) !== getCurrentResourceId()) {
        return null;
      }

      if (request.savedAt && Date.now() - request.savedAt > 10 * 60 * 1000) {
        await chrome.storage.local.remove(STORAGE_KEY_PENDING_INSPECT);
        return null;
      }

      return request;
    } catch {
      return null;
    }
  }

  async function clearPendingInspectRequest() {
    try {
      await chrome.storage.local.remove(STORAGE_KEY_PENDING_INSPECT);
    } catch {
      // Ignore storage cleanup failures.
    }
  }

  async function submitInspectionIfNeeded() {
    const params = new URLSearchParams(window.location.search);
    const pageUrl = params.get("page");
    const pendingRequest = pageUrl ? null : await getPendingInspectRequest();
    const targetUrl = pageUrl || pendingRequest?.targetUrl || "";

    if (!targetUrl) return;

    const targetKey = buildTargetKey(getCurrentResourceId(), targetUrl);
    if (requestFlowActive) {
      if (activeTargetKey === targetKey) return;
      return;
    }
    if (isRecentlyHandledTarget(targetKey)) return;

    requestFlowActive = true;
    activeTargetKey = targetKey;

    try {
      const input = findInspectionInput();
      if (!input) return;

      if (normalizeUrlForCompare(input.value) !== normalizeUrlForCompare(targetUrl)) {
        input.focus();
        setInputValue(input, targetUrl);
        pressEnter(input);
        await sleep(800);
      }

      for (let attempt = 0; attempt < 180; attempt += 1) {
        const inspectionState = detectInspectionState();

        if (inspectionState === "indexed") {
          await clearPendingInspectRequest();
          markHandledTarget(targetKey);
          await notify("채움 G2", "이미 색인된 URL입니다. 추가 요청 없이 넘어가셔도 됩니다.");
          return;
        }

        const requestButton = findRequestIndexingButton();
        if (inspectionState === "not_indexed") {
          await clearPendingInspectRequest();
          markHandledTarget(targetKey);

          if (requestButton) {
            requestButton.scrollIntoView({
              behavior: "smooth",
              block: "center",
              inline: "nearest"
            });
            await notify("채움 G2", "미색인 상태입니다. '색인 생성 요청' 버튼을 수동으로 눌러주세요.");
          } else {
            await notify("채움 G2", "미색인 상태를 확인했습니다. 색인 생성 요청은 수동으로 진행해 주세요.");
          }
          return;
        }

        await sleep(1000);
      }

      await clearPendingInspectRequest();
      markHandledTarget(targetKey);
      await notify("채움 G2", "URL 검사는 열렸지만 색인 생성 요청 버튼은 찾지 못했습니다.");
    } finally {
      requestFlowActive = false;
      activeTargetKey = "";
    }
  }

  window.addEventListener("load", () => {
    submitInspectionIfNeeded().catch(() => {});
  });

  let lastUrl = window.location.href;
  window.setInterval(() => {
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    submitInspectionIfNeeded().catch(() => {});
  }, 1000);
})();
