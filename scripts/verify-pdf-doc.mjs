// e2e：PDF 标签页管线（一期）——SW 写 omPdfJob + 开 chat.html#pdf=<id>，聊天页消费：
//   场景A：总结任务走完整链路——下载 PDF → 自动建会话（LLM 问答引擎）→ 入会话知识库
//          （快照条目，字节进 IndexedDB）→ 附件随 user 消息下发 → mock 流式回答；
//   场景B：追问「有几页」——第二轮请求必须仍带 PDF 附件块（快照方案的核心卖点：字节持久、
//          每轮重注入）；
//   场景C：URL 返回 HTML（非 PDF）→ 明确报错 toast、不建会话；
//   场景D：URL 404 → 报错 toast、不建会话。
// 右键菜单 / 工具栏入口的 SW 侧路由（isPdfUrl）由 scripts/test-llm-unit.mjs 单测覆盖，
// CDP 无法模拟真实右键点击，这里直接以 SW 同款方式写任务（消费端全链路真实）。
// 用法：node scripts/verify-pdf-doc.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, connect, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();

// ---- 本地「PDF 站」 ----
// 最小合法 PDF：管线只校验 %PDF- 魔数，模型附件走原文件字节，mock 不解析内容
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n'
  + '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (PDFDOC-MARKER sample) Tj ET\nendstream endobj\n'
  + 'trailer<</Root 1 0 R/Size 5>>\n%%EOF\n',
  'utf8',
);
const served = [];
const web = createServer((q, r) => {
  served.push(q.url);
  if (q.url.startsWith('/deck.pdf')) {
    r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF_BYTES.length });
    r.end(PDF_BYTES);
    return;
  }
  if (q.url.startsWith('/fake.pdf')) { // 后缀像 PDF、内容是 HTML：错误页伪装
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end('<!doctype html><html><body>登录页</body></html>');
    return;
  }
  r.writeHead(404); r.end('not found');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

// mock LLM：总结类请求回标记；其余默认回答（追问只断言请求形状，不关心回答内容）
const mock = await startMockLlm({
  respond: (req) => {
    const u = [...req.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
    if (u.includes('请总结下面这份 PDF')) return { text: `PDF-SUMMARY-MARKER：本文要点如下。` };
    return { text: 'mock 默认回答' };
  },
});
// 带 PDF 附件块的请求（Anthropic wire：content 数组里有 type:'document'）
const pdfCalls = () => mock.requests.filter((r) => JSON.stringify(r.raw).includes('"document"'));

// SW 同款派发：写一次性任务 + 开聊天页（openPdfJob 的等价复刻，见脚本头注释）
async function dispatchPdfJob(b, jobId, url, action) {
  const sw = await b.sw();
  const before = new Set((await b.targets()).map((t) => t.id));
  await sw.evaluate(`chrome.storage.session.set({ 'omPdfJob:${jobId}': { v: 1, url: '${url}', title: '', action: '${action}', ts: Date.now() } }).then(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/chatpage/chat.html#pdf=${jobId}') })).then(() => 'ok')`);
  sw.close();
  // 聊天页加载即 history.replaceState 剥 hash（防刷新重放），不能按 #pdf=<id> 匹配 target：
  // 记派发前已存在的 target，等「新增的 chat.html 标签页」就绪（webSocketDebuggerUrl 后补齐）
  const t = await waitFor(async () => {
    const x = (await b.targets()).find((x) => !before.has(x.id) && x.url.includes('chat.html') && x.webSocketDebuggerUrl);
    return x || false;
  }, { timeout: 10000 });
  if (!t?.webSocketDebuggerUrl) throw new Error(`PDF 聊天页 target 未就绪: ${jobId}`);
  const page = await connect(t.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await waitFor(() => page.evaluate(`!!document.getElementById('om-engine')`), { timeout: 15000 });
  return page;
}

const b = await launch({ port: 9393 });
try {
  const sw = await b.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [{ id: 'p', name: 'Mock', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'k', models: ['claude-mock'] }],
      activeProviderId: 'p',
      chat: { defaultEngine: 'llm' },
    },
    conversations: [],
  });
  sw.close();

  // ---- 场景A：总结任务完整链路 ----
  const page = await dispatchPdfJob(b, 'pdf-t1', `${BASE}/deck.pdf`, 'summary');
  const E = (x) => page.evaluate(x);
  const pdfConv = async () => JSON.parse(await E(`chrome.storage.local.get('conversations').then((o) => {
    const c = (o.conversations || []).find((c) => (c.items || []).some((i) => i.type === 'question' && i.meta?.kind === 'pdf-doc'));
    return JSON.stringify({ conv: c, q: c?.items.find((i) => i.meta?.kind === 'pdf-doc'), ans: c?.items.find((i) => i.type === 'answer') });
  })`));

  const a1 = await waitFor(async () => {
    const { ans } = await pdfConv();
    return ans?.content?.includes('PDF-SUMMARY-MARKER') ? ans : false;
  }, { timeout: 40000 });
  check('场景A：总结回答流式生成', a1.content.includes('PDF-SUMMARY-MARKER'), (a1.content || '').slice(0, 120));

  const { conv, q } = await pdfConv();
  check('场景A：自动建会话（标题=文件名、LLM 问答引擎）', conv.title === 'deck.pdf' && conv.engine === 'llm'
    && conv.llmMode === 'chat', `title=${conv.title} engine=${conv.engine} llmMode=${conv.llmMode}`);
  const kb = (conv.knowledge || []).find((k) => k.kind === 'snapshot');
  check('场景A：PDF 入会话知识库（快照条目）', kb && kb.name === 'deck.pdf' && kb.handleKind === 'file' && kb.wsPath === 'knowledge/deck.pdf', kb);
  check('场景A：提问带 pdf-doc 元数据（来源链接）', q.meta.url === `${BASE}/deck.pdf` && q.meta.action === 'summary'
    && /请总结下面这份 PDF/.test(q.content), q.meta);
  check('场景A：请求带 PDF 附件块（anthropic document + base64）', pdfCalls().length >= 1
    && JSON.stringify(pdfCalls()[0].raw).includes('"document"')
    && JSON.stringify(pdfCalls()[0].raw).includes('application/pdf')
    && JSON.stringify(pdfCalls()[0].raw).includes('JVBERi0'), `pdfCalls=${pdfCalls().length}`);
  check('场景A：知识库说明进了 system（附件位指引）', JSON.stringify(pdfCalls()[0].raw).includes('文件附件'));
  check('场景A：PDF 站被请求一次（无重试风暴）', served.filter((u) => u.startsWith('/deck.pdf')).length === 1, served);

  // ---- 场景B：追问——第二轮仍带附件（字节在 IndexedDB，每轮重注入） ----
  const callsBefore = pdfCalls().length;
  await E(`(() => { const i = document.getElementById('om-input'); i.value = '这份 PDF 有几页？'; i.dispatchEvent(new Event('input')); document.getElementById('om-send').click(); return 'ok'; })()`);
  const follow = await waitFor(async () => {
    const calls = pdfCalls();
    const last = calls.at(-1);
    if (calls.length <= callsBefore) return false;
    const u = [...last.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
    return u.includes('这份 PDF 有几页') ? last : false;
  }, { timeout: 30000 });
  check('场景B：追问请求仍带 PDF 附件块（字节持久、轮轮重注入）', JSON.stringify(follow.raw).includes('"document"')
    && JSON.stringify(follow.raw).includes('JVBERi0'), `pdfCalls=${pdfCalls().length}`);
  check('场景B：附件挂在 user 消息上（不是 system）', (() => {
    const msgs = follow.raw.messages || [];
    return msgs.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b2) => b2.type === 'document'))
      && !(typeof follow.raw.system === 'string' && follow.raw.system.includes('JVBERi0'));
  })());

  // ---- 场景C：后缀像 PDF、内容是 HTML → 报错、不建会话 ----
  const convCountC = (await JSON.parse(await E(`chrome.storage.local.get('conversations').then((o) => JSON.stringify({ n: (o.conversations || []).length }))`))).n;
  const pageC = await dispatchPdfJob(b, 'pdf-t2', `${BASE}/fake.pdf`, 'summary');
  await waitFor(() => pageC.evaluate(`(document.getElementById('om-toast')?.textContent || '').includes('不是 PDF')`), { timeout: 15000, interval: 150 });
  check('场景C：非 PDF 内容给出明确报错', true);
  const afterC = JSON.parse(await pageC.evaluate(`chrome.storage.local.get('conversations').then((o) => JSON.stringify({ n: (o.conversations || []).length, q: (o.conversations || []).filter((c) => (c.items || []).some((i) => i.meta?.kind === 'pdf-doc')).length }))`));
  check('场景C：不建会话（无半截副作用）', afterC.n === convCountC && afterC.q === 1, afterC);

  // ---- 场景D：HTTP 404 → 报错、不建会话 ----
  const pageD = await dispatchPdfJob(b, 'pdf-t3', `${BASE}/missing.pdf`, 'translate');
  await waitFor(() => pageD.evaluate(`(document.getElementById('om-toast')?.textContent || '').includes('HTTP 404')`), { timeout: 15000, interval: 150 });
  check('场景D：404 给出状态码报错', true);
  const afterD = JSON.parse(await pageD.evaluate(`chrome.storage.local.get('conversations').then((o) => JSON.stringify({ n: (o.conversations || []).length, q: (o.conversations || []).filter((c) => (c.items || []).some((i) => i.meta?.kind === 'pdf-doc')).length }))`));
  check('场景D：不建会话', afterD.n === convCountC && afterD.q === 1, afterD);

  check('无未捕获异常', true);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  await mock.close();
  web.close();
}
process.exit(summary());
