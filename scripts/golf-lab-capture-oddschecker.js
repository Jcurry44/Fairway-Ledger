#!/usr/bin/env node
/*
 * Capture rendered Oddschecker golf market pages with a local Chromium browser.
 *
 * This keeps the data path public/source-backed without requiring an odds API:
 * save the rendered DOM, then feed the snapshot into golf-lab-oddschecker-odds.
 */
const childProcess = require("node:child_process");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MARKETS = Object.freeze([
  ["top-10", "https://www.oddschecker.com/golf/us-open/top-10-finish"],
  ["top-20", "https://www.oddschecker.com/golf/us-open/top-20-finish"],
  ["make-cut", "https://www.oddschecker.com/golf/us-open/to-make-the-cut"]
]);

const DEFAULT_EDGE_PATHS = Object.freeze([
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
]);

function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function slug(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseMarketArg(value) {
  const clean = cleanString(value);
  const splitIndex = clean.indexOf("=");
  if (splitIndex > 0) {
    const key = slug(clean.slice(0, splitIndex));
    const url = clean.slice(splitIndex + 1).trim();
    if (key && url) return [key, url];
  }
  const url = clean;
  const key = slug(url.split("/").filter(Boolean).slice(-1)[0] || "market");
  return key && url ? [key, url] : null;
}

function parseArgs(argv) {
  const args = {
    outputDir: path.join("data", "golf-lab", "raw", "oddschecker"),
    date: new Date().toISOString().slice(0, 10),
    timeoutMs: 45000,
    waitMs: 9000,
    markets: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") args.outputDir = argv[index += 1];
    else if (token === "--date") args.date = argv[index += 1];
    else if (token === "--edge") args.edgePath = argv[index += 1];
    else if (token === "--timeout-ms") args.timeoutMs = Number(argv[index += 1]);
    else if (token === "--wait-ms") args.waitMs = Number(argv[index += 1]);
    else if (token === "--market") {
      const market = parseMarketArg(argv[index += 1]);
      if (market) args.markets.push(market);
    } else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = 45000;
  if (!Number.isFinite(args.waitMs) || args.waitMs < 0) args.waitMs = 9000;
  if (!args.markets.length) args.markets = [...DEFAULT_MARKETS];
  return args;
}

function usage() {
  return [
    "Usage: node scripts/golf-lab-capture-oddschecker.js [options]",
    "",
    "Options:",
    "  --out <folder>          Raw snapshot folder. Defaults to data/golf-lab/raw/oddschecker.",
    "  --date <yyyy-mm-dd>     Date suffix for files. Defaults to today.",
    "  --edge <path>           Browser executable path. Defaults to installed Edge/Chrome.",
    "  --market <key=url>      Market URL to capture. May be repeated.",
    "  --wait-ms <number>      Headless virtual wait budget. Defaults to 9000.",
    "  --timeout-ms <number>   Browser command timeout. Defaults to 45000."
  ].join("\n");
}

function findBrowserPath(explicitPath) {
  if (cleanString(explicitPath)) return explicitPath;
  return DEFAULT_EDGE_PATHS.find((candidate) => fs.existsSync(candidate)) || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method || "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${response.statusCode} ${response.statusMessage}: ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(options.timeoutMs || 5000, () => {
      request.destroy(new Error(`Timed out requesting ${url}`));
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitForCdp(port, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Browser DevTools endpoint did not start: ${lastError ? lastError.message : "timeout"}`);
}

async function createPageTarget(port) {
  try {
    return await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", timeoutMs: 5000 });
  } catch (_) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`, { timeoutMs: 5000 });
    const page = Array.isArray(targets) ? targets.find((target) => target.type === "page") : null;
    if (!page) throw new Error("No DevTools page target was available.");
    return page;
  }
}

function openCdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const timeout = setTimeout(() => reject(new Error("Timed out opening DevTools websocket.")), 10000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          const payload = JSON.stringify({ id, method, params });
          return new Promise((commandResolve, commandReject) => {
            const commandTimeout = setTimeout(() => {
              pending.delete(id);
              commandReject(new Error(`Timed out sending DevTools command: ${method}`));
            }, 15000);
            pending.set(id, { resolve: commandResolve, reject: commandReject });
            pending.set(id, {
              resolve(result) {
                clearTimeout(commandTimeout);
                commandResolve(result);
              },
              reject(error) {
                clearTimeout(commandTimeout);
                commandReject(error);
              }
            });
            socket.send(payload);
          });
        },
        close() {
          socket.close();
        }
      });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const command = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) command.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else command.resolve(message.result || {});
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("DevTools websocket failed."));
    });
  });
}

async function launchBrowser(browserPath, options) {
  const port = 9300 + Math.floor(Math.random() * 4000);
  const profileDir = path.join(os.tmpdir(), `golf-lab-edge-${Date.now()}-${process.pid}-${port}`);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "about:blank"
  ];
  const browserProcess = childProcess.spawn(browserPath, args, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  browserProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  browserProcess.on("error", (error) => {
    stderr += error.message;
  });
  const browser = {
    port,
    profileDir,
    process: browserProcess,
    stderr: () => cleanString(stderr)
  };
  try {
    await waitForCdp(port, Math.min(Number(options.timeoutMs) || 45000, 45000));
  } catch (error) {
    await closeBrowser(browser);
    throw new Error(`${error.message}${cleanString(stderr) ? `\n${cleanString(stderr)}` : ""}`);
  }
  return browser;
}

async function closeBrowser(browser) {
  if (!browser) return;
  if (browser.process && !browser.process.killed) {
    if (process.platform === "win32" && browser.process.pid) {
      await new Promise((resolve) => {
        childProcess.execFile("taskkill", ["/PID", String(browser.process.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
    } else {
      browser.process.kill();
    }
    await sleep(500);
  }
  const resolvedProfile = path.resolve(browser.profileDir || "");
  const resolvedTemp = path.resolve(os.tmpdir());
  if (resolvedProfile.startsWith(resolvedTemp) && resolvedProfile.includes("golf-lab-edge-")) {
    await fsp.rm(resolvedProfile, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForRenderedMarket(session, waitMs) {
  const startedAt = Date.now();
  let lastText = "";
  while (Date.now() - startedAt < waitMs) {
    const result = await session.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true
    });
    lastText = cleanString(result.result && result.result.value);
    if (/QuickBet/i.test(lastText) || /Scottie Scheffler/i.test(lastText)) return lastText;
    await sleep(500);
  }
  return lastText;
}

async function captureMarket(browser, market, options) {
  const [marketKey, url] = market;
  const target = await createPageTarget(browser.port);
  const session = await openCdpSession(target.webSocketDebuggerUrl);
  try {
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.navigate", { url });
    const bodyText = await waitForRenderedMarket(session, Math.max(1000, Number(options.waitMs) || 9000));
    const htmlResult = await session.send("Runtime.evaluate", {
      expression: "document.documentElement ? document.documentElement.outerHTML : ''",
      returnByValue: true
    });
    const titleResult = await session.send("Runtime.evaluate", {
      expression: "document.title || ''",
      returnByValue: true
    });
    const html = String((htmlResult.result && htmlResult.result.value) || "");
    const title = cleanString(titleResult.result && titleResult.result.value);
    const outputDir = path.resolve(options.outputDir);
    await fsp.mkdir(outputDir, { recursive: true });
    const htmlFile = path.join(outputDir, `us-open-${marketKey}-${options.date}.html`);
    const textFile = path.join(outputDir, `us-open-${marketKey}-${options.date}.txt`);
    await fsp.writeFile(htmlFile, html, "utf8");
    await fsp.writeFile(textFile, bodyText, "utf8");
    return {
      market: marketKey,
      url,
      title,
      htmlFile,
      textFile,
      htmlBytes: Buffer.byteLength(html || "", "utf8"),
      textBytes: Buffer.byteLength(bodyText || "", "utf8"),
      hasQuickBet: /QuickBet/i.test(bodyText || html),
      hasScottieScheffler: /Scottie Scheffler/i.test(bodyText || html)
    };
  } finally {
    session.close();
  }
}

async function captureOddscheckerPages(options = {}) {
  const browserPath = findBrowserPath(options.edgePath);
  if (!browserPath) throw new Error("No Edge or Chrome executable was found. Pass --edge <path>.");
  const outputDir = path.resolve(options.outputDir);
  await fsp.mkdir(outputDir, { recursive: true });
  const summaries = [];
  const browser = await launchBrowser(browserPath, options);
  try {
    for (const market of options.markets || DEFAULT_MARKETS) {
      summaries.push(await captureMarket(browser, market, options));
    }
  } finally {
    await closeBrowser(browser);
  }
  return {
    browserPath,
    outputDir,
    summaries
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const result = await captureOddscheckerPages(args);
  console.log(`Golf Lab Oddschecker snapshots captured: ${result.outputDir}`);
  result.summaries.forEach((row) => {
    console.log(`${row.market}: ${row.textBytes} text bytes | ${row.htmlBytes} html bytes | QuickBet=${row.hasQuickBet ? "yes" : "no"} | Scottie=${row.hasScottieScheffler ? "yes" : "no"}`);
  });
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  parseMarketArg,
  findBrowserPath,
  captureOddscheckerPages,
  usage
};
