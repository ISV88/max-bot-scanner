import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const source = join(root, "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm");
const targetDir = join(root, "api", "_lib");
const target = join(targetDir, "zxing_reader.wasm");

if (!existsSync(source)) {
  console.warn("copy-zxing-wasm: source wasm not found, skip");
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log("copy-zxing-wasm: copied to api/_lib/zxing_reader.wasm");
