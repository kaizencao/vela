// e2e：上下拖动换位 + 位置记忆。悬停 180ms 就展开动作列，收起球态几乎按不到，
// 所以拖动有两个入口，都要覆盖：
//   收起态按住悬浮球拖：位移生效且锚点写入 chrome.storage.local om-widget-pos；
//   拖动不展开动作列，松手的合成 click 被吞（球不弹开）；拖出上界被 clamp；
//   刷新页面后记忆位置恢复。
// 展开态按住胶囊本体拖：位置生效、合成 click 不误开聊天卡、列外松手照常收起；
//   点胶囊仍正常开关聊天卡（拖动机制不能破坏点击语义）。
// 用法：node scripts/verify-ball-drag.mjs
import { createServer } from 'node:http';
import { launch, waitFor, createChecker, sleep } from './lib/cdp.mjs';

const { check, summary } = createChecker();

const web = createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end('<!doctype html><html><head><meta charset="utf-8"><title>拖球夹具</title></head><body><p>正文段落。</p></body></html>');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

const b = await launch({ port: 9463 });
try {
  const tab = await b.openTab(`${BASE}/drag.html`, { wait: 2000 });
  await tab.send('Page.bringToFront');
  const E = (expr) => tab.evaluate(expr);
  const W = `document.getElementById('om-widget-host')?.shadowRoot`;
  await waitFor(() => E(`!!${W}?.querySelector('.om-ball')`), { timeout: 15000 });

  const ballCenter = () => E(`(() => {
    const el = ${W}.querySelector('.om-ball');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`).then((s) => (s ? JSON.parse(s) : null));
  const dragBall = async (toY) => {
    const p = await ballCenter();
    await tab.mouse('mouseMoved', p.x, p.y);
    await tab.mouse('mousePressed', p.x, p.y);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await tab.mouse('mouseMoved', p.x, p.y + ((toY - p.y) * i) / steps);
      await sleep(30);
    }
    await tab.mouse('mouseReleased', p.x, toY);
    await sleep(250);
  };

  const vh = await E(`window.innerHeight`);
  const y0 = (await ballCenter()).y;
  check('球初始在默认 38% 锚点附近', Math.abs(y0 - vh * 0.38) < 30, `y=${y0} vh=${vh}`);

  // 上拖 120px：位移生效 + 写入 storage + 不展开 + 松手 click 被吞
  await dragBall(y0 - 120);
  const y1 = (await ballCenter()).y;
  check('拖动生效（上移约 120px）', Math.abs(y1 - (y0 - 120)) < 8, `y=${y1}`);
  // storage 写入不在此处直读：chrome.storage 只在内容脚本 ISOLATED world 存在，
  // 页面 world 求值读不到。「刷新后记忆位置恢复」断言即写入成功的间接证明
  await sleep(400);
  check('拖动不展开动作列（含松手合成 click 被吞）', !await E(`!!${W}.querySelector('.stack.open')`));

  // 正常点击仍展开
  const p1 = await ballCenter();
  await tab.click(p1.x, p1.y);
  await sleep(300);
  check('正常点击展开动作列', !!await E(`!!${W}.querySelector('.stack.open')`));
  await tab.mouse('mouseMoved', p1.x - 200, p1.y); // 移开收起，还原球态
  await sleep(500);

  // ---- 展开态（胶囊）拖动：悬停展开后按住胶囊本体往下拖 ----
  const pillCenter = () => E(`(() => {
    const el = ${W}.querySelector('.pill');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`).then((s) => (s ? JSON.parse(s) : null));
  const hostCenterY = () => E(`(() => {
    const r = document.getElementById('om-widget-host').getBoundingClientRect();
    return r.top + r.height / 2;
  })()`);
  const dragPill = async (toY, releaseAway) => {
    const p = await pillCenter();
    await tab.mouse('mouseMoved', p.x, p.y);
    await tab.mouse('mousePressed', p.x, p.y);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await tab.mouse('mouseMoved', p.x, p.y + ((toY - p.y) * i) / steps);
      await sleep(30);
    }
    // releaseAway：松手前向左拖出列外（host 跟着指针走，竖直拖松手点总在列内）
    const rx = releaseAway ? p.x - 180 : p.x;
    await tab.mouse('mouseMoved', rx, toY);
    await tab.mouse('mouseReleased', rx, toY);
    await sleep(250);
  };
  const hoverOpen = async () => {
    const p = await ballCenter();
    await tab.mouse('mouseMoved', p.x, p.y);
    await waitFor(() => E(`!!${W}.querySelector('.stack.open')`), { timeout: 5000 });
    await sleep(250); // 展开动画与让位偏移落定
  };

  await hoverOpen();
  const py0 = (await pillCenter()).y;
  const hy0 = await hostCenterY();
  check('悬停后胶囊在动作列内可见', Number.isFinite(py0), `pillY=${py0}`);
  await dragPill(py0 + 100); // 竖直下拖：host 跟着走，松手点仍在列内
  const hy1 = await hostCenterY();
  check('展开态按住胶囊拖动生效（下移约 100px）', Math.abs(hy1 - (hy0 + 100)) < 8, `hy=${hy1}`);
  check('胶囊拖动不误开聊天卡（合成 click 被吞）', !await E(`document.getElementById('om-card-host')`));
  check('列上松手动作列保持展开', !!await E(`!!${W}.querySelector('.stack.open')`));
  // 再拖一次，松手前向左拖出列外：300ms 收起定时器落定后动作列收起
  const py1 = (await pillCenter()).y;
  await dragPill(py1 + 60, true);
  const hy2 = await hostCenterY();
  check('向左拖出列外位置照常生效', Math.abs(hy2 - (hy1 + 60)) < 8, `hy=${hy2}`);
  await sleep(400);
  check('列外松手后动作列照常收起', !await E(`!!${W}.querySelector('.stack.open')`));

  // 点胶囊仍正常开关聊天卡（拖动机制不破坏点击语义）
  await hoverOpen();
  const pc = await pillCenter();
  await tab.click(pc.x, pc.y);
  await sleep(800);
  check('点胶囊正常打开聊天卡', !!await E(`document.getElementById('om-card-host')`));
  const pc2 = await pillCenter();
  await tab.click(pc2.x, pc2.y);
  await sleep(500);
  check('再点胶囊聊天卡收起', !await E(`document.getElementById('om-card-host')`));
  await tab.mouse('mouseMoved', pc2.x - 200, pc2.y); // 移开收起，还原球态
  await sleep(500);

  // 拖出上界：clamp 到 ≥60
  await dragBall(5);
  const y2 = (await ballCenter()).y;
  check('拖出上界被 clamp（锚点 ≥ 60）', y2 >= 60 && y2 < 70, `y=${y2}`);

  // 刷新后记忆位置恢复
  await tab.send('Page.reload', {});
  await waitFor(() => E(`!!${W}?.querySelector('.om-ball')`), { timeout: 15000 });
  await sleep(300); // storage.get 异步应用
  const y3 = (await ballCenter()).y;
  check('刷新后记忆位置恢复', Math.abs(y3 - y2) < 8, `y=${y3}`);

  await tab.close();
} finally {
  await b.close();
  web.close();
}
process.exit(summary());
