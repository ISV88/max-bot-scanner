/**
 * Прокси MAX → 1С: POST /api/max-webhook
 * MAX (HTTPS) → Vercel → HTTP ONEC_WEBHOOK_URL (galaxy_ut_test, /hs/maxwebhook/{ключ})
 */

const ONEC_TIMEOUT_MS = 25000;
const DECODE_FAILED_MARKER = "__MAX_DM_DECODE_FAILED__";
const DECODE_NON_DM_PREFIX = "__MAX_NON_DM__:";

function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getRequestBody(req) {
  if (req.body === undefined || req.body === null) {
    return "{}";
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  return JSON.stringify(req.body);
}

function toBodyObject(req) {
  if (req.body === undefined || req.body === null) {
    return {};
  }
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  if (typeof req.body === "object") {
    return req.body;
  }
  return null;
}

function checkMaxSecret(req) {
  const expected = process.env.MAX_WEBHOOK_SECRET;
  if (!expected) {
    return null;
  }
  const incoming = req.headers["x-max-bot-api-secret"];
  if (incoming !== expected) {
    return "invalid_secret";
  }
  return null;
}

/** Логин/пароль публикации 1С на IIS (тот же диалог, что в браузере). */
function getOnecBasicAuthHeader() {
  const user = process.env.ONEC_WEBHOOK_USER;
  const pass = process.env.ONEC_WEBHOOK_PASSWORD;
  if (!user || !pass) {
    return null;
  }
  const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function forwardToOnec(bodyText) {
  const onecUrl = process.env.ONEC_WEBHOOK_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONEC_TIMEOUT_MS);

  const headers = {
    "content-type": "application/json; charset=utf-8",
    "x-max-proxy-secret": process.env.ONEC_PROXY_SECRET || "",
  };
  const basicAuth = getOnecBasicAuthHeader();
  if (basicAuth) {
    headers.authorization = basicAuth;
  }

  try {
    const response = await fetch(onecUrl, {
      method: "POST",
      headers,
      body: bodyText,
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function getUpdateList(bodyObj) {
  if (Array.isArray(bodyObj)) {
    return bodyObj;
  }
  if (bodyObj && Array.isArray(bodyObj.updates)) {
    return bodyObj.updates;
  }
  if (bodyObj && typeof bodyObj === "object" && bodyObj.update_type) {
    return [bodyObj];
  }
  return [];
}

function isDecodeMarkerText(text) {
  const value = String(text || "");
  return (
    value === DECODE_FAILED_MARKER ||
    value.startsWith(`${DECODE_FAILED_MARKER}:`) ||
    value.startsWith(DECODE_NON_DM_PREFIX)
  );
}

function isLikelyBarcodeText(text) {
  const value = String(text || "").trim();
  if (value.length < 4) {
    return false;
  }
  if (value.startsWith("]d") || value.startsWith("(")) {
    return true;
  }
  if (/^00\d{18,}$/.test(value) || /^01\d{14}/.test(value)) {
    return true;
  }
  if (/^\d{8,}$/.test(value)) {
    return true;
  }
  return /^[\x20-\x7E]+$/.test(value) && value.length >= 8;
}

function looksLikeMaxNativeBarcodeText(text) {
  const value = String(text || "").trim();
  if (!value || value.length < 8 || isDecodeMarkerText(value)) {
    return false;
  }
  if (isLikelyBarcodeText(value)) {
    return false;
  }
  return /^[A-Za-z0-9+/]+=*$/.test(value);
}

function tryDecodeMaxNativeText(text) {
  if (!looksLikeMaxNativeBarcodeText(text)) {
    return null;
  }
  try {
    const decoded = Buffer.from(String(text).trim(), "base64").toString("utf8");
    return isLikelyBarcodeText(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function shouldDecodePhotoMessage(update) {
  if (update?.update_type !== "message_created") {
    return false;
  }
  if (!getImageAttachment(update)) {
    return false;
  }
  const text = update?.message?.body?.text;
  if (typeof text !== "string" || text.trim() === "") {
    return true;
  }
  if (isDecodeMarkerText(text)) {
    return true;
  }
  return looksLikeMaxNativeBarcodeText(text);
}

function getImageAttachment(update) {
  const attachments = update?.message?.body?.attachments;
  if (!Array.isArray(attachments)) {
    return null;
  }
  for (const item of attachments) {
    if (item?.type !== "image" || !item?.payload) {
      continue;
    }
    const payload = { ...item.payload };
    if (!payload.url) {
      if (Array.isArray(payload.ls) && payload.ls[0]) {
        payload.url = payload.ls[0];
      } else if (typeof payload.ls === "string" && payload.ls) {
        payload.url = payload.ls;
      }
    }
    if (payload.url) {
      return payload;
    }
  }
  return null;
}

function withTokenIfNeeded(url, token) {
  if (!token || url.includes("token=")) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function buildImageFetchUrls(payload) {
  const urls = [];
  const candidates = [payload?.url];
  if (Array.isArray(payload?.ls)) {
    candidates.push(...payload.ls);
  } else if (typeof payload?.ls === "string") {
    candidates.push(payload.ls);
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const base = String(candidate);
    urls.push(base);
    if (payload?.token) {
      urls.push(withTokenIfNeeded(base, payload.token));
    }
  }

  return [...new Set(urls)];
}

function getImageFetchHeaders() {
  const headers = {
    "user-agent": "MAXBotWebhook/1.0 (+https://vercel.com)",
    accept: "image/*,*/*;q=0.8",
  };
  const botToken = process.env.MAX_BOT_TOKEN;
  if (botToken) {
    headers.authorization = botToken;
  }
  return headers;
}

async function fetchImageBytes(url) {
  const response = await fetch(url, {
    headers: getImageFetchHeaders(),
    redirect: "follow",
  });
  if (!response.ok) {
    return { ok: false, error: `image_fetch_${response.status}`, status: response.status };
  }
  const imageBytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "";
  return {
    ok: true,
    bytes: new Uint8Array(imageBytes),
    contentType,
    size: imageBytes.byteLength,
  };
}

async function downloadImageFromAttachment(payload) {
  const urls = buildImageFetchUrls(payload);
  let lastError = "image_fetch_no_url";

  for (const url of urls) {
    try {
      const fetched = await fetchImageBytes(url);
      if (!fetched.ok) {
        lastError = fetched.error;
        continue;
      }
      if (!fetched.size) {
        lastError = "image_empty";
        continue;
      }
      return fetched;
    } catch (error) {
      lastError = `image_fetch_error:${error?.message || error}`;
    }
  }

  return { ok: false, error: lastError };
}

function makeDecodeFailedMarker(reason) {
  if (!reason) {
    return DECODE_FAILED_MARKER;
  }
  return `${DECODE_FAILED_MARKER}:${reason}`;
}

function normalizeBarcodeFormat(format) {
  return String(format || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

async function decodeImageFromAttachment(payload) {
  const downloaded = await downloadImageFromAttachment(payload);
  if (!downloaded.ok) {
    return { ok: false, error: downloaded.error };
  }

  const { decodeBuffer } = await import("./_lib/zxing-decode.mjs");
  return decodeBuffer(downloaded.bytes, { contentType: downloaded.contentType });
}

async function enrichPhotoMessages(bodyObj) {
  const updates = getUpdateList(bodyObj);
  for (const update of updates) {
    const payload = getImageAttachment(update);
    if (!payload) {
      continue;
    }

    const currentText = update?.message?.body?.text;
    const fromBase64 = tryDecodeMaxNativeText(currentText);
    if (fromBase64) {
      update.message.body.text = fromBase64;
      console.info("max-webhook decode base64 ok", { size: fromBase64.length });
      continue;
    }

    if (!shouldDecodePhotoMessage(update)) {
      continue;
    }
    try {
      const decoded = await decodeImageFromAttachment(payload);
      if (decoded?.ok && decoded.text) {
        const format = normalizeBarcodeFormat(decoded?.format);
        if (format === "datamatrix") {
          update.message.body.text = decoded.text;
          console.info("max-webhook decode ok", {
            ms: decoded.ms,
            wasm: decoded.wasm,
            size: decoded.text.length,
          });
        } else {
          update.message.body.text = `${DECODE_NON_DM_PREFIX}${format || "unknown"}`;
          console.info("max-webhook decode non-dm", { format: decoded.format, ms: decoded.ms });
        }
      } else {
        const reason = decoded?.error || "decode_failed";
        update.message.body.text = makeDecodeFailedMarker(reason);
        console.error("max-webhook decode failed", {
          reason,
          ms: decoded?.ms,
          wasm: decoded?.wasm,
          count: decoded?.count,
        });
      }
    } catch (error) {
      const reason = `decode_exception:${error?.message || error}`;
      update.message.body.text = makeDecodeFailedMarker(reason);
      console.error("max-webhook decode exception", reason);
    }
  }
  return bodyObj;
}

module.exports = async (req, res) => {
  if (req.method === "GET" || req.method === "HEAD") {
    const onecUrl = process.env.ONEC_WEBHOOK_URL || "";
    json(res, 200, {
      ok: true,
      service: "max-webhook-proxy",
      onec_configured: Boolean(onecUrl),
      onec_auth_configured: Boolean(
        process.env.ONEC_WEBHOOK_USER && process.env.ONEC_WEBHOOK_PASSWORD
      ),
      max_secret_enabled: Boolean(process.env.MAX_WEBHOOK_SECRET),
      max_bot_token_set: Boolean(process.env.MAX_BOT_TOKEN),
      proxy_secret_set: Boolean(process.env.ONEC_PROXY_SECRET),
    });
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const secretError = checkMaxSecret(req);
  if (secretError) {
    json(res, 401, { ok: false, error: secretError });
    return;
  }

  if (!process.env.ONEC_WEBHOOK_URL) {
    json(res, 500, { ok: false, error: "onec_webhook_url_missing" });
    return;
  }

  const bodyObj = toBodyObject(req);
  const bodyText =
    bodyObj === null
      ? getRequestBody(req)
      : JSON.stringify(await enrichPhotoMessages(bodyObj));

  try {
    const onec = await forwardToOnec(bodyText);
    if (!onec.ok) {
      json(res, 502, {
        ok: false,
        error: "onec_rejected",
        status: onec.status,
        body: onec.text.slice(0, 500),
      });
      return;
    }
    json(res, 200, { ok: true });
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    json(res, 502, {
      ok: false,
      error: aborted ? "onec_timeout" : "onec_unreachable",
      details: String(error && error.message ? error.message : error),
    });
  }
};
