#!/usr/bin/env node

import { readFileSync } from "node:fs";

const [outputsPath, outputKey] = process.argv.slice(2);

if (!outputsPath || !outputKey) {
  process.exit(1);
}

try {
  const outputs = JSON.parse(readFileSync(outputsPath, "utf8"));
  const value = outputs?.[outputKey];

  if (typeof value !== "string" || value !== value.trim() || /[\r\n]/u.test(value)) {
    process.exit(1);
  }

  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    process.exit(1);
  }

  process.stdout.write(value);
} catch {
  process.exit(1);
}
