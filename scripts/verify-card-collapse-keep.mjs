// e2e：收起聊天卡不杀任务。收起 = 隐藏 iframe（display:none）而非销毁——iframe 里
// 正在跑的 LLM 流式任务继续执行，落盘、展开后原地可见；浮窗 × / 暂停本页仍真销毁
// （pagehide 取消任务，给自动化让路）。
// 另覆盖任务角标：收起期间球亮绿点（在跑）→ 跑完转橙点（完成未看）→ 展开即清除。
// 用法：node scripts/verify-card-collapse-keep.mjs
import { launch, sleep, waitFor, createChecker, seedStorage, connect } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';
import { createServer } from 'node:http';

const { check, summary } = createChecker();
const SLOW_MARKER = 'SLOW-STREAM-MARKER';
const SLOW_BODY = '流式输出很慢的一段话。'.repeat(150); // ~40ms/块，全程数秒，留出收起窗口

const web = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>收起测试页</title></head><body><article><h1>收起测试页</h1><p>正文内容用于页面上下文。</p></article></body></html>`);
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

const mock = await startMockLlm({
  respond: (req) => {
    const userText = [...req.messages].reverse().find((m) => m.role === 'user')?.text || '';
    if (userText.includes('慢慢说')) return { text: `${SLOW_MARKER} ${SLOW_BODY}`, chunkDelayMs: 40 };
    return { text: 'mock 回答' };
  },
});

const browser = await launch({ port: 9379 });
try {
  const sw0 = await browser.sw();
  await seedStorage(sw0, {
    llmSettings: {
      providers: [{ id: 'p', name: 'Mock', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'k', models: ['m'] }],
      activeProviderId: 'p',
      chat: { defaultEngine: 'llm' },
    },
    conversations: [],
  });
  sw0.close();

  const store = async () => JSON.parse(await (await browser.sw().then(async (s) => { const r = await s.evaluate(`chrome.storage.local.get('conversations').then((o) => JSON.stringify(o.conversations || []))`); s.close(); return r; })));
  const swDo = async (expr) => { const s = await browser.sw(); const r = await s.evaluate(expr); s.close(); return r; };
  const tabAction = (type) => swDo(`chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => (x.url || '').startsWith(${JSON.stringify(BASE)})); return chrome.tabs.sendMessage(t.id, { type: ${JSON.stringify(type)} }); }).then(() => 'ok')`);
  const cardTargets = async () => (await browser.targets()).filter((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html'));
  // 悬浮球上的任务角标态：run（绿点在跑）/ done（橙点完成未看）/ off / none（无角标）
  const badgeState = () => tab.evaluate(`(() => {
    const b = document.getElementById('om-widget-host')?.shadowRoot?.querySelector('.om-ball .om-task-badge');
    if (!b) return 'none';
    if (b.classList.contains('run')) return 'run';
    if (b.classList.contains('done')) return 'done';
    return 'off';
  })()`);

  const tab = await browser.openTab(`${BASE}/collapse`, { wait: 2200 });
  await tab.send('Page.bringToFront');
  await tabAction('om:open-card');
  const t0 = await waitFor(async () => (await cardTargets()).find((x) => decodeURIComponent(x.url).includes('/collapse')), { timeout: 12000 });
  const card = await connect(t0.webSocketDebuggerUrl);
  await card.send('Runtime.enable');
  await waitFor(() => card.evaluate(`!!document.getElementById('om-engine')`));
  await sleep(1200);

  // 发起慢流式回答，等流式开始
  const nItems0 = (await store()).flatMap((c) => c.items).length;
  await card.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = '慢慢说'; document.getElementById('om-send').click(); return 1; })()`);
  await waitFor(() => card.evaluate(`document.getElementById('om-send').classList.contains('om-streaming')`), { timeout: 10000 });
  await sleep(600); // 流已吐出部分增量

  // 收起（胶囊开关同款路径 om:close-card / SW 广播侧边栏打开时也走它）：卡隐藏但不销毁
  await tabAction('om:close-card');
  await waitFor(() => tab.evaluate(`document.getElementById('om-card-host')?.style.display === 'none'`), { timeout: 4000 });
  const t1 = (await cardTargets()).find((x) => x.id === t0.id);
  check('收起后卡 iframe 仍活着（同一 target，未销毁）', !!t1, `targets=${(await cardTargets()).length}`);
  check('隐藏卡 iframe 的 visibilityState 仍为 visible（收起期间 pendingTask 可被消费）',
    await card.evaluate(`document.visibilityState`) === 'visible', await card.evaluate(`document.visibilityState`));
  check('收起期间球亮「任务在跑」绿点角标', await badgeState() === 'run', await badgeState());

  // 任务在隐藏态跑完并落盘：全文进存储、无 stopped / error 标记
  await waitFor(async () => {
    const items = (await store()).flatMap((c) => c.items);
    const a = items.find((i) => i.type === 'answer' && i.content);
    return a && a.content.includes(SLOW_MARKER) && a.content.length >= SLOW_MARKER.length + SLOW_BODY.length - 100;
  }, { timeout: 30000 });
  const done = (await store()).flatMap((c) => c.items).find((i) => i.type === 'answer' && i.content);
  check('收起期间任务跑完并落盘（全文、未标停止、无错误）',
    done.content.includes(SLOW_MARKER) && !done.stopped && !done.error, `len=${done.content.length}, stopped=${!!done.stopped}, error=${done.error || ''}`);
  await waitFor(async () => (await badgeState()) === 'done', { timeout: 4000 });
  check('任务跑完角标转「完成未看」橙点（卡仍收着）', await badgeState() === 'done', await badgeState());

  // 再点展开：同一 iframe 原地复活，内容已在（无「已停止」角标），流式态已结束
  await tabAction('om:open-card');
  await waitFor(() => tab.evaluate(`document.getElementById('om-card-host')?.style.display === ''`), { timeout: 4000 });
  await waitFor(() => card.evaluate(`!document.getElementById('om-send').classList.contains('om-streaming')`), { timeout: 8000 });
  check('展开复活同一 iframe（target 未换）', !!(await cardTargets()).find((x) => x.id === t0.id), '');
  const view = await card.evaluate(`(() => ({
    stopped: !!document.querySelector('.om-stopped'),
    bodyHasMarker: [...document.querySelectorAll('.om-msg-answer .om-body')].some((b) => (b.textContent || '').includes(${JSON.stringify(SLOW_MARKER)})),
    items: document.querySelectorAll('.om-msg-answer').length,
  }))()`);
  check('展开后回答完整可见、无「已停止」角标', view.bodyHasMarker && !view.stopped, JSON.stringify(view));
  check('展开即「已查看」，完成橙点清除', await badgeState() === 'off', await badgeState());
  check('收起期间没有新建会话 / 多余消息', (await store()).flatMap((c) => c.items).length === nItems0 + 2, (await store()).flatMap((c) => c.items).length);

  // 浮窗 × （dismiss）仍真销毁：再发起慢回答，点 × → iframe 没了、任务被取消（内容定格）
  await card.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = '慢慢说'; document.getElementById('om-send').click(); return 1; })()`);
  await waitFor(() => card.evaluate(`document.getElementById('om-send').classList.contains('om-streaming')`), { timeout: 10000 });
  await sleep(400); // 流刚起步就销毁，断言「没跑完」才有余量
  await tab.evaluate(`document.getElementById('om-widget-host').shadowRoot.querySelector('.dismiss').click()`);
  await waitFor(async () => !(await cardTargets()).some((x) => x.id === t0.id), { timeout: 6000 });
  check('浮窗 × 仍销毁卡 iframe（pagehide 取消任务）', !(await cardTargets()).some((x) => x.id === t0.id), `targets=${(await cardTargets()).length}`);
  await waitFor(async () => (await store()).flatMap((c) => c.items).filter((i) => i.type === 'answer').length >= 2, { timeout: 8000 });
  const len1 = (await store()).flatMap((c) => c.items).filter((i) => i.type === 'answer').at(-1).content.length;
  await sleep(1500);
  const answers2 = (await store()).flatMap((c) => c.items).filter((i) => i.type === 'answer');
  const len2 = answers2.at(-1).content.length;
  const fullLen = SLOW_MARKER.length + 1 + SLOW_BODY.length;
  check('销毁那轮的回答定格不再增长（远未到全文，任务确实被取消）', len2 === len1 && len2 < fullLen / 2, `len ${len1}→${len2}，全文 ${fullLen}`);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
}
process.exit(summary());
