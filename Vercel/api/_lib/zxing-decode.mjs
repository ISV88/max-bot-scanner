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
  maxNumberOfSymbols: 5,
};

function hasWebpSignature(bytes) {
  if (!bytes || bytes.length < 12) {
    return false;
  }
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  );
}

function bytesToUint8Array(buf) {
  if (buf instanceof Uint8Array) {
    return buf;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function convertWebpToPngIfNeeded(bytes, contentType) {
  const ct = String(contentType || "").toLowerCase();
  const isWebp = ct.includes("image/webp") || hasWebpSignature(bytes);
  if (!isWebp) {
    return bytes;
  }

  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default || sharpModule;
    const pngBuffer = await sharp(Buffer.from(bytes)).png().toBuffer();
    return bytesToUint8Array(pngBuffer);
  } catch {
    // Если конвертер недоступен или конвертация не удалась, пробуем декодировать исходные байты.
    return bytes;
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
  const bytes = await convertWebpToPngIfNeeded(sourceBytes, options.contentType);

  const started = Date.now();
  const results = await readBarcodes(bytes, READER_OPTIONS);
  const ms = Date.now() - started;

  if (!results.length) {
    return { ok: false, ms, error: "not_found" };
  }
  const withText = results.filter(
    (item) => typeof item?.text === "string" && item.text.trim().length > 0
  );
  if (!withText.length) {
    return { ok: false, ms, error: "empty_decode", count: results.length };
  }

  // Приоритет DataMatrix, чтобы не выбирать соседний EAN/QR на этикетке.
  const best =
    withText.find((item) => String(item.format || "").toLowerCase() === "datamatrix") ||
    withText[0];

  return {
    ok: true,
    ms,
    text: best.text.trim(),
    format: best.format,
    count: results.length,
    isInverted: Boolean(best.isInverted),
  };
}
