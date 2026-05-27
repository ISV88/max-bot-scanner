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

function isEmptyMessageText(update) {
  const text = update?.message?.body?.text;
  return typeof text !== "string" || text.trim() === "";
}

function getImageAttachment(update) {
  const attachments = update?.message?.body?.attachments;
  if (!Array.isArray(attachments)) {
    return null;
  }
  for (const item of attachments) {
    if (item?.type === "image" && item?.payload?.url) {
      return item.payload;
    }
  }
  return null;
}

function withTokenIfNeeded(url, token) {
  if (!token) {
    return url;
  }
  if (url.includes("token=")) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

async function decodeImageFromAttachment(payload) {
  const imageUrl = withTokenIfNeeded(payload.url, payload.token);
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    return { ok: false, error: `image_fetch_${imageResponse.status}` };
  }
  const imageBytes = await imageResponse.arrayBuffer();
  const contentType = imageResponse.headers.get("content-type") || "";
  const { decodeBuffer } = await import("./_lib/zxing-decode.mjs");
  return decodeBuffer(new Uint8Array(imageBytes), { contentType });
}

async function enrichPhotoMessages(bodyObj) {
  const updates = getUpdateList(bodyObj);
  for (const update of updates) {
    if (update?.update_type !== "message_created") {
      continue;
    }
    if (!isEmptyMessageText(update)) {
      continue;
    }
    const payload = getImageAttachment(update);
    if (!payload) {
      continue;
    }
    try {
      const decoded = await decodeImageFromAttachment(payload);
      if (decoded?.ok && decoded.text) {
        const format = String(decoded?.format || "").toLowerCase();
        if (format === "datamatrix") {
          update.message.body.text = decoded.text;
        } else {
          update.message.body.text = `${DECODE_NON_DM_PREFIX}${format || "unknown"}`;
        }
      } else {
        update.message.body.text = DECODE_FAILED_MARKER;
      }
    } catch {
      update.message.body.text = DECODE_FAILED_MARKER;
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
