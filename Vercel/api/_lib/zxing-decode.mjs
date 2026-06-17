/**
 * Общая инициализация zxing-wasm и декод Data Matrix (Vercel + локальный тест).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/zxing-wasm@3.0.1/dist/reader/zxing_reader.wasm";

const READER_OPTIONS = {
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 8,
};

function hasWebpSignature(bytes) {
  if (!bytes || bytes.length < 12) {
    return false;
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function hasJpegSignature(bytes) {
  return bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function hasPngSignature(bytes) {
  return (
    bytes &&
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function looksLikeHtml(bytes) {
  if (!bytes || bytes.length < 5) {
    return false;
  }
  const head = Buffer.from(bytes.slice(0, Math.min(bytes.length, 256)))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}

function bytesToUint8Array(buf) {
  if (buf instanceof Uint8Array) {
    return buf;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function getSharp() {
  const sharpModule = await import("sharp");
  return sharpModule.default || sharpModule;
}

async function preprocessForDecode(bytes, contentType) {
  const sourceBytes = bytesToUint8Array(bytes);
  const ct = String(contentType || "").toLowerCase();
  const isWebp = ct.includes("image/webp") || hasWebpSignature(sourceBytes);
  const isRaster =
    isWebp ||
    hasJpegSignature(sourceBytes) ||
    hasPngSignature(sourceBytes) ||
    ct.startsWith("image/");

  if (!isRaster) {
    return [sourceBytes];
  }

  try {
    const sharp = await getSharp();
    const input = Buffer.from(sourceBytes);
    const variants = [];

    const base = await sharp(input, { failOn: "none" })
      .rotate()
      .png()
      .toBuffer();
    variants.push(bytesToUint8Array(base));

    const contrast = await sharp(input, { failOn: "none" })
      .rotate()
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
    variants.push(bytesToUint8Array(contrast));

    if (isWebp) {
      const large = await sharp(input, { failOn: "none" })
        .rotate()
        .resize({ width: 2200, withoutEnlargement: false })
        .png()
        .toBuffer();
      variants.push(bytesToUint8Array(large));
    }

    return variants;
  } catch (error) {
    console.error("zxing preprocess failed:", error?.message || error);
    if (isWebp) {
      return [sourceBytes];
    }
    return [sourceBytes];
  }
}

function findWasmPath() {
  const candidates = [
    join(__dirname, "zxing_reader.wasm"),
    join(process.cwd(), "api", "_lib", "zxing_reader.wasm"),
    join(process.cwd(), "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm"),
    join(process.cwd(), "Vercel", "api", "_lib", "zxing_reader.wasm"),
    join(process.cwd(), "Vercel", "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

async function prepareFromWasmUrl(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`wasm_fetch_${res.status}`);
  }
  const wasmBinary = await res.arrayBuffer();
  await prepareZXingModule({
    overrides: { wasmBinary },
    fireImmediately: true,
  });
}

let initPromise = null;
let initSource = null;

/** @returns {Promise<string>} local | cdn */
export function initZxingOnce() {
  if (!initPromise) {
    initPromise = (async () => {
      const wasmPath = findWasmPath();
      if (wasmPath) {
        await prepareZXingModule({
          overrides: { wasmBinary: readFileSync(wasmPath).buffer },
          fireImmediately: true,
        });
        initSource = "local";
        return initSource;
      }
      await prepareFromWasmUrl(WASM_CDN);
      initSource = "cdn";
      return initSource;
    })();
  }
  return initPromise;
}

export function getZxingInitSource() {
  return initSource;
}

function normalizeBarcodeFormat(format) {
  return String(format || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function pickBestResult(results) {
  const withText = results.filter(
    (item) => typeof item?.text === "string" && item.text.trim().length > 0
  );
  if (!withText.length) {
    return null;
  }

  return (
    withText.find((item) => normalizeBarcodeFormat(item.format) === "datamatrix") ||
    withText[0]
  );
}

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} imageBytes
 * @param {{ contentType?: string }} [options]
 */
export async function decodeBuffer(imageBytes, options = {}) {
  await initZxingOnce();

  const sourceBytes =
    imageBytes instanceof Uint8Array
      ? imageBytes
      : new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength);

  if (!sourceBytes.length) {
    return { ok: false, error: "image_empty" };
  }
  if (looksLikeHtml(sourceBytes)) {
    return { ok: false, error: "image_fetch_html" };
  }

  const variants = await preprocessForDecode(sourceBytes, options.contentType);
  const started = Date.now();
  let lastResults = [];
  let best = null;

  for (const bytes of variants) {
    const results = await readBarcodes(bytes, READER_OPTIONS);
    lastResults = results;
    best = pickBestResult(results);
    if (best) {
      break;
    }
  }

  const ms = Date.now() - started;
  if (!best) {
    if (!lastResults.length) {
      return { ok: false, ms, error: "not_found", wasm: initSource };
    }
    return { ok: false, ms, error: "empty_decode", count: lastResults.length, wasm: initSource };
  }

  return {
    ok: true,
    ms,
    text: best.text.trim(),
    format: best.format,
    count: lastResults.length,
    isInverted: Boolean(best.isInverted),
    wasm: initSource,
  };
}
