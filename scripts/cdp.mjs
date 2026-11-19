/**
 * A small CDP client for inspecting the running Electron app.
 *
 * Usage:
 *   node scripts/cdp.mjs shot <out.png> [width] [height]
 *   node scripts/cdp.mjs eval "<js expression>"
 *   node scripts/cdp.mjs click "<selector>"
 *   node scripts/cdp.mjs text "<selector>"
 *   node scripts/cdp.mjs size <w> <h>
 */
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;

async function target() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  return page;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

let id = 0;
function send(ws, method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== msgId) return;
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

const [, , cmd, ...args] = process.argv;
const page = await target();
const ws = await connect(page.webSocketDebuggerUrl);

try {
  if (cmd === 'shot') {
    const [out, w, h] = args;
    if (w && h) {
      await send(ws, 'Emulation.setDeviceMetricsOverride', {
        width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false,
      });
      await new Promise((r) => setTimeout(r, 600));
    }
    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log('saved', out);
  } else if (cmd === 'size') {
    const [w, h] = args;
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
      width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 700));
    console.log('resized', w, h);
  } else if (cmd === 'eval') {
    const expr = args.join(' ');
    const res = await send(ws, 'Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    console.log(JSON.stringify(res.result?.value ?? res.result, null, 2));
  } else if (cmd === 'click') {
    const sel = args.join(' ');
    const res = await send(ws, 'Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return 'NOTFOUND'; el.click(); return 'CLICKED ' + (el.textContent||'').trim().slice(0,60); })()`,
      returnByValue: true,
    });
    console.log(res.result?.value);
    await new Promise((r) => setTimeout(r, 700));
  } else if (cmd === 'text') {
    const sel = args.join(' ');
    const res = await send(ws, 'Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : 'NOTFOUND'; })()`,
      returnByValue: true,
    });
    console.log(res.result?.value);
  } else {
    console.error('unknown command');
    process.exitCode = 1;
  }
} finally {
  ws.close();
}
