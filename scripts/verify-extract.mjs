// e2e：LLM 任务模式循环点击采集（snapshot_interactive / click_element / wait_for / extract_click_collect）。
// 本地 fixture：5 项列表 × 2 页（整页跳转翻页），点开列表项后项内 .detail 填充详情文字；
// mock LLM 驱动两条链路：「快照 → 配方批量采集（逐项点击×2页）→ 汇总」与
// 「快照 → click_element 按 ref 点开折叠面板 → wait_for 等文本出现」。全程本地 mock，不产生真实调用。
// 用法：node scripts/verify-extract.mjs
import { createServer } from 'node:http';
import { sleep, launch, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();

const listPage = (page) => {
  const rows = Array.from({ length: 5 }, (_, k) => {
    const n = (page - 1) * 5 + k + 1;
    return `<li><button class="it">项目${n}</button><div class="detail"></div></li>`;
  }).join('');
  const next = page < 2 ? '<a id="next" href="?page=2">下一页</a>' : '<span class="end">没有更多</span>';
  return `<!doctype html><html><head><title>采集测试列表（第${page}页）</title></head><body>
<ul id="plist">${rows}</ul>${next}
<button id="panel-btn">折叠面板</button><div id="panel" style="display:none">面板内容-OK</div>
<script>
var PAGE = ${page};
document.querySelectorAll('#plist > li').forEach(function (li, k) {
  var n = (PAGE - 1) * 5 + k + 1;
  li.querySelector('button.it').addEventListener('click', function () {
    li.querySelector('.detail').textContent = 'DETAIL-' + n + '-MARKER 详情文字';
  });
});
document.getElementById('panel-btn').addEventListener('click', function () {
  var p = document.getElementById('panel');
  p.style.display = p.style.display === 'none' ? '' : 'none';
});
</script></body></html>`;
};
const web = createServer((req, res) => {
  const m = req.url.match(/^\/list\?page=(\d+)$/);
  if (m) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(listPage(Number(m[1])));
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}`;

// 配方与 fixture 一一对应：逐项点 button.it 等详情出现，读项内两个字段，a#next 翻页
const RECIPE = {
  items: '#plist > li',
  click: 'button.it',
  waitSelector: '.detail:not(:empty)',
  waitMs: 300,
  rel: 'item',
  fields: [{ name: '名称', selector: 'button.it' }, { name: '详情', selector: '.detail' }],
  itemLimit: 10,
  intervalMs: 50,
  next: { click: 'a#next', waitMs: 300, maxPages: 5 },
};

const mock = await startMockLlm({
  respond: (req) => {
    const userText = [...req.messages].reverse().find((m) => m.role === 'user')?.text || '';
    // 轮次按「最后一条 user 消息之后」的 tool 消息数判断——同一会话连发两个任务，
    // 前一个任务的 tool 消息还留在历史里，累计计数会把后一个任务的起点顶错
    const lastUserIdx = req.messages.map((m) => m.role).lastIndexOf('user');
    const turn = req.messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool').length;
    const last = req.messages.at(-1)?.role === 'tool' ? req.messages.at(-1).toolResults.at(-1).content : '';
    if (/循环采集列表/.test(userText)) {
      if (turn === 0) return { toolCalls: [{ id: 't1', name: 'snapshot_interactive', arguments: {} }] };
      if (turn === 1) {
        if (!/项目1/.test(last) || !/#1/.test(last)) return { text: '快照缺元素：' + last.slice(0, 120) };
        return { toolCalls: [{ id: 't2', name: 'extract_click_collect', arguments: { recipe: RECIPE } }] };
      }
      const stat = last.match(/采集完成：\d+ 行 \/ \d+ 页/);
      return { text: `采集汇总：${last.includes('DETAIL-1-MARKER') ? '首页详情在' : '首页详情缺'}，${last.includes('DETAIL-10-MARKER') ? '第二页详情在' : '第二页详情缺'}，${stat ? stat[0] : '无统计'}` };
    }
    if (/点开折叠面板/.test(userText)) {
      if (turn === 0) return { toolCalls: [{ id: 'c1', name: 'snapshot_interactive', arguments: { max_items: 150 } }] };
      if (turn === 1) {
        const m = last.match(/#(\d+) <button> 折叠面板/);
        if (!m) return { text: '快照里没找到折叠面板：' + last.slice(0, 200) };
        return { toolCalls: [{ id: 'c2', name: 'click_element', arguments: { ref: `#${m[1]}` } }] };
      }
      if (turn === 2) return { toolCalls: [{ id: 'c3', name: 'wait_for', arguments: { text: '面板内容-OK', timeout_ms: 3000 } }] };
      const tools = req.messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool').map((m) => m.toolResults.at(-1).content);
      return { text: `点击链路: ${tools.join(' | ')}` };
    }
    return { text: 'mock 默认回答' };
  },
});

const browser = await launch({ port: 9373, url: `${WEB}/list?page=1` });
const exceptions = [];
try {
  const sw = await browser.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [
        { id: 'p-a', name: '供应商A', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'ka', models: ['extract-mock'] },
      ],
      activeProviderId: 'p-a',
      agentBridge: { url: 'ws://127.0.0.1:39299', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' },
    },
    conversations: [],
  });
  sw.close();

  const chat = await browser.openTab(`chrome-extension://${browser.extId}/src/chatpage/chat.html`, { wait: 1800 });
  chat.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });
  await waitFor(() => chat.evaluate(`!!document.getElementById('om-engine')`));
  const E = (expr) => chat.evaluate(expr);
  const store = async () => JSON.parse(await E(`chrome.storage.local.get(['conversations']).then((o) => JSON.stringify(o))`));
  const setSelect = (id, value) => E(`(() => { const s = document.getElementById('${id}'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
  const sendMsg = (text) => E(`(() => { const i = document.getElementById('om-input'); i.value = ${JSON.stringify(text)}; document.getElementById('om-send').click(); return true; })()`);
  const lastAnswer = () => E(`(() => { const a = [...document.querySelectorAll('.om-msg-answer')].at(-1); return a ? a.querySelector('.om-body').innerText : ''; })()`);
  const answerCount = () => E(`document.querySelectorAll('.om-msg-answer').length`);
  const idle = () => E(`!document.getElementById('om-send').classList.contains('om-streaming')`);
  const waitAnswer = async (re, n, timeout = 30000) => {
    const ok = await waitFor(async () => (await answerCount()) >= n && re.test(await lastAnswer()) && (await idle()), { timeout });
    return { ok: !!ok, text: await lastAnswer() };
  };

  await setSelect('om-engine', 'llm-tools');
  await sleep(400);

  // ---- 1. 快照 → 配方批量采集（审批允许）→ 汇总 ----
  await sendMsg('循环采集列表');
  const card1 = await waitFor(() => E(`document.querySelector('.om-llm-perm .om-perm-title')?.textContent || ''`), { timeout: 12000 });
  check('批量采集前弹审批卡，文案带项数与页数', /批量点击采集页面数据（约 10 项 × 最多 5 页）/.test(card1 || ''), { card1, reqs: mock.requests.length });
  if (/批量点击采集页面数据/.test(card1 || '')) await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
  const a1 = await waitAnswer(/采集汇总：/, 1);
  check('采集汇总：两页详情都在、统计 10 行 2 页', a1.ok && a1.text.includes('首页详情在，第二页详情在，采集完成：10 行 / 2 页'), {
    ok: a1.ok,
    text: a1.text,
    reqs: mock.requests.length,
    exceptions,
  });
  const collectReq = mock.requests.find((r) => r.messages.at(-1)?.role === 'tool' && /采集完成/.test(r.messages.at(-1).toolResults?.[0]?.content || ''));
  const rows = collectReq?.messages.at(-1).toolResults[0].content || '';
  check('首行落在第 1 页且字段齐（点击确实发生后才读到详情）', rows.includes('{"_page":1,"_item":1,"名称":"项目1","详情":"DETAIL-1-MARKER 详情文字"}'), rows.slice(0, 200));
  check('末行落在第 2 页（整页跳转翻页后继续采集）', rows.includes('"_page":2') && rows.includes('DETAIL-10-MARKER'), rows.slice(-200));
  const st1 = await store();
  const steps1 = st1.conversations[0].items.find((x) => x.meta?.tools?.steps)?.meta.tools.steps || [];
  check('工具步骤持久化：快照与批量采集各一步、状态完成', steps1.map((s) => (s.title || '').split(':')[0].trim()).join(',') === 'snapshot_interactive,extract_click_collect' && steps1.every((s) => s.status === 'completed'), {
    steps: steps1.map((s) => [s.title, s.status]),
    items: st1.conversations[0].items.map((x) => [x.role, Object.keys(x.meta || {})]),
  });

  // ---- 2. 快照 → click_element 按 ref 点击 → wait_for 等文本 ----
  await sleep(600); // 等收尾持久化与发送键状态复位
  await sendMsg('点开折叠面板');
  // 观察器：高频记录审批卡出现并自动放行（完整时间线留在 trace 供断言 dump）
  const trace = [];
  await waitFor(async () => {
    const t = await E(`document.querySelector('.om-llm-perm .om-perm-title')?.textContent || ''`);
    if (t && (!trace.length || trace.at(-1).t !== t)) trace.push({ t });
    if (/点击页面元素 #\d+/.test(t || '')) {
      await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
      trace.push({ t: '>>> 已点允许' });
      return true;
    }
    return false;
  }, { timeout: 20000, interval: 150 });
  check('click_element 弹审批卡，文案点名元素', trace.some((x) => /点击页面元素 #\d+/.test(x.t)), {
    trace,
    reqs: mock.requests.length,
    answer: await lastAnswer(),
    exceptions,
  });
  const a2 = await waitAnswer(/点击链路:/, 2);
  check('click_element 按 ref 点开面板且 wait_for 等到文本出现', a2.ok && /已点击 折叠面板/.test(a2.text) && /信号已出现/.test(a2.text), a2.text);

  check('全程无未捕获异常', exceptions.length === 0, exceptions);
  chat.close();
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
  await mock.close();
  web.close();
}
process.exit(summary());
