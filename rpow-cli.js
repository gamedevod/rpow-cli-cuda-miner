#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");

const DEFAULT_SITE_ORIGIN = "https://rpow2.com";
const DEFAULT_API_ORIGIN = "https://api.rpow2.com";
const DEFAULT_INDEX = path.join(__dirname, "index.js");
const DEFAULT_STATE = path.join(__dirname, ".rpow-cli-state.json");
const DEFAULT_MINT_LOG = path.join(__dirname, ".rpow-mints.jsonl");
const MINER_WORKER = path.join(__dirname, "rpow-miner-worker.js");
const NATIVE_MINER_CANDIDATES = process.platform === "win32"
  ? [
    path.join(__dirname, "rpow-native-miner.exe"),
    path.join(__dirname, "rpow-native-miner"),
  ]
  : [
    path.join(__dirname, "rpow-native-miner"),
    path.join(__dirname, "rpow-native-miner.exe"),
  ];
const CUDA_MINER_CANDIDATES = process.platform === "win32"
  ? [
    path.join(__dirname, "rpow-cuda-miner.exe"),
    path.join(__dirname, "rpow-cuda-miner"),
  ]
  : [
    path.join(__dirname, "rpow-cuda-miner"),
    path.join(__dirname, "rpow-cuda-miner.exe"),
  ];
const SAFE_HOSTS = new Set([
  "api.rpow2.com",
  "rpow2.com",
  "www.rpow2.com",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function log(level, message, data) {
  const suffix = data === undefined ? "" : ` ${formatLogData(data)}`;
  const upper = level.toUpperCase();
  const plainLevel = upper.padEnd(7);
  const color = process.env.NO_COLOR
    ? ""
    : upper === "SUCCESS" ? COLORS.green
      : upper === "WARN" ? COLORS.yellow
        : upper === "ERROR" ? COLORS.red
          : upper === "INFO" ? COLORS.cyan
            : "";
  const reset = color ? COLORS.reset : "";
  console.log(`${new Date().toISOString()} ${color}${plainLevel}${reset} ${message}${suffix}`);
}

function verboseEnabled() {
  return process.env.RPOW_VERBOSE === "1" || globalThis.__RPOW_VERBOSE__ === true;
}

function debugLog(message, data) {
  if (verboseEnabled()) log("info", message, data);
}

function formatLogData(data) {
  if (data === null || typeof data !== "object") return String(data);
  return Object.entries(data).map(([key, value]) => {
    if (value === undefined) return null;
    if (value === null) return `${key}=null`;
    if (typeof value === "object") return `${key}=${JSON.stringify(value)}`;
    const text = String(value);
    return /^[A-Za-z0-9._:/?=-]+$/.test(text) ? `${key}=${text}` : `${key}=${JSON.stringify(text)}`;
  }).filter(Boolean).join(" ");
}

function safeUrlForLog(url) {
  return `${url.origin}${url.pathname}${url.search ? "?..." : ""}`;
}

function retryAfterMs(headers) {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function isAuthRequest(method, url) {
  return method === "POST" && url.pathname === "/auth/request";
}

function looksLikeProviderRateLimit(err) {
  return err.status === 429
    || err.code === "RATE_LIMITED"
    || /too many requests|rate limit|try again/i.test(err.message || "");
}

function errorCode(err) {
  return err?.code || err?.cause?.code || err?.cause?.cause?.code;
}

function isTransientNetworkError(err) {
  const code = errorCode(err);
  return err?.name === "AbortError"
    || err?.message === "fetch failed"
    || [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code);
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function saveState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function appendJsonLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort: Windows and some filesystems may not support chmod.
  }
}

function ensureMinerId(client, requestedMinerId) {
  if (requestedMinerId) {
    client.state.miner_id = String(requestedMinerId);
    client.save();
    return client.state.miner_id;
  }
  if (!client.state.miner_id) {
    client.state.miner_id = crypto.randomUUID();
    client.save();
  }
  return client.state.miner_id;
}

function discoverFromIndex(indexFile) {
  const js = fs.readFileSync(indexFile, "utf8");
  const apiOrigin = /const\s+\w+\s*=\s*"([^"]+)";\s*async function\s+\w+\(\w+,\s*\w+,\s*\w+\)/.exec(js)?.[1]
    || DEFAULT_API_ORIGIN;
  const endpoints = [...js.matchAll(/(\w+):\s*(?:(?:\(\)|\w+)\s*=>\s*)?\w+\("([A-Z]+)",\s*"([^"]+)"/g)]
    .map((m) => ({ name: m[1], method: m[2], path: m[3] }));
  const workerPath = /new URL\("([^"]*miner\.worker-[^"]+\.js)"/.exec(js)?.[1] || null;
  return { apiOrigin, endpoints, workerPath };
}

function printApiMap(discovered) {
  console.log(`API origin: ${discovered.apiOrigin}`);
  console.log("Browser request defaults: credentials=include, JSON content-type only when body exists.");
  console.log("Sequence:");
  console.log("1. POST /auth/request { email } -> sends magic link, no browser UI needed.");
  console.log("2. Open/fetch magic link -> server sets session cookie; CLI stores Set-Cookie values.");
  console.log("3. GET /me -> verifies session and balance.");
  console.log("4. POST /challenge -> { challenge_id, nonce_prefix, difficulty_bits }.");
  console.log("5. Mine locally with node, native C, or CUDA: SHA-256(nonce_prefix || uint64-le nonce), accept trailing zero bits >= difficulty_bits.");
  console.log("6. POST /mint { challenge_id, solution_nonce } -> mints/claims token.");
  console.log("7. Repeat from /challenge for more tokens; no separate commit/reveal endpoint is used by this site.");
  console.log("Endpoints found in index.js:");
  for (const e of discovered.endpoints) console.log(`- ${e.name}: ${e.method} ${e.path}`);
  if (discovered.workerPath) console.log(`Worker: ${discovered.workerPath}`);
}

function assertSafeUrl(rawUrl, apiOrigin) {
  const url = new URL(rawUrl, apiOrigin);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error(`blocked non-http URL: ${rawUrl}`);
  if (!SAFE_HOSTS.has(url.hostname)) throw new Error(`blocked host outside site/API allowlist: ${url.hostname}`);
  return url;
}

function cookieHeader(cookies = {}) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function parseCookieHeader(header) {
  let trimmed = header.trim();
  if (!trimmed) throw new Error("cookie file is empty");
  if (/[\r\n]/.test(trimmed)) throw new Error("cookie file must contain a single Cookie header line");
  const curlHeader = /^(?:-H|--header)\s+(['"]?)(cookie:\s*.+)\1$/i.exec(trimmed);
  if (curlHeader) trimmed = curlHeader[2];
  trimmed = trimmed.replace(/^cookie:\s*/i, "");

  const cookies = {};
  for (const part of trimmed.split(";")) {
    const pair = part.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error("cookie file must contain a Cookie header, not Set-Cookie attributes");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/^(domain|path|expires|max-age|samesite|secure|httponly)$/i.test(name)) {
      throw new Error("cookie file must contain a Cookie header, not Set-Cookie attributes");
    }
    if (!name) throw new Error("cookie file contains a cookie without a name");
    cookies[name] = value;
  }
  if (Object.keys(cookies).length === 0) throw new Error("cookie file does not contain any cookies");
  if (cookies.name === "value" && cookies.another === "value") {
    throw new Error("cookie file still contains the example placeholder; replace it with your real Cookie header");
  }
  return cookies;
}

function importCookieFile(client, cookieFile) {
  const file = path.resolve(process.cwd(), cookieFile);
  const cookies = parseCookieHeader(fs.readFileSync(file, "utf8"));
  client.state.cookies = cookies;
  client.state.cookies_imported_at = new Date().toISOString();
  client.save();
  log("success", "cookies imported", { count: Object.keys(cookies).length, has_rpow_session: Boolean(cookies.rpow_session) });
  if (!cookies.rpow_session) {
    log("warn", "cookie file does not contain rpow_session; /me will probably return 401");
  }
}

function printCookieFileInfo(cookieFile) {
  const file = path.resolve(process.cwd(), cookieFile);
  const cookies = parseCookieHeader(fs.readFileSync(file, "utf8"));
  const names = Object.keys(cookies).sort();
  log("info", "cookie file", {
    count: names.length,
    has_rpow_session: Boolean(cookies.rpow_session),
    names: names.join(","),
  });
}

function storeSetCookies(state, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;
  state.cookies ||= {};
  for (const header of setCookieHeaders) {
    const first = header.split(";", 1)[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (value) state.cookies[name] = value;
    else delete state.cookies[name];
  }
}

function responseSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

class RpowClient {
  constructor(options) {
    this.apiOrigin = options.apiOrigin;
    this.siteOrigin = options.siteOrigin;
    this.stateFile = options.stateFile;
    this.state = loadState(this.stateFile);
    this.timeoutMs = Number(options.timeoutMs || 20000);
    this.maxRetries = Number(options.retries || 5);
    this.retryDelayMs = Number(options.retryDelayMs || 2000);
  }

  save() {
    this.state.updated_at = new Date().toISOString();
    saveState(this.stateFile, this.state);
  }

  async request(method, urlOrPath, body, options = {}) {
    const url = assertSafeUrl(urlOrPath, this.apiOrigin);
    let attempt = 0;
    while (true) {
      attempt += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const started = Date.now();
      try {
        const headers = {
          "accept": "application/json, text/plain, */*",
          "origin": this.siteOrigin,
          "referer": `${this.siteOrigin}/`,
          "user-agent": "rpow-cli/1.0",
        };
        const cookies = cookieHeader(this.state.cookies);
        if (cookies) headers.cookie = cookies;
        let payload;
        if (body !== undefined) {
          headers["content-type"] = "application/json";
          payload = JSON.stringify(body);
        }
        debugLog("HTTP ->", {
          method,
          url: safeUrlForLog(url),
          attempt,
          has_body: body !== undefined,
          has_cookie: Boolean(headers.cookie),
        });
        const res = await fetch(url, {
          method,
          headers,
          body: payload,
          redirect: options.redirect || "manual",
          signal: controller.signal,
        });
        storeSetCookies(this.state, responseSetCookies(res.headers));
        this.save();
        const text = await res.text();
        const parsed = text ? tryJson(text) : undefined;
        debugLog("HTTP <-", {
          method,
          url: safeUrlForLog(url),
          attempt,
          status: res.status,
          ms: Date.now() - started,
          set_cookie: responseSetCookies(res.headers).length > 0,
          retry_after_ms: retryAfterMs(res.headers),
        });
        if (res.status === 401 && options.allowUnauthorized !== true) {
          const err = new Error(parsed?.message || "login required");
          err.code = "UNAUTHORIZED";
          err.status = res.status;
          throw err;
        }
        if (!res.ok && ![301, 302, 303, 307, 308].includes(res.status)) {
          const err = new Error(parsed?.message || res.statusText || `HTTP ${res.status}`);
          err.status = res.status;
          err.code = parsed?.error;
          err.retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
          if (isAuthRequest(method, url) && looksLikeProviderRateLimit(err)) {
            err.retryable = false;
            err.cooldownMs = Math.max(retryAfterMs(res.headers) || 0, 60000);
          }
          err.retryAfterMs = retryAfterMs(res.headers);
          throw err;
        }
        return { res, data: parsed ?? text };
      } catch (err) {
        if (isAuthRequest(method, url) && looksLikeProviderRateLimit(err)) {
          const waitSeconds = Math.ceil((err.cooldownMs || 60000) / 1000);
          const e = new Error(`magic-link request is rate-limited; wait at least ${waitSeconds}s before running login again`);
          e.code = err.code || "RATE_LIMITED";
          e.status = err.status;
          throw e;
        }
        const retryable = err.retryable || isTransientNetworkError(err);
        if (!retryable || attempt > this.maxRetries) throw err;
        const delay = Math.max(this.retryDelayMs, Math.min(err.retryAfterMs || 0, 60000));
        log("warn", `request failed, retrying in ${delay}ms`, {
          method,
          url: safeUrlForLog(url),
          attempt,
          status: err.status,
          code: errorCode(err),
          error: err.message,
        });
        await sleep(delay);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async followMagicLink(link) {
    let url = assertSafeUrl(link, this.apiOrigin).href;
    for (let i = 0; i < 8; i += 1) {
      const { res, data } = await this.request("GET", url, undefined, { redirect: "manual", allowUnauthorized: true });
      const location = res.headers.get("location");
      log("info", "magic-link step", { status: res.status, location: location ? safeUrlForLog(assertSafeUrl(location, url)) : null });
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) return data;
      url = assertSafeUrl(location, url).href;
    }
    throw new Error("too many redirects while completing magic link");
  }

  async api(method, pathName, body, options) {
    return (await this.request(method, pathName, body, options)).data;
  }
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) throw new Error(`bad nonce_prefix hex: ${hex}`);
  return Buffer.from(hex, "hex");
}

function nonceLe64(nonce) {
  const out = Buffer.allocUnsafe(8);
  let n = BigInt(nonce);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function trailingZeroBits(buf) {
  let bits = 0;
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    const byte = buf[i];
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte & (1 << bit)) === 0) bits += 1;
      else return bits;
    }
  }
  return bits;
}

function solutionDigestHex(challenge, nonce) {
  return crypto.createHash("sha256")
    .update(hexToBytes(challenge.nonce_prefix))
    .update(nonceLe64(BigInt(nonce)))
    .digest("hex");
}

function buildMintReceipt({ minerId, account, challenge, solution, result, engine, workers, engineOptions = {} }) {
  const digest = solutionDigestHex(challenge, solution.solution_nonce);
  const receipt = {
    version: 1,
    accepted_at: new Date().toISOString(),
    miner_id: minerId,
    host: os.hostname(),
    pid: process.pid,
    account_email: account?.email || null,
    engine,
    workers,
    engine_options: engineOptions,
    challenge_id: challenge.challenge_id,
    nonce_prefix: challenge.nonce_prefix,
    difficulty_bits: challenge.difficulty_bits,
    solution_nonce: solution.solution_nonce,
    solution_digest: digest,
    verified_trailing_zero_bits: trailingZeroBits(Buffer.from(digest, "hex")),
    hashes: solution.hashes,
    speed: solution.speed,
    elapsed_ms: solution.elapsed_ms,
    token: result?.token || result,
  };
  receipt.receipt_hash = crypto.createHash("sha256")
    .update(JSON.stringify(receipt))
    .digest("hex");
  return receipt;
}

function defaultWorkerCount() {
  return Math.max(1, Math.min(os.cpus().length - 1, os.cpus().length, 8));
}

function nativeMinerPath() {
  return NATIVE_MINER_CANDIDATES.find((file) => fs.existsSync(file)) || null;
}

function cudaMinerPath() {
  return CUDA_MINER_CANDIDATES.find((file) => fs.existsSync(file)) || null;
}

function mineSolutionSingleThread(challenge, state, stateFile, logEveryMs) {
  const prefix = hexToBytes(challenge.nonce_prefix);
  const difficulty = Number(challenge.difficulty_bits);
  const expiresAt = challenge.expires_at ? Date.parse(challenge.expires_at) : null;
  const cutoffAt = Number.isFinite(expiresAt) ? expiresAt - 5000 : null;
  let nonce = BigInt(state.mining?.nonce || "0");
  let hashes = BigInt(state.mining?.hashes || "0");
  const started = Date.now();
  let lastLog = started;
  while (true) {
    if (cutoffAt && Date.now() >= cutoffAt) {
      const err = new Error("challenge expired before a solution was found");
      err.code = "CHALLENGE_EXPIRED";
      err.retryable = true;
      throw err;
    }
    const digest = crypto.createHash("sha256").update(prefix).update(nonceLe64(nonce)).digest();
    if (trailingZeroBits(digest) >= difficulty) {
      state.mining = { ...state.mining, nonce: nonce.toString(), hashes: hashes.toString(), found_at: new Date().toISOString() };
      saveState(stateFile, state);
      return { solution_nonce: nonce.toString(), hashes: hashes.toString(), digest: digest.toString("hex") };
    }
    nonce += 1n;
    hashes += 1n;
    const now = Date.now();
    if (now - lastLog >= logEveryMs) {
      const seconds = Math.max(1, (now - started) / 1000);
      const rate = Number(hashes) / seconds;
      state.mining = { challenge_id: challenge.challenge_id, nonce: nonce.toString(), hashes: hashes.toString(), difficulty_bits: difficulty };
      saveState(stateFile, state);
      log("info", "mining progress", {
        hashes: hashes.toString(),
        nonce: nonce.toString(),
        rate_mhs: `${(rate / 1_000_000).toFixed(2)} MH/s`,
        rate_hps: Math.round(rate),
      });
      lastLog = now;
    }
  }
}

function mineSolutionParallel(challenge, state, stateFile, logEveryMs, workerCount) {
  if (workerCount <= 1) return Promise.resolve(mineSolutionSingleThread(challenge, state, stateFile, logEveryMs));

  return new Promise((resolve, reject) => {
    const difficulty = Number(challenge.difficulty_bits);
    const expiresAt = challenge.expires_at ? Date.parse(challenge.expires_at) : null;
    const cutoffAt = Number.isFinite(expiresAt) ? expiresAt - 5000 : null;
    const startNonce = BigInt(state.mining?.nonce || "0");
    const started = Date.now();
    const workers = [];
    const workerStats = new Map();
    let settled = false;
    let lastSavedNonce = startNonce;

    function cleanup() {
      for (const worker of workers) worker.terminate().catch(() => {});
    }

    function totalHashes() {
      let total = 0n;
      for (const stats of workerStats.values()) total += BigInt(stats.hashes || "0");
      return total;
    }

    function maxNonce() {
      let max = lastSavedNonce;
      for (const stats of workerStats.values()) {
        if (!stats.nonce) continue;
        const n = BigInt(stats.nonce);
        if (n > max) max = n;
      }
      return max;
    }

    const progressTimer = setInterval(() => {
      if (settled) return;
      const hashes = totalHashes();
      const seconds = Math.max(1, (Date.now() - started) / 1000);
      const rate = Number(hashes) / seconds;
      lastSavedNonce = maxNonce();
      state.mining = {
        challenge_id: challenge.challenge_id,
        nonce: lastSavedNonce.toString(),
        hashes: hashes.toString(),
        difficulty_bits: difficulty,
        workers: workerCount,
      };
      saveState(stateFile, state);
      log("info", "mining progress", {
        hashes: hashes.toString(),
        nonce: lastSavedNonce.toString(),
        workers: workerCount,
        rate_mhs: `${(rate / 1_000_000).toFixed(2)} MH/s`,
        rate_hps: Math.round(rate),
      });
    }, logEveryMs);

    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(MINER_WORKER, {
        workerData: {
          noncePrefix: challenge.nonce_prefix,
          difficultyBits: difficulty,
          startNonce: (startNonce + BigInt(i)).toString(),
          stride: String(workerCount),
          cutoffAt,
          progressEveryMs: Math.max(500, Math.floor(logEveryMs / 2)),
        },
      });
      workers.push(worker);
      workerStats.set(i, { hashes: "0", nonce: (startNonce + BigInt(i)).toString() });

      worker.on("message", (message) => {
        if (settled) return;
        if (message.hashes !== undefined || message.nonce !== undefined) {
          workerStats.set(i, {
            hashes: message.hashes ?? workerStats.get(i)?.hashes ?? "0",
            nonce: message.nonce ?? workerStats.get(i)?.nonce,
          });
        }
        if (message.type === "found") {
          settled = true;
          clearInterval(progressTimer);
          cleanup();
          const hashes = totalHashes();
          const seconds = Math.max(0.001, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            ...state.mining,
            nonce: message.solution_nonce,
            hashes: hashes.toString(),
            found_at: new Date().toISOString(),
            workers: workerCount,
          };
          saveState(stateFile, state);
          resolve({
            solution_nonce: message.solution_nonce,
            hashes: hashes.toString(),
            digest: message.digest,
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
            elapsed_ms: Date.now() - started,
          });
        }
        if (message.type === "expired") {
          settled = true;
          clearInterval(progressTimer);
          cleanup();
          const err = new Error("challenge expired before a solution was found");
          err.code = "CHALLENGE_EXPIRED";
          err.retryable = true;
          reject(err);
        }
      });

      worker.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearInterval(progressTimer);
        cleanup();
        reject(err);
      });

      worker.on("exit", (code) => {
        if (!settled && code !== 0) {
          settled = true;
          clearInterval(progressTimer);
          cleanup();
          reject(new Error(`miner worker exited with code ${code}`));
        }
      });
    }
  });
}

function mineSolutionNative(challenge, state, stateFile, logEveryMs, workerCount) {
  const nativeMiner = nativeMinerPath();
  if (!nativeMiner) {
    throw new Error(`native miner not built; expected one of: ${NATIVE_MINER_CANDIDATES.join(", ")}`);
  }
  return new Promise((resolve, reject) => {
    const difficulty = Number(challenge.difficulty_bits);
    const expiresAt = challenge.expires_at ? Date.parse(challenge.expires_at) : null;
    const cutoffAt = Number.isFinite(expiresAt) ? expiresAt - 5000 : 0;
    const startNonce = BigInt(state.mining?.nonce || "0");
    const started = Date.now();
    let settled = false;
    let stderr = "";

    const child = spawn(nativeMiner, [
      "--prefix", challenge.nonce_prefix,
      "--difficulty", String(difficulty),
      "--workers", String(workerCount),
      "--start", startNonce.toString(),
      "--cutoff-ms", String(cutoffAt || 0),
      "--progress-ms", String(logEveryMs),
    ], { windowsHide: true });

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          log("warn", "native miner emitted non-json line", { line });
          continue;
        }
        if (message.type === "progress") {
          const hashes = BigInt(message.hashes || "0");
          const seconds = Math.max(1, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            challenge_id: challenge.challenge_id,
            nonce: message.nonce,
            hashes: hashes.toString(),
            difficulty_bits: difficulty,
            workers: workerCount,
            engine: "native",
          };
          saveState(stateFile, state);
          log("info", "mining", {
            hashes: hashes.toString(),
            nonce: message.nonce,
            workers: workerCount,
            engine: "native",
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
          });
        }
        if (message.type === "found") {
          settled = true;
          const hashes = BigInt(message.hashes || "0");
          const seconds = Math.max(0.001, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            ...state.mining,
            nonce: message.solution_nonce,
            hashes: message.hashes,
            found_at: new Date().toISOString(),
            workers: workerCount,
            engine: "native",
          };
          saveState(stateFile, state);
          resolve({
            solution_nonce: message.solution_nonce,
            hashes: message.hashes,
            digest: message.digest,
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
            elapsed_ms: Date.now() - started,
          });
        }
        if (message.type === "expired") {
          settled = true;
          const err = new Error("challenge expired before a solution was found");
          err.code = "CHALLENGE_EXPIRED";
          err.retryable = true;
          reject(err);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0) return;
      reject(new Error(`native miner exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function mineSolutionCuda(challenge, state, stateFile, logEveryMs, options) {
  const cudaMiner = cudaMinerPath();
  if (!cudaMiner) {
    throw new Error(`CUDA miner not built; expected one of: ${CUDA_MINER_CANDIDATES.join(", ")}`);
  }
  return new Promise((resolve, reject) => {
    const difficulty = Number(challenge.difficulty_bits);
    const expiresAt = challenge.expires_at ? Date.parse(challenge.expires_at) : null;
    const cutoffAt = Number.isFinite(expiresAt) ? expiresAt - 5000 : 0;
    const startNonce = BigInt(state.mining?.nonce || "0");
    const device = Number(options.device || 0);
    const batchSize = String(options.batchSize || 67_108_864);
    const blocks = options.blocks ? String(options.blocks) : null;
    const started = Date.now();
    let settled = false;
    let stderr = "";

    const child = spawn(cudaMiner, [
      "--prefix", challenge.nonce_prefix,
      "--difficulty", String(difficulty),
      "--device", String(device),
      "--batch-size", batchSize,
      ...(blocks ? ["--blocks", blocks] : []),
      "--start", startNonce.toString(),
      "--cutoff-ms", String(cutoffAt || 0),
      "--progress-ms", String(logEveryMs),
    ], { windowsHide: true });

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          log("warn", "CUDA miner emitted non-json line", { line });
          continue;
        }
        if (message.type === "progress") {
          const hashes = BigInt(message.hashes || "0");
          const seconds = Math.max(1, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            challenge_id: challenge.challenge_id,
            nonce: message.nonce,
            hashes: hashes.toString(),
            difficulty_bits: difficulty,
            engine: "cuda",
            cuda_device: device,
            cuda_batch_size: batchSize,
            cuda_blocks: blocks || "auto",
          };
          saveState(stateFile, state);
          log("info", "mining", {
            hashes: hashes.toString(),
            nonce: message.nonce,
            device,
            engine: "cuda",
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
          });
        }
        if (message.type === "found") {
          settled = true;
          const hashes = BigInt(message.hashes || "0");
          const seconds = Math.max(0.001, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            ...state.mining,
            nonce: message.solution_nonce,
            hashes: message.hashes,
            found_at: new Date().toISOString(),
            engine: "cuda",
            cuda_device: device,
            cuda_batch_size: batchSize,
            cuda_blocks: blocks || "auto",
          };
          saveState(stateFile, state);
          resolve({
            solution_nonce: message.solution_nonce,
            hashes: message.hashes,
            digest: message.digest,
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
            elapsed_ms: Date.now() - started,
          });
        }
        if (message.type === "expired") {
          settled = true;
          const err = new Error("challenge expired before a solution was found");
          err.code = "CHALLENGE_EXPIRED";
          err.retryable = true;
          reject(err);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0) return;
      reject(new Error(`CUDA miner exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function promptLine(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(label, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  globalThis.__RPOW_VERBOSE__ = args.verbose === true;
  const command = args._[0] || "help";
  const discovered = discoverFromIndex(args.index || DEFAULT_INDEX);
  const client = new RpowClient({
    apiOrigin: args.api || discovered.apiOrigin,
    siteOrigin: args.site || DEFAULT_SITE_ORIGIN,
    stateFile: args.state || DEFAULT_STATE,
    timeoutMs: args.timeout || 20000,
    retries: args.retries || 5,
    retryDelayMs: args["retry-delay-ms"] || 2000,
  });

  if (args["cookie-file"]) importCookieFile(client, args["cookie-file"]);

  if (command === "cookies") {
    if (!args["cookie-file"]) throw new Error("cookies command requires --cookie-file PATH");
    printCookieFileInfo(args["cookie-file"]);
    return;
  }

  if (command === "map") {
    printApiMap(discovered);
    return;
  }

  if (command === "login") {
    const email = args.email || await promptLine("email: ");
    await client.api("POST", "/auth/request", { email });
    client.state.email = email;
    client.state.login_requested_at = new Date().toISOString();
    client.save();
    log("success", "magic link requested; run complete-login with the emailed URL");
    return;
  }

  if (command === "complete-login") {
    const link = args.link || await promptLine("magic link: ");
    await client.followMagicLink(link);
    const me = await client.api("GET", "/me");
    log("success", "session active", me);
    return;
  }

  if (command === "me") {
    log("info", "me", await client.api("GET", "/me"));
    return;
  }

  if (command === "ledger") {
    log("info", "ledger", await client.api("GET", "/ledger", undefined, { allowUnauthorized: true }));
    return;
  }

  if (command === "activity") {
    log("info", "activity", await client.api("GET", "/activity"));
    return;
  }

  if (command === "send") {
    const recipient = args.to || await promptLine("recipient email: ");
    const amount = Number(args.amount || await promptLine("amount: "));
    const idempotency_key = args.idempotency || crypto.randomUUID();
    log("success", "send result", await client.api("POST", "/send", { recipient_email: recipient, amount, idempotency_key }));
    return;
  }

  if (command === "logout") {
    await client.api("POST", "/auth/logout");
    client.state.cookies = {};
    client.save();
    log("success", "logged out");
    return;
  }

  if (command === "pool-test") {
    const total = Number(args.challenges || args.count || 10);
    const engine = args.engine || "cuda";
    const cudaDevice = Number(args["cuda-device"] || 0);
    const cudaBatchSize = args["cuda-batch-size"] || 1_073_741_824;
    const cudaBlocks = args["cuda-blocks"] || null;
    const logEveryMs = Number(args["log-every-ms"] || 1000);
    const minerId = ensureMinerId(client, args["miner-id"] || `pool-test-${os.hostname()}`);
    const mintLogFile = path.resolve(process.cwd(), args["mint-log"] || DEFAULT_MINT_LOG);
    if (!Number.isInteger(total) || total < 1) throw new Error("--challenges must be a positive integer");
    if (engine !== "cuda") throw new Error("pool-test currently supports --engine cuda only");
    if (!Number.isInteger(cudaDevice) || cudaDevice < 0) throw new Error("--cuda-device must be a non-negative integer");
    if (!Number.isInteger(Number(cudaBatchSize)) || Number(cudaBatchSize) < 1) throw new Error("--cuda-batch-size must be a positive integer");
    if (cudaBlocks !== null && (!Number.isInteger(Number(cudaBlocks)) || Number(cudaBlocks) < 1)) throw new Error("--cuda-blocks must be a positive integer");

    const account = await client.api("GET", "/me");
    const batchId = crypto.randomUUID();
    const challenges = [];
    const solved = [];
    const summary = { requested: 0, solved: 0, accepted: 0, mint_failed: 0, solve_failed: 0 };
    const failures = {};
    log("info", "pool-test start", {
      batch_id: batchId,
      challenges: total,
      engine,
      cuda_device: cudaDevice,
      cuda_batch_size: cudaBatchSize,
      cuda_blocks: cudaBlocks || "auto",
      miner_id: minerId,
    });

    for (let i = 0; i < total; i += 1) {
      const challenge = await client.api("POST", "/challenge");
      challenges.push(challenge);
      summary.requested += 1;
      log("info", "pool-test challenge", {
        index: i + 1,
        total,
        id: challenge.challenge_id,
        difficulty: `${challenge.difficulty_bits} bits`,
        expires: challenge.expires_at,
      });
    }

    for (let i = 0; i < challenges.length; i += 1) {
      const challenge = challenges[i];
      client.state.mining = { challenge_id: challenge.challenge_id, nonce: "0", hashes: "0", difficulty_bits: challenge.difficulty_bits, engine: "cuda" };
      client.save();
      try {
        log("info", "pool-test solve", { index: i + 1, total, id: challenge.challenge_id });
        const solution = await mineSolutionCuda(challenge, client.state, client.stateFile, logEveryMs, {
          device: cudaDevice,
          batchSize: cudaBatchSize,
          blocks: cudaBlocks,
        });
        solved.push({ challenge, solution });
        summary.solved += 1;
        log("info", "pool-test solved", {
          index: i + 1,
          total,
          id: challenge.challenge_id,
          nonce: solution.solution_nonce,
          hashes: solution.hashes,
          speed: solution.speed,
        });
      } catch (err) {
        summary.solve_failed += 1;
        const key = err.code || String(err.status || "SOLVE_FAILED");
        failures[key] = (failures[key] || 0) + 1;
        log("warn", "pool-test solve failed", { id: challenge.challenge_id, error: err.message, code: err.code, status: err.status });
      }
    }

    for (let i = 0; i < solved.length; i += 1) {
      const { challenge, solution } = solved[i];
      try {
        log("info", "pool-test mint", { index: i + 1, total: solved.length, id: challenge.challenge_id });
        const result = await client.api("POST", "/mint", {
          challenge_id: challenge.challenge_id,
          solution_nonce: solution.solution_nonce,
        });
        summary.accepted += 1;
        const receipt = buildMintReceipt({
          minerId,
          account,
          challenge,
          solution,
          result,
          engine,
          workers: 0,
          engineOptions: {
            pool_test: true,
            batch_id: batchId,
            cuda_device: cudaDevice,
            cuda_batch_size: String(cudaBatchSize),
            cuda_blocks: cudaBlocks ? String(cudaBlocks) : "auto",
          },
        });
        appendJsonLine(mintLogFile, receipt);
        log("success", "pool-test mint accepted", {
          token_id: receipt.token?.id,
          challenge_id: receipt.challenge_id,
          solution_nonce: receipt.solution_nonce,
          receipt_hash: receipt.receipt_hash,
        });
      } catch (err) {
        summary.mint_failed += 1;
        const key = err.code || String(err.status || "MINT_FAILED");
        failures[key] = (failures[key] || 0) + 1;
        log("warn", "pool-test mint failed", { id: challenge.challenge_id, error: err.message, code: err.code, status: err.status });
      }
    }

    client.state.challenge = null;
    client.state.mining = null;
    client.save();
    log("success", "pool-test complete", { ...summary, failures });
    return;
  }

  if (command === "mine" || command === "run") {
    const target = Number(args.count || args.tokens || 1);
    const workers = Number(args.workers || defaultWorkerCount());
    const engine = args.engine || (nativeMinerPath() ? "native" : "node");
    const logEveryMs = Number(args["log-every-ms"] || (["native", "cuda"].includes(engine) ? 1000 : 5000));
    const minerId = ensureMinerId(client, args["miner-id"]);
    const mintLogFile = path.resolve(process.cwd(), args["mint-log"] || DEFAULT_MINT_LOG);
    const cudaDevice = Number(args["cuda-device"] || 0);
    const cudaBatchSize = args["cuda-batch-size"] || 1_073_741_824;
    const cudaBlocks = args["cuda-blocks"] || null;
    if (!Number.isInteger(workers) || workers < 1) throw new Error("--workers must be a positive integer");
    if (!["native", "node", "cuda"].includes(engine)) throw new Error("--engine must be native, node, or cuda");
    if (engine === "cuda" && (!Number.isInteger(cudaDevice) || cudaDevice < 0)) throw new Error("--cuda-device must be a non-negative integer");
    if (engine === "cuda" && (!Number.isInteger(Number(cudaBatchSize)) || Number(cudaBatchSize) < 1)) throw new Error("--cuda-batch-size must be a positive integer");
    if (engine === "cuda" && cudaBlocks !== null && (!Number.isInteger(Number(cudaBlocks)) || Number(cudaBlocks) < 1)) throw new Error("--cuda-blocks must be a positive integer");
    let minted = 0;
    const account = await client.api("GET", "/me");
    log("info", "miner identity", { miner_id: minerId, mint_log: mintLogFile });
    while (minted < target) {
      let challenge = client.state.challenge;
      const challengeExpiresAt = challenge?.expires_at ? Date.parse(challenge.expires_at) : null;
      const challengeExpired = Number.isFinite(challengeExpiresAt) && Date.now() >= challengeExpiresAt - 5000;
      if (!challenge || challengeExpired || client.state.mining?.challenge_id !== challenge.challenge_id || args.fresh) {
        if (challengeExpired) log("warn", "saved challenge expired; requesting a fresh one", { challenge_id: challenge.challenge_id });
        challenge = await client.api("POST", "/challenge");
        client.state.challenge = challenge;
        client.state.mining = { challenge_id: challenge.challenge_id, nonce: "0", hashes: "0", difficulty_bits: challenge.difficulty_bits };
        client.save();
      }
      log("info", "challenge", {
        id: challenge.challenge_id,
        difficulty: `${challenge.difficulty_bits} bits`,
        expires: challenge.expires_at,
      });
      let solution;
      try {
        log("info", "miner config", {
          workers: engine === "cuda" ? undefined : workers,
          engine,
          cuda_device: engine === "cuda" ? cudaDevice : undefined,
          cuda_batch_size: engine === "cuda" ? cudaBatchSize : undefined,
          cuda_blocks: engine === "cuda" ? (cudaBlocks || "auto") : undefined,
        });
        solution = engine === "cuda"
          ? await mineSolutionCuda(challenge, client.state, client.stateFile, logEveryMs, { device: cudaDevice, batchSize: cudaBatchSize, blocks: cudaBlocks })
          : engine === "native"
            ? await mineSolutionNative(challenge, client.state, client.stateFile, logEveryMs, workers)
            : await mineSolutionParallel(challenge, client.state, client.stateFile, logEveryMs, workers);
      } catch (err) {
        if (err.code === "CHALLENGE_EXPIRED") {
          log("warn", "challenge expired during mining; requesting a fresh one");
          client.state.challenge = null;
          client.state.mining = null;
          client.save();
          continue;
        }
        throw err;
      }
      log("info", "solution found", {
        nonce: solution.solution_nonce,
        hashes: solution.hashes,
        speed: solution.speed,
        elapsed_ms: solution.elapsed_ms,
      });
      try {
        const result = await client.api("POST", "/mint", {
          challenge_id: challenge.challenge_id,
          solution_nonce: solution.solution_nonce,
        });
        minted += 1;
        const receipt = buildMintReceipt({
          minerId,
          account,
          challenge,
          solution,
          result,
          engine,
          workers,
          engineOptions: engine === "cuda" ? { cuda_device: cudaDevice, cuda_batch_size: String(cudaBatchSize), cuda_blocks: cudaBlocks ? String(cudaBlocks) : "auto" } : {},
        });
        appendJsonLine(mintLogFile, receipt);
        client.state.last_mint = result;
        client.state.last_mint_receipt_hash = receipt.receipt_hash;
        client.state.challenge = null;
        client.state.mining = null;
        client.save();
        log("success", "mint/claim accepted", {
          token_id: receipt.token?.id,
          miner_id: receipt.miner_id,
          challenge_id: receipt.challenge_id,
          solution_nonce: receipt.solution_nonce,
          receipt_hash: receipt.receipt_hash,
          mint_log: mintLogFile,
        });
        log("success", "mint progress", { minted, target, remaining: Math.max(0, target - minted) });
      } catch (err) {
        if (err.code === "UNAUTHORIZED") {
          log("warn", "session invalid; rerun login/complete-login, then rerun mine to resume");
          throw err;
        }
        log("warn", "mint failed; dropping challenge and continuing with a fresh one", { error: err.message, code: err.code, status: err.status });
        client.state.challenge = null;
        client.state.mining = null;
        client.save();
      }
    }
    log("success", "pipeline complete", { minted, target, remaining: Math.max(0, target - minted) });
    return;
  }

  console.log(`Usage:
  node rpow-cli.js map
  node rpow-cli.js login --email you@example.com
  node rpow-cli.js complete-login --link "https://..."
  node rpow-cli.js cookies --cookie-file .rpow-cookies.txt
  node rpow-cli.js me
  node rpow-cli.js pool-test --challenges 10 --engine cuda --cuda-device 0
  node rpow-cli.js mine --count 1 --engine native
  node rpow-cli.js run --count 3 --engine native
  node rpow-cli.js send --to user@example.com --amount 1
  node rpow-cli.js ledger
  node rpow-cli.js activity
  node rpow-cli.js logout

Options:
  --state .rpow-cli-state.json
  --cookie-file .rpow-cookies.txt
  --timeout 20000
  --retries 5
  --retry-delay-ms 2000
  --log-every-ms 5000
  --workers ${defaultWorkerCount()}
  --engine native|node|cuda  (native C miner recommended; cuda for NVIDIA GPUs)
  --cuda-device 0
  --cuda-batch-size 1073741824
  --cuda-blocks auto
  --verbose`);
}

main().catch((err) => {
  log("error", err.message, { code: err.code, status: err.status });
  process.exitCode = 1;
});
