const MESSAGE_TYPE_NOTIFY = "chaeum-g2-notify";
const MESSAGE_TYPE_FETCH_FEED = "chaeum-g2-fetch-feed";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === MESSAGE_TYPE_NOTIFY) {
    const title = typeof message.title === "string" ? message.title : "채움 G2";
    const text = typeof message.message === "string" ? message.message : "";

    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon/icon48.png",
      title,
      message: text,
      priority: 2
    });

    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MESSAGE_TYPE_FETCH_FEED) {
    const feedUrl = typeof message.feedUrl === "string" ? message.feedUrl.trim() : "";

    if (!feedUrl) {
      sendResponse({ ok: false, reason: "missing_feed_url" });
      return false;
    }

    fetch(feedUrl, {
      method: "GET",
      credentials: "omit",
      cache: "no-store"
    })
      .then(async response => {
        if (!response.ok) {
          sendResponse({
            ok: false,
            reason: "http_error",
            status: response.status
          });
          return;
        }

        const text = await response.text();
        sendResponse({ ok: true, text });
      })
      .catch(() => {
        sendResponse({ ok: false, reason: "fetch_failed" });
      });

    return true;
  }

  return false;
});
