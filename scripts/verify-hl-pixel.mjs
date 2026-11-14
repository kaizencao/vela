// 0.7.10 像素终验专项：DOM 全绿但屏幕不显色时，captureVisibleTab 采样链路是否
// 1) 正常页打出「像素验证通过」；2) 绘制被吃（background-clip:text + 透明文字——
//    computed backgroundColor 不变，400ms 首检照过）→ 自动增强绘制（box-shadow/outline
//    独立于 background）后恢复显色；3) 增强层也救不回（filter:brightness(0) 点名吃
//    .om-hl 渲染，含 box-shadow/outline）→ 红 toast + 「像素验证失败」日志；
// 4) 全页反色（暗色/护眼类扩展的祖先 filter 形态，computed 不变但屏幕颜色整体移相）
//    → 像素终验静默跳过（「跳过：祖先」日志），不红 toast 报拦截；
// 5) 报障 toast 内嵌采样区实际截屏缩略图（canvas）与占比/均值数字——截图 toast 即完成取证；
// 6) 同一会话复发像素报障：不重复弹窗（sessionStorage 去重），console 仍留日志。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, killTree } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9362;
const WEB = 39323;

const P = '<p id="txt">The quick brown fox jumps over the lazy dog near the river bank.</p>';
const pages = {
  normal: P,
  // opacity:0 整段透明：现在 DOM 首检直接点名（「元素链 opacity=0」），不再走像素链
  hidden: `<style>.om-hl{opacity:0 !important}</style>${P}`,
  // DOM 全绿签名的确定性复刻：filter:opacity(0) 落在 span 本身——computed backgroundColor
  // 与 opacity 均不变、命中测试照常、祖先链无 filter（首检全绿），但包括增强层
  // （box-shadow/outline）在内的整元素绘制全被透明掉 → 像素终验失败 + 证据 toast
  ghost: `<style>.om-hl{filter:opacity(0) !important}</style>${P}`,
  // 增强层被吃掉的另一种形态：brightness(0) 把整个元素渲染压黑（含 box-shadow/outline）
  dead: `<style>.om-hl{filter:brightness(0) !important}</style>${P}`,
  // 暗色/护眼类扩展的 filter 模式签名（Dark Reader filter 档同款）：祖先链整页反色，
  // computed 样式与命中测试全绿，但屏幕像素已移相——高亮看得见（变色）不该报「未生效」
  tinted: `<style>html{filter:invert(1) hue-rotate(180deg)}</style>${P}`,
  // Google 结果卡形态：标题文字在链接内且 pointer-events:none——hit-test 让给祖先 <a>，
  // elementsFromPoint 命中高亮 span 的祖先。祖先绘制在后代之下不遮挡，不该报「被 A 遮挡」。
  // 用行内 span 而非 h3：本用例验证祖先遮挡路由，混入跨块行为会稀释信号（跨块已由 xblock 专测）。
  // seed 段是起选点：Chrome 不从链接盒起选区，真实场景里用户正是从别处拖进标题的
  nested: `<a href="#x" draggable="false" style="color:inherit"><span id="txt" style="pointer-events:none">The quick brown fox jumps over the lazy dog near the river bank.</span></a><p id="seed">Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.</p>`,
  // 跨段落选区（Flink 文档实报签名，采样框 1698x212 的多行选区）：旧实现 extractContents
  // 把两个 <p> 块级片段包进一只 inline span（块内行内）——Chrome 不绘制含块级子元素的
  // 行内盒自身背景，computed 全绿但像素 0 显色。修后 wrapRangePerBlock 逐块包裹，
  // 每块一只纯行内 span，像素照常显色。
  xblock: `<p id="p1">Alpha paragraph carries the opening words of the selection and wraps onto a second visual line right here.</p><p id="p2">Beta paragraph receives the tail of the selection range and also wraps onto its own second visual line.</p>`,
};
const server = createServer((req, res) => {
  const m = req.url.match(/^\/(\w+)/);
  if (m && pages[m[1]]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><style>body{margin:40px;background:#fff;font:20px/1.6 serif}p{max-width:600px}</style></head><body>${pages[m[1]]}</body></html>`);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-pix-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `http://127.0.0.1:${WEB}/normal`,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  let msgId = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push({ level: m.params.type, text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ') });
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { send, logs, close: () => ws.close() };
}
const evalInPage = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200));
  return r?.result?.value;
};
const mouse = (sess, type, x, y) => sess.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, pointerType: 'mouse', clickCount: 1 });

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed = 1; };

async function runCase(sess, path, { wait = 3500, keepFlag = false } = {}) {
  await sess.send('Page.navigate', { url: `http://127.0.0.1:${WEB}/${path}` });
  await sleep(1200);
  if (!keepFlag) await evalInPage(sess, `sessionStorage.removeItem('om-hl-pix-fail')`);
  await evalInPage(sess, `document.getElementById('txt')?.scrollIntoView()`);
  await sleep(200);
  const p = JSON.parse(await evalInPage(sess, `(() => {
    const node = document.createTreeWalker(document.getElementById('txt'), NodeFilter.SHOW_TEXT).nextNode();
    // 同行内选一段（首尾字符跨行的对角拖会把选区塌缩成单字，span 太小采样无意义）
    const r1 = document.createRange(); r1.setStart(node, 2); r1.setEnd(node, 3);
    const r2 = document.createRange(); r2.setStart(node, 29); r2.setEnd(node, 30);
    const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
    return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
  })()`));
  check(`${path}: 拖选两端在同一行`, Math.abs(p.y1 - p.y2) < 2, `y1=${p.y1.toFixed(1)} y2=${p.y2.toFixed(1)}`);
  await mouse(sess, 'mousePressed', p.x1, p.y1);
  for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', p.x1 + (p.x2 - p.x1) * k / 8, p.y1);
  await mouse(sess, 'mouseReleased', p.x2, p.y1);
  let host = false;
  for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  if (!host) throw new Error(`${path}: 工具条未弹出`);
  const btn = JSON.parse(await evalInPage(sess, `(() => { const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent.slice(0, 10) || ''`); }
  if (!hl) throw new Error(`${path}: 高亮未生效`);
  const w = await evalInPage(sess, `document.querySelector('.om-hl')?.getBoundingClientRect().width ?? 0`);
  check(`${path}: 选区覆盖同行一段（span 宽度足够采样）`, w > 120, `宽=${w}`);
  await sleep(wait); // 400ms 首检 + 700ms 首次像素验（失败 +400ms 复验）
  const toast = await evalInPage(sess, `document.getElementById('om-hl-diag')?.textContent || ''`);
  const logs = sess.logs.filter((l) => l.text.includes('[Vela]'));
  sess.logs.length = 0;
  return { toast, logs };
}

try {
  let sess = null;
  for (let i = 0; i < 30 && !sess; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find((x) => x.type === 'page' && x.url.includes(`127.0.0.1:${WEB}`));
      if (t) { sess = await connect(t.webSocketDebuggerUrl); await sess.send('Runtime.enable'); }
    } catch { /* retry */ }
  }
  await sess.send('Page.enable');
  await sess.send('Page.bringToFront');

  const normal = await runCase(sess, 'normal');
  check('正常路径：像素验证通过日志', normal.logs.some((l) => l.text.includes('像素验证通过')), normal.logs.map((l) => l.text).join(' | ').slice(0, 140));
  check('正常路径：无红色提示', normal.toast === '', JSON.stringify(normal.toast));

  // 删除高亮钮：再次选中已高亮文字，工具条应带显式「删除此高亮」钮（此前只有高亮钮亮态，删除入口只藏在悬停小胶囊里）
  {
    await evalInPage(sess, `document.getElementById('om-sel-host')?.remove(); sessionStorage.removeItem('om-hl-pix-fail')`);
    await sleep(150);
    const p = JSON.parse(await evalInPage(sess, `(() => {
      // 高亮后 #txt 首个文本节点只剩 span 前缀 2 字符；选区坐标直接取 .om-hl 内的文本
      const node = document.createTreeWalker(document.querySelector('.om-hl'), NodeFilter.SHOW_TEXT).nextNode();
      const r1 = document.createRange(); r1.setStart(node, 0); r1.setEnd(node, 1);
      const r2 = document.createRange(); r2.setStart(node, node.length - 1); r2.setEnd(node, node.length);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
    })()`));
    await mouse(sess, 'mousePressed', p.x1, p.y1);
    for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', p.x1 + (p.x2 - p.x1) * k / 8, p.y1);
    await mouse(sess, 'mouseReleased', p.x2, p.y1);
    let delBtn = null;
    for (let i = 0; i < 15 && !delBtn; i++) {
      await sleep(200);
      delBtn = JSON.parse(await evalInPage(sess, `(() => {
        const sr = document.getElementById('om-sel-host')?.shadowRoot; if (!sr) return 'null';
        const b = sr.querySelector('[data-act="del-hl"]'); if (!b) return 'null';
        const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`));
      if (delBtn === 'null') delBtn = null;
    }
    check('再选已高亮文字：工具条带「删除此高亮」钮', !!delBtn);
    if (delBtn) {
      await mouse(sess, 'mousePressed', delBtn.x, delBtn.y);
      await mouse(sess, 'mouseReleased', delBtn.x, delBtn.y);
      let gone = false;
      for (let i = 0; i < 15 && !gone; i++) { await sleep(200); gone = !(await evalInPage(sess, `document.querySelectorAll('.om-hl').length`)); }
      const left = await evalInPage(sess, `document.querySelectorAll('.om-hl').length`);
      check('点击删除钮后高亮解除（.om-hl 清零）', gone, `剩余=${left}`);
    }
  }

  const hidden = await runCase(sess, 'hidden');
  check('opacity:0：DOM 首检即点名整段透明化（精确根因，不走像素链）', hidden.toast.includes('opacity=0') && hidden.toast.includes('透明化'), JSON.stringify(hidden.toast.slice(0, 140)));
  check('opacity:0：无「像素验证失败」日志（DOM 层已定性）', !hidden.logs.some((l) => l.text.includes('像素验证失败')), hidden.logs.map((l) => l.text).join(' | ').slice(0, 160));

  const ghost = await runCase(sess, 'ghost');
  const shadow = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).boxShadow`);
  check('DOM 全绿签名（filter:opacity(0) 在 span 本身）：首检全绿照打应用成功日志', ghost.logs.some((l) => l.text.includes('高亮已应用')), ghost.logs.map((l) => l.text).filter((t) => t.includes('高亮已应用')).join(' | ').slice(0, 90));
  check('DOM 全绿签名：红 toast 报「未测到高亮色」', ghost.toast.includes('未测到高亮色'), JSON.stringify(ghost.toast));
  check('DOM 全绿签名：像素验证失败日志', ghost.logs.some((l) => l.text.includes('像素验证失败')), ghost.logs.map((l) => l.text).join(' | ').slice(0, 160));
  check('DOM 全绿签名：增强绘制已落上（box-shadow 非 none）', shadow !== 'none', String(shadow).slice(0, 60));
  check('报障 toast 文案自带占比/均值数字（截图 toast 即可定性，不依赖控制台）', ghost.toast.includes('占比=') && ghost.toast.includes('均值=rgb('), ghost.toast.slice(0, 150));
  const thumbInfo = JSON.parse(await evalInPage(sess, `(() => {
    const c = document.getElementById('om-hl-diag')?.querySelector('canvas');
    return JSON.stringify({ w: c?.width || 0 });
  })()`));
  check('报障 toast 内嵌采样区实际截屏缩略图（canvas 直绘）', thumbInfo.w > 50, JSON.stringify(thumbInfo));

  // 同会话复发：flag 保留（不预清理）→ 像素报障不再弹窗，console 仍留日志
  const dedup = await runCase(sess, 'ghost', { keepFlag: true });
  check('同会话复发像素报障：不再弹红色提示（sessionStorage 去重）', dedup.toast === '', JSON.stringify(dedup.toast));
  check('同会话复发：console 仍留像素验证失败日志', dedup.logs.some((l) => l.text.includes('像素验证失败')), dedup.logs.map((l) => l.text).join(' | ').slice(0, 140));

  const dead = await runCase(sess, 'dead');
  check('增强层也被吃（brightness(0)）：红 toast 报「未测到高亮色」', dead.toast.includes('未测到高亮色'), JSON.stringify(dead.toast));
  check('增强层也被吃：像素验证失败日志', dead.logs.some((l) => l.text.includes('像素验证失败')), dead.logs.map((l) => l.text).join(' | ').slice(0, 160));
  const deadThumb = JSON.parse(await evalInPage(sess, `(() => {
    const c = document.getElementById('om-hl-diag')?.querySelector('canvas');
    if (!c) return JSON.stringify({ w: 0 });
    let dark = 0;
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) { if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) dark++; }
    } catch { return JSON.stringify({ w: -1 }); }
    return JSON.stringify({ w: c.width, dark });
  })()`));
  check('增强层也被吃：toast 缩略图确带实际像素（压黑区域，深色像素非零）', deadThumb.w > 50 && deadThumb.dark > 0, JSON.stringify(deadThumb));

  const tinted = await runCase(sess, 'tinted');
  check('全页反色（暗色扩展 filter 形态）：像素终验跳过并点名祖先', tinted.logs.some((l) => l.text.includes('像素验证跳过：祖先')), tinted.logs.map((l) => l.text).join(' | ').slice(0, 160));
  check('全页反色：无红色提示（高亮仍可见，只是被页面滤镜移相）', tinted.toast === '', JSON.stringify(tinted.toast));

  // Google 结果卡形态：从标题下方正常文本起选、拖进 pointer-events:none 标题，高亮后
  // 标题行的 hit-test 落在祖先 <a> 上——修前误报「被 A 遮挡」，修后祖先不算遮挡
  {
    await sess.send('Page.navigate', { url: `http://127.0.0.1:${WEB}/nested` });
    await sleep(1200);
    await evalInPage(sess, `sessionStorage.removeItem('om-hl-pix-fail')`);
    const q = JSON.parse(await evalInPage(sess, `(() => {
      const t1 = document.createTreeWalker(document.getElementById('txt'), NodeFilter.SHOW_TEXT).nextNode();
      const t2 = document.createTreeWalker(document.getElementById('seed'), NodeFilter.SHOW_TEXT).nextNode();
      const r1 = document.createRange(); r1.setStart(t2, 5); r1.setEnd(t2, 6);
      const r2 = document.createRange(); r2.setStart(t1, 29); r2.setEnd(t1, 30);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      return JSON.stringify({ x1: a.left + 5, y1: a.top + a.height / 2, x2: b.left + 5, y2: b.top + b.height / 2 });
    })()`));
    await mouse(sess, 'mousePressed', q.x1, q.y1);
    for (let k = 1; k <= 10; k++) await mouse(sess, 'mouseMoved', q.x1 + (q.x2 - q.x1) * k / 10, q.y1 + (q.y2 - q.y1) * k / 10);
    await mouse(sess, 'mouseReleased', q.x2, q.y2);
    let host = false;
    for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
    if (!host) throw new Error('nested: 工具条未弹出');
    const btn = JSON.parse(await evalInPage(sess, `(() => { const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
    await mouse(sess, 'mousePressed', btn.x, btn.y);
    await mouse(sess, 'mouseReleased', btn.x, btn.y);
    let hl = '';
    for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent.slice(0, 10) || ''`); }
    if (!hl) throw new Error('nested: 高亮未生效');
    await sleep(3500); // 400ms 首检 + 700ms 像素验
    const ntoast = await evalInPage(sess, `document.getElementById('om-hl-diag')?.textContent || ''`);
    const nlogs = sess.logs.filter((l) => l.text.includes('[Vela]'));
    sess.logs.length = 0;
    check('Google <a><h3> 形态：命中祖先不误报遮挡', ntoast === '', JSON.stringify(ntoast));
    check('Google <a><h3> 形态：像素验证通过', nlogs.some((l) => l.text.includes('像素验证通过')), nlogs.map((l) => l.text).join(' | ').slice(0, 160));
  }

  // 跨段落选区：p1 末行尾拖到 p2 首行头。修前一只 span 装两个 <p> 片段（块内行内），
  // Chrome 对这种结构零绘制背景 → 真实报障；修后逐块 span，全部纯行内且像素显色。
  // 再验第二块的局部删除：选区落在其一只 span 内时带删除钮，点击只解该块、邻块保留。
  {
    await sess.send('Page.navigate', { url: `http://127.0.0.1:${WEB}/xblock` });
    await sleep(1200);
    await evalInPage(sess, `sessionStorage.removeItem('om-hl-pix-fail')`);
    const q = JSON.parse(await evalInPage(sess, `(() => {
      const t1 = document.createTreeWalker(document.getElementById('p1'), NodeFilter.SHOW_TEXT).nextNode();
      const t2 = document.createTreeWalker(document.getElementById('p2'), NodeFilter.SHOW_TEXT).nextNode();
      const r1 = document.createRange(); r1.setStart(t1, t1.length - 2); r1.setEnd(t1, t1.length - 1);
      const r2 = document.createRange(); r2.setStart(t2, 8); r2.setEnd(t2, 9);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      return JSON.stringify({ x1: a.right - 4, y1: a.top + a.height / 2, x2: b.left + 4, y2: b.top + b.height / 2 });
    })()`));
    await mouse(sess, 'mousePressed', q.x1, q.y1);
    for (let k = 1; k <= 10; k++) { await mouse(sess, 'mouseMoved', q.x1 + (q.x2 - q.x1) * k / 10, q.y1 + (q.y2 - q.y1) * k / 10); await sleep(20); }
    await mouse(sess, 'mouseReleased', q.x2, q.y2);
    await sleep(300);
    console.log('  [selection]', await evalInPage(sess, `JSON.stringify({ len: getSelection().toString().length, text: getSelection().toString().slice(0, 60), lines: new Set(getSelection().toString().split('\\n')).size })`));
    let host = false;
    for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
    if (!host) throw new Error('xblock: 工具条未弹出');
    const btn = JSON.parse(await evalInPage(sess, `(() => { const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
    await mouse(sess, 'mousePressed', btn.x, btn.y);
    await mouse(sess, 'mouseReleased', btn.x, btn.y);
    let n = 0;
    for (let i = 0; i < 15 && !n; i++) { await sleep(200); n = await evalInPage(sess, `document.querySelectorAll('.om-hl').length`); }
    if (!n) throw new Error('xblock: 高亮未生效');
    check('跨段落选区：逐块拆成多只 span', n >= 2, `数量=${n}`);
    const blockFree = await evalInPage(sess, `(() => {
      for (const s of document.querySelectorAll('.om-hl')) {
        for (const c of s.children) {
          const d = getComputedStyle(c).display;
          if (d !== 'inline' && d !== 'inline-block' && d !== 'contents') return JSON.stringify({ bad: c.tagName, d });
        }
      }
      return JSON.stringify({ bad: '' });
    })()`);
    check('跨段落选区：所有 span 无块级子元素（块内行内 = Chrome 零绘制根因）', JSON.parse(blockFree).bad === '', blockFree);
    await sleep(3500); // 400ms 首检 + 700ms 像素验
    const xtoast = await evalInPage(sess, `document.getElementById('om-hl-diag')?.textContent || ''`);
    const xlogs = sess.logs.filter((l) => l.text.includes('[Vela]'));
    sess.logs.length = 0;
    check('跨段落选区：无红色提示（像素照常显色）', xtoast === '', JSON.stringify(xtoast));
    check('跨段落选区：像素验证通过', xlogs.some((l) => l.text.includes('像素验证通过')), xlogs.map((l) => l.text).join(' | ').slice(0, 160));

    // 局部删除：只框选第二块 span 内的文字，删除后仅这块解除，第一块保留
    const p2q = JSON.parse(await evalInPage(sess, `(() => {
      const spans = [...document.querySelectorAll('.om-hl')];
      const node = document.createTreeWalker(spans[spans.length - 1], NodeFilter.SHOW_TEXT).nextNode();
      const r1 = document.createRange(); r1.setStart(node, 0); r1.setEnd(node, 1);
      const r2 = document.createRange(); r2.setStart(node, node.length - 1); r2.setEnd(node, node.length);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
    })()`));
    await evalInPage(sess, `document.getElementById('om-sel-host')?.remove()`);
    await sleep(150);
    await mouse(sess, 'mousePressed', p2q.x1, p2q.y1);
    for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', p2q.x1 + (p2q.x2 - p2q.x1) * k / 8, p2q.y1);
    await mouse(sess, 'mouseReleased', p2q.x2, p2q.y1);
    let delBtn = null;
    for (let i = 0; i < 15 && !delBtn; i++) {
      await sleep(200);
      delBtn = JSON.parse(await evalInPage(sess, `(() => {
        const sr = document.getElementById('om-sel-host')?.shadowRoot; if (!sr) return 'null';
        const b = sr.querySelector('[data-act="del-hl"]'); if (!b) return 'null';
        const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`));
      if (delBtn === 'null') delBtn = null;
    }
    check('跨段落选区：再选单块高亮文字仍带「删除此高亮」钮', !!delBtn);
    if (delBtn) {
      await mouse(sess, 'mousePressed', delBtn.x, delBtn.y);
      await mouse(sess, 'mouseReleased', delBtn.x, delBtn.y);
      let left = -1;
      for (let i = 0; i < 15; i++) { await sleep(200); left = await evalInPage(sess, `document.querySelectorAll('.om-hl').length`); if (left < n) break; }
      check('跨段落选区：删除只解选中块、邻块保留', left === n - 1, `删后剩余=${left}（删前=${n}）`);
    }
  }

  sess.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  failed = 1;
} finally {
  await killTree(chrome);
  server.close();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  process.exit(failed);
}
