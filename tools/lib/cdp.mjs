// Minimal Chrome DevTools Protocol client.
//
// Frame sequences cannot be captured the way stills are. Spawning a browser per
// frame costs seconds each, which is fine for 15 slides and hopeless for 30 fps.
// This keeps one browser alive and steps it frame by frame instead. Node 24 ships
// a global WebSocket, so talking to CDP needs no package.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

export function findBrowser() {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error(`no Chromium browser found; looked in:\n  ${CANDIDATES.join("\n  ")}`);
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Browser {
  #proc;
  #ws;
  #profile;
  #nextId = 1;
  #pending = new Map();

  /** Anything the page threw or logged as an error, in order. */
  pageErrors = [];

  static async launch({ url, width, height, port = 9333 }) {
    const browser = new Browser();
    browser.#profile = join(tmpdir(), `rtn-cdp-${process.pid}`);

    browser.#proc = spawn(findBrowser(), [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${browser.#profile}`,
      url,
    ], { stdio: "ignore" });

    // The debugging endpoint is not ready the instant the process starts.
    let target = null;
    for (let attempt = 0; attempt < 60 && !target; attempt++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await res.json();
        target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {
        // not listening yet
      }
    }
    if (!target) throw new Error("browser did not expose a debugging target");

    browser.#ws = new WebSocket(target.webSocketDebuggerUrl);
    browser.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);

      // Surface page-side failures. Without this a broken script just looks
      // like a mysterious timeout waiting for a readiness flag.
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        browser.pageErrors.push(d.exception?.description ?? d.text);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        browser.pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
      }

      const waiting = browser.#pending.get(msg.id);
      if (!waiting) return;
      browser.#pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(`${msg.error.message} (${waiting.method})`));
      else waiting.resolve(msg.result);
    });

    await new Promise((resolve, reject) => {
      browser.#ws.addEventListener("open", resolve, { once: true });
      browser.#ws.addEventListener("error", reject, { once: true });
    });

    await browser.send("Page.enable");
    await browser.send("Runtime.enable");
    // Pin the viewport rather than trusting the window size, which the OS can
    // adjust for borders and DPI.
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });

    return browser;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page error: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ""}`);
    }
    return res.result.value;
  }

  /** Poll an expression until it is truthy. */
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      if (this.pageErrors.length > 0) {
        throw new Error(`page failed before it was ready:\n  ${this.pageErrors.join("\n  ")}`);
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `timed out waiting for: ${expression}` +
      (this.pageErrors.length ? `\npage errors:\n  ${this.pageErrors.join("\n  ")}` : ""),
    );
  }

  async screenshot() {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    return Buffer.from(data, "base64");
  }

  async close() {
    try { this.#ws?.close(); } catch { /* already gone */ }
    this.#proc?.kill();
    await sleep(300);
    rmSync(this.#profile, { recursive: true, force: true });
  }
}
