// Screenshots of the window the suite is running in, over the DevTools protocol.
//
// The extension API has no way to look at the workbench: a decoration, a lens
// title or a tree row is drawn by the renderer, and all the host can read back
// is what it handed over. The picture is what a reviewer compares -- the JSON
// says two answers differ, the picture says what the user would have seen --
// so the host asks the renderer directly, through the debugging port run.js
// opened on it.
//
// The pictures are for people. Nothing compares them pixel by pixel: a cursor
// blink or a lens resolving 50ms later would make that a coin toss, and the
// JSON beside each one is what the run is judged on.
const { writeFileSync } = require("node:fs");

/** The width and height every screenshot is taken at, on both sides. */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * The workbench page's endpoint, once the port answers.
 *
 * The port is opened by Electron before the window has loaded, and the suite
 * can be running before the list names the page -- so this asks until it does
 * rather than once.
 */
async function workbenchTarget(port) {
  const deadline = Date.now() + 15_000;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      // Webviews are pages too, and each has its own `index.html`; only the
      // workbench is the window the user looks at.
      const page = targets.find((one) => one.type === "page" && /workbench\.html/.test(one.url));
      if (page) return page;
      last = `${targets.length} targets, none of them the workbench`;
    } catch (error) {
      last = String(error.message ?? error);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`DevTools on port ${port} never offered the workbench page: ${last}`);
}

/**
 * A protocol session on the workbench page.
 *
 * Node's own WebSocket, which the extension host has had since it moved to
 * Node 22: a hand-rolled client would be a hundred lines of framing to carry
 * the one message this needs.
 */
async function connect(port) {
  if (typeof WebSocket !== "function") {
    throw new Error(`this extension host (node ${process.version}) has no global WebSocket`);
  }
  const target = await workbenchTarget(port);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools socket failed to open")), { once: true });
  });
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });
  // Every call is bounded. A renderer that stops producing frames -- the
  // window was hidden behind another -- answers a screenshot request never,
  // and one missing picture must not cost the JSON the run exists for.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no answer in 20s`));
      }, 20_000);
      pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
        method,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  // Both sides are drawn at one size, whatever the screen they happened to
  // open on. The window's own size depends on the display and on what the last
  // run left in the profile, and a side-by-side where one picture wraps the
  // Problems list and the other does not reads as a difference that is not.
  await send("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The window is on somebody's desktop and loses focus the moment they click
  // elsewhere. The editor's own Tab, paste and type handlers are guarded by
  // `editorTextFocus`, so an unfocused window turns "the toggle stopped the
  // rewrite" into "nothing happened for an unrelated reason" -- editor-diff
  // has already been bitten by exactly that.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // The workbench lays itself out on `resize`, and an emulated size does not
  // always send one.
  await send("Runtime.evaluate", { expression: "window.dispatchEvent(new Event('resize'))" });

  return {
    send,
    /** Evaluate `expression` in the workbench and return its value. */
    async evaluate(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) {
        throw new Error(`evaluate: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      }
      return result.value;
    },
    async screenshot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    /** Type `text` into whatever has focus in the workbench, input boxes included. */
    async insertText(text) {
      await send("Input.insertText", { text });
    },
    close() {
      socket.close();
    },
  };
}

module.exports = { connect, VIEWPORT };
