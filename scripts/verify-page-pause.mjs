// e2e：本页暂停（跑网页自动化时给 Vela 让路）。点胶囊右上角暂停钮先弹确认卡
// （说明作用，防误触也防「不知道这钮干嘛」），确认后才执行。暂停后：
//   浮窗 / 聊天卡 / 媒体悬停钮 / 划词工具条 / 代码钮全部消失，悬停图片、划选文字、
//   悬停代码块都不再注入任何元素；整页跳转到新地址保持暂停；回到暂停时的地址
//   （同址重载语义）自动清标记，浮窗与划词工具条恢复。
// 暂停前先做正面对照（媒体钮 / 划词条确实会出现），防夹具本身失效造成假绿。
// 用法：node scripts/verify-page-pause.mjs
import { createServer } from 'node:http';
import { launch, waitFor, createChecker, sleep } from './lib/cdp.mjs';

const { check, summary } = createChecker();

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const page = (extra) => `<!doctype html><html><head><meta charset="utf-8"><title>暂停夹具</title></head><body>
<p id="para">这是一段足够长的正文文字，用来做划词选区测试，真实鼠标拖拽选中其中一部分。</p>
<img id="pic" src="/img.png" width="140" height="140" alt="大图">
${extra}
</body></html>`;
const web = createServer((q, r) => {
  if (q.url.startsWith('/p1.html')) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page('<pre id="code"><code>const pauseTest = 12345;</code></pre>')); return; }
  if (q.url.startsWith('/p2.html')) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page('')); return; }
  if (q.url.startsWith('/img.png')) { r.writeHead(200, { 'content-type': 'image/png' }); r.end(PNG_1PX); return; }
  r.writeHead(404); r.end('not found');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

const b = await launch({ port: 9462 });
try {
  const tab = await b.openTab(`${BASE}/p1.html`, { wait: 2000 });
  await tab.send('Page.bringToFront');
  const E = (expr) => tab.evaluate(expr);
  const W = `document.getElementById('om-widget-host')?.shadowRoot`;
  await waitFor(() => E(`!!${W}?.querySelector('.om-ball')`), { timeout: 15000 });
  check('浮窗已注入（悬浮球态）', true);

  const centerOf = (sel) => E(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`).then((s) => (s ? JSON.parse(s) : null));
  // 真实鼠标拖拽选中段落前半句，返回是否弹出了划词工具条
  const dragSelect = async () => {
    const p = await centerOf('#para');
    if (!p) return false;
    await tab.mouse('mouseMoved', p.x - 60, p.y);
    await tab.mouse('mousePressed', p.x - 60, p.y);
    await tab.mouse('mouseMoved', p.x - 20, p.y);
    await tab.mouse('mouseMoved', p.x + 60, p.y);
    await tab.mouse('mouseReleased', p.x + 60, p.y);
    await sleep(400);
    return !!(await E(`document.getElementById('om-sel-host')`));
  };

  // ---- 正面对照：未暂停时该出现的都会出现 ----
  const img = await centerOf('#pic');
  await tab.mouse('mouseMoved', img.x, img.y);
  await sleep(700);
  check('未暂停：悬停图片长出媒体钮', !!await E(`document.getElementById('om-media-hover')`));
  check('未暂停：划词弹出工具条', await dragSelect());

  // ---- 点暂停钮 ----
  const ball = JSON.parse(await E(`(() => {
    const r = ${W}.querySelector('.om-ball').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await tab.mouse('mouseMoved', ball.x, ball.y);
  await waitFor(() => E(`!!${W}.querySelector('.stack.open')`), { timeout: 5000 });
  const pauseBtn = JSON.parse(await E(`(() => {
    const el = ${W}.querySelector('.pause');
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  check('胶囊上有暂停钮', !!pauseBtn);
  const C = `${W}.querySelector('.om-w-confirm')`;
  // 先走「取消」分支：确认卡收起、浮窗还在
  await tab.click(pauseBtn.x, pauseBtn.y);
  await sleep(250);
  check('点暂停先弹确认卡（不直接暂停）', await E(`!!${C} && !${C}.hasAttribute('hidden')`));
  const noBtn = JSON.parse(await E(`(() => {
    const r = ${C}.querySelector('.om-w-confirm-no').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await tab.click(noBtn.x, noBtn.y);
  await sleep(400);
  check('取消后确认卡收起且浮窗还在', await E(`${C}.hasAttribute('hidden')`)
    && !!await E(`document.getElementById('om-widget-host')`));
  // 再走「确认」分支：执行暂停
  const ball2 = JSON.parse(await E(`(() => {
    const r = ${W}.querySelector('.om-ball').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await tab.mouse('mouseMoved', ball2.x, ball2.y); // 确认卡收起后动作列可能已自动收起，重新悬停展开
  await waitFor(() => E(`!!${W}.querySelector('.stack.open')`), { timeout: 5000 });
  const pauseBtn2 = JSON.parse(await E(`(() => {
    const r = ${W}.querySelector('.pause').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await tab.click(pauseBtn2.x, pauseBtn2.y);
  await sleep(250);
  const okBtn = JSON.parse(await E(`(() => {
    const r = ${C}.querySelector('.om-w-confirm-ok').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await tab.click(okBtn.x, okBtn.y);
  await sleep(300);
  check('确认后浮窗消失', !await E(`document.getElementById('om-widget-host')`));
  check('暂停后聊天卡宿主不在', !await E(`document.getElementById('om-card-host')`));
  check('暂停后划词条被摘掉', !await E(`document.getElementById('om-sel-host')`));
  const flag = await E(`sessionStorage.getItem('om-page-paused')`);
  check('sessionStorage 记下本页地址', typeof flag === 'string' && flag.includes('/p1.html'), flag);

  // ---- 负面：暂停后三类注入全部哑火 ----
  await tab.mouse('mouseMoved', img.x, img.y);
  await sleep(700);
  check('暂停后悬停图片不长媒体钮', !await E(`document.getElementById('om-media-hover')`));
  check('暂停后划词不出工具条', !(await dragSelect()));
  const code = await centerOf('#code');
  await tab.mouse('mouseMoved', code.x, code.y);
  await sleep(800);
  check('暂停后悬停代码块不出代码钮', !await E(`document.getElementById('om-sel-cbtn-host')`));

  // ---- 整页跳转到新地址：保持暂停 ----
  await tab.send('Page.navigate', { url: `${BASE}/p2.html` });
  await sleep(2500); // document_idle 注入窗口
  check('换页后浮窗不注入', !await E(`document.getElementById('om-widget-host')`));
  const flag2 = await E(`sessionStorage.getItem('om-page-paused')`);
  check('标记保留且仍指旧页地址', typeof flag2 === 'string' && flag2.includes('/p1.html'), flag2);
  const img2 = await centerOf('#pic');
  await tab.mouse('mouseMoved', img2.x, img2.y);
  await sleep(700);
  check('换页后悬停图片仍无媒体钮', !await E(`document.getElementById('om-media-hover')`));
  check('换页后划词仍无工具条', !(await dragSelect()));

  // ---- 回到暂停时的地址：清标记恢复 ----
  await tab.send('Page.navigate', { url: `${BASE}/p1.html` });
  await waitFor(() => E(`!!${W}?.querySelector('.om-ball')`), { timeout: 15000 });
  check('回到暂停地址浮窗恢复', true);
  check('恢复后标记已清', await E(`sessionStorage.getItem('om-page-paused')`) === null);
  check('恢复后划词工具条回来', await dragSelect());
  await tab.mouse('mouseMoved', img.x, img.y);
  await sleep(700);
  check('恢复后媒体钮回来', !!await E(`document.getElementById('om-media-hover')`));

  await tab.close();
} finally {
  await b.close();
  web.close();
}
process.exit(summary());
