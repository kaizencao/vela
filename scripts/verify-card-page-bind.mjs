// e2e：聊天卡按宿主页绑定会话（会话错乱修复）+ 页面关闭停跑（LLM 车道），全程 mock LLM。
// 复现用户报障：A 页开的会话，B 页的卡还显示 A 的会话（A 关了也是）；A 页关了会话还在跑。
// 覆盖：
//   1. A 页开卡：新建绑 A 的会话（pageKey + 宿主页标题），发消息
//   2. 同页重开卡：续 A 的会话（?conv 记忆 + pageKey 双保险，不新建）
//   3. 新标签页打开 A：恢复 A 自己的会话（不再回退「全局最近活跃」串页）
//   4. 新标签页打开 B：恢复 B 的会话、不是 A 的（核心报障场景）
//   5. 同标签页 SPA 换页（卡开着、会话有消息）：新建绑新页的会话，旧会话保留
//   6. 老会话（只有 pageCtx、无 pageKey）在同一页开卡：按页认领，不重复新建
//   7. LLM 流式中关宿主页标签：mock 侧连接中断（页面销毁中止请求），已流出内容落盘
// 用法：node scripts/verify-card-page-bind.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, connect, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();
const FILL = '内容填充'.repeat(30);
const page = (title, marker) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1><p>${marker} ${FILL}</p></article></body></html>`;
const PAGES = { '/a': ['Page A', 'PAGE-A-MARKER'], '/b': ['Page B', 'PAGE-B-MARKER'], '/legacy': ['Legacy Page', 'LEGACY-MARKER'] };
const web = createServer((q, r) => {
  const p = PAGES[q.url.split('?')[0]] || ['Page X', 'PAGE-X-MARKER'];
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(page(...p));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;
const mock = await startMockLlm({
  respond: (req) => {
    const userText = [...req.messages].reverse().find((m) => m.role === 'user')?.text || '';
    if (userText.includes('慢慢说')) return { text: `SLOW-STREAM-MARKER ${'流式输出很慢的一段话。'.repeat(300)}`, chunkDelayMs: 60 };
    return { text: 'mock 回答' };
  },
});

const browser = await launch({ port: 9377 });
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

  // ---- 工具（verify-card-ctx 同款） ----
  const store = async () => JSON.parse(await (await browser.sw().then(async (s) => { const r = await s.evaluate(`chrome.storage.local.get('conversations').then((o) => JSON.stringify(o.conversations || []))`); s.close(); return r; })));
  const swDo = async (expr) => { const s = await browser.sw(); const r = await s.evaluate(expr); s.close(); return r; };
  const tabAction = (urlPrefix, type) => swDo(`chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => (x.url || '').startsWith(${JSON.stringify(urlPrefix)})); return chrome.tabs.sendMessage(t.id, { type: ${JSON.stringify(type)} }); }).then(() => 'ok')`);
  const seenFrames = new Set();
  const openCard = async (urlPrefix) => {
    await tabAction(urlPrefix, 'om:open-card');
    const t = await waitFor(async () => (await browser.targets()).find((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html') && !seenFrames.has(x.id)), { timeout: 12000 });
    seenFrames.add(t.id);
    const s = await connect(t.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    await waitFor(() => s.evaluate(`!!document.getElementById('om-engine')`));
    return s;
  };
  const chip = (card) => card.evaluate(`document.querySelector('.om-chip-name')?.textContent || ''`);
  const activeConv = (card) => card.evaluate(`document.querySelector('.om-conv-item.om-active')?.dataset.convId || ''`);
  const sendMsg = async (card, text) => {
    const n = (await store()).flatMap((c) => c.items).length;
    await card.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = ${JSON.stringify(text)}; document.getElementById('om-send').click(); return 1; })()`);
    await waitFor(async () => (await store()).flatMap((c) => c.items).filter((i) => i.type === 'answer' && i.content).length >= (n / 2 | 0) + 1 && card.evaluate(`!document.getElementById('om-send').classList.contains('om-streaming')`), { timeout: 10000 });
  };
  const spa = (tab, path, title, marker) => tab.evaluate(`(() => { history.pushState({}, '', ${JSON.stringify(path)}); document.title = ${JSON.stringify(title)}; document.querySelector('article').innerHTML = '<h1>' + ${JSON.stringify(title)} + '</h1><p>' + ${JSON.stringify(marker)} + ' ' + ${JSON.stringify(FILL)} + '</p>'; return 1; })()`);
  const closeTab = async (targetId) => { await fetch(`${browser.base}/json/close/${targetId}`); };

  // ---- 1. A 页开卡：新建绑 A 的会话 ----
  const tabA = await browser.openTab(`${BASE}/a`, { wait: 2200 });
  await tabA.send('Page.bringToFront');
  const cardA = await openCard(`${BASE}/a`);
  await sleep(1200); // 等 reconcile 挂上下文
  let convs = await store();
  const convA = convs.find((c) => c.pageKey === `${BASE}/a`);
  check('A 页开卡：新建绑 A 的会话（pageKey + 宿主页标题 + 上下文）',
    !!convA && convA.title === 'Page A' && convA.pageCtx?.url === `${BASE}/a` && convs.length === 1,
    convs.map((c) => [c.title, c.pageKey]));
  check('卡当前会话就是绑 A 的新会话', (await activeConv(cardA)) === convA.id, await activeConv(cardA));
  await sendMsg(cardA, '你好 A');
  convs = await store();
  check('A 会话已有消息', convs.find((c) => c.id === convA.id).items.length === 2, convs[0].items.length);

  // ---- 2. 同页重开卡：续 A 的会话，不新建 ----
  await tabAction(`${BASE}/a`, 'om:close-card');
  cardA.close();
  await sleep(400);
  const cardA2 = await openCard(`${BASE}/a`);
  await sleep(1500);
  convs = await store();
  check('同页重开卡：续 A 的会话（不新建）', convs.length === 1 && (await activeConv(cardA2)) === convA.id, `${convs.length} 个会话`);
  await tabAction(`${BASE}/a`, 'om:close-card');
  cardA2.close();
  await sleep(400);

  // ---- 3. 新标签页打开 A：恢复 A 自己的会话 ----
  const tabA3 = await browser.openTab(`${BASE}/a`, { wait: 2200 });
  await tabA3.send('Page.bringToFront');
  const cardA3 = await openCard(`${BASE}/a`);
  await sleep(1500);
  convs = await store();
  check('新标签页打开 A：恢复 A 自己的会话（消息还在，不新建）',
    convs.length === 1 && (await activeConv(cardA3)) === convA.id && convs[0].items.length === 2, `${convs.length} 个会话`);
  await tabAction(`${BASE}/a`, 'om:close-card');
  cardA3.close();
  await sleep(400);

  // ---- 4. 新标签页打开 B：恢复 B 的会话、不是 A 的（核心报障场景） ----
  const tabB = await browser.openTab(`${BASE}/b`, { wait: 2200 });
  await tabB.send('Page.bringToFront');
  const cardB = await openCard(`${BASE}/b`);
  await sleep(1500);
  convs = await store();
  const convB = convs.find((c) => c.pageKey === `${BASE}/b`);
  check('B 页开卡：绑 B 的新会话且成为当前会话（不是 A 的）',
    !!convB && convB.id !== convA.id && (await activeConv(cardB)) === convB.id && /Page B/.test(await chip(cardB)),
    convs.map((c) => [c.title, c.pageKey]));
  const keptA = convs.find((c) => c.id === convA.id);
  check('A 的会话原样保留（消息与绑定不动）', keptA.items.length === 2 && keptA.pageKey === `${BASE}/a`);

  // ---- 5. 同标签页 SPA 换页（会话有消息）：新建绑新页的会话 ----
  await sendMsg(cardB, '你好 B');
  await spa(tabB, '/b2', 'Page B2', 'PAGE-B2-MARKER');
  await waitFor(async () => /Page B2/.test(await chip(cardB)), { timeout: 8000, interval: 200 });
  convs = await store();
  const convB2 = convs.find((c) => c.pageKey === `${BASE}/b2`);
  check('SPA 换页后：新建绑 B2 的会话并切换，B 会话保留',
    !!convB2 && (await activeConv(cardB)) === convB2.id && convs.find((c) => c.id === convB.id).items.length === 2,
    convs.map((c) => [c.title, c.pageKey]));
  await tabAction(`${BASE}/b2`, 'om:close-card');
  cardB.close();
  await sleep(400);

  // ---- 6. 老会话（只有 pageCtx、无 pageKey）在同一页开卡：按页认领 ----
  const legacyItems = [
    { id: 'msg:lq', type: 'question', content: '老问题', createdAt: Date.now(), parentItemId: '' },
    { id: 'msg:la', type: 'answer', content: '老回答', createdAt: Date.now(), parentItemId: 'msg:lq', model: 'm', error: '', stopped: false },
  ];
  await swDo(`chrome.storage.local.get('conversations').then((o) => chrome.storage.local.set({ conversations: [{
    id: 'conv:legacy', title: 'Legacy Page', engine: 'llm', llmMode: 'chat', createdAt: ${Date.now()}, updatedAt: ${Date.now()},
    pageCtx: { title: 'Legacy Page', url: '${BASE}/legacy', text: 'LEGACY-MARKER ${FILL}' },
    items: ${JSON.stringify(legacyItems)},
  }, ...o.conversations] })).then(() => 1)`);
  const tabL = await browser.openTab(`${BASE}/legacy`, { wait: 2200 });
  await tabL.send('Page.bringToFront');
  const cardL = await openCard(`${BASE}/legacy`);
  await sleep(1500);
  convs = await store();
  const legacy = convs.find((c) => c.id === 'conv:legacy');
  check('老会话在同一页开卡：按 pageCtx 认领（不新建），并补写 pageKey',
    (await activeConv(cardL)) === 'conv:legacy' && convs.filter((c) => c.pageKey === `${BASE}/legacy`).length === 1 && legacy.items.length === 2,
    convs.map((c) => [c.title, c.pageKey]));
  await tabAction(`${BASE}/legacy`, 'om:close-card');
  cardL.close();

  // ---- 7. LLM 流式中关宿主页标签：连接中断 + 已流出内容落盘 ----
  const cardL2 = await openCard(`${BASE}/legacy`);
  await sleep(1000);
  // 非阻塞发送：流要持续十几秒，不能等它结束
  await cardL2.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = '慢慢说'; document.getElementById('om-send').click(); return 1; })()`);
  // 等首个内容落盘（500ms 节流），再关页——断言「已流出的部分不丢」
  await waitFor(async () => (await store()).flatMap((c) => c.items).some((i) => i.type === 'answer' && (i.content || '').includes('SLOW-STREAM-MARKER')), { timeout: 8000 });
  const tabLT = (await browser.targets()).find((t) => t.type === 'page' && t.url.startsWith(`${BASE}/legacy`));
  await closeTab(tabLT.id);
  await sleep(1500);
  const reqs = mock.requests.filter((r) => r.messages.some((m) => (m.text || '').includes('慢慢说')));
  check('关宿主页：流式请求连接中断（页面销毁中止，不再继续跑）', reqs.length === 1 && reqs[0].aborted === true, `aborted=${reqs.map((r) => r.aborted)}`);
  convs = await store();
  const slowAns = convs.flatMap((c) => c.items).find((i) => i.type === 'answer' && (i.content || '').includes('SLOW-STREAM-MARKER'));
  check('已流出内容已落盘（尾部不丢）', !!slowAns && (slowAns.content || '').length > 0, `len=${slowAns?.content?.length ?? 0}`);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
  await mock.close();
  web.close();
}
process.exit(summary());
