// e2e：超长消息渲染截断（renderBodyInto）——「卡死会话」的恢复验证。
// 存量多 MB 消息（输入上限之前产生）曾让切换回会话就整框卡死：气泡全量软换行排版 O(n)。
// 覆盖：切换秒开、提问 / 回答折叠到 3 万字符 + 截断提示、普通会话无提示、
// 截断只影响显示（追问时 mock 收到的历史仍带完整 200 万字符提问）、页面无未捕获异常。
// 用法：node scripts/verify-render-clamp.mjs
import { launch, sleep, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();
const HUGE_Q = '超长提问正文。HUGE-Q-MARKER ' + '甲'.repeat(2_000_000);
const HUGE_A = '超长回答正文。ANS-MARKER ' + '乙'.repeat(1_000_000);

const mock = await startMockLlm({ respond: () => ({ text: 'mock 默认回答' }) });
const browser = await launch({ port: 9377 });
const exceptions = [];
try {
  const sw = await browser.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [{ id: 'p-a', name: '供应商A', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'ka', models: ['same-model'] }],
      activeProviderId: 'p-a',
      // bridge 指向死端口：本测试只走 LLM，不受本机 bridge 状态影响
      agentBridge: { url: 'ws://127.0.0.1:39299', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' },
    },
    conversations: [
      {
        id: 'conv:big', title: '超长会话', engine: 'llm', llmMode: 'chat', llmProviderId: 'p-a', llmModel: 'same-model', createdAt: 1000, updatedAt: 2000,
        items: [
          { id: 'msg:big-q', type: 'question', content: HUGE_Q, createdAt: 1000, parentItemId: '' },
          { id: 'msg:big-a', type: 'answer', content: HUGE_A, createdAt: 1500, parentItemId: 'msg:big-q', model: 'same-model', error: '', stopped: false },
        ],
      },
      {
        id: 'conv:small', title: '普通会话', engine: 'llm', llmMode: 'chat', createdAt: 500, updatedAt: 600,
        items: [{ id: 'msg:s-q', type: 'question', content: '小问题', createdAt: 500, parentItemId: '' }],
      },
    ],
  });
  sw.close();

  const tab = await browser.openTab(`chrome-extension://${browser.extId}/src/chatpage/chat.html`, { wait: 1800 });
  await tab.send('Log.enable');
  tab.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });
  await waitFor(() => tab.evaluate(`!!document.querySelector('.om-conv-item')`), { timeout: 8000 });

  // 1. 初始落在超长会话：提问 / 回答折叠显示 + 截断提示
  const big = await tab.evaluate(`(() => {
    const q = document.querySelector("[data-item-id='msg:big-q'] .om-body");
    const a = document.querySelector("[data-item-id='msg:big-a'] .om-body");
    return {
      active: document.querySelector('.om-conv-item.om-active')?.dataset.convId || '',
      qLen: q ? q.textContent.length : -1,
      qNote: document.querySelector("[data-item-id='msg:big-q'] .om-clamp-note")?.textContent || '',
      aLen: a ? a.textContent.length : -1,
      aNote: !!document.querySelector("[data-item-id='msg:big-a'] .om-clamp-note"),
    };
  })()`);
  check('初始会话是超长会话', big.active === 'conv:big', big.active);
  check('超长提问折叠到 3 万字符', big.qLen >= 30000 && big.qLen < 31200, `len=${big.qLen}`);
  check('超长提问带截断提示', /共 .+ 字符/.test(big.qNote), big.qNote);
  check('超长回答折叠 + 提示', big.aLen >= 30000 && big.aLen < 31200 && big.aNote, `len=${big.aLen}`);

  // 2. 切换耗时：small → big 秒开（修前 200 万字符提问全量排版要数秒且每次切换重现）
  await tab.evaluate(`document.querySelector("[data-conv-id='conv:small']").click()`);
  await sleep(300);
  const t0 = Date.now();
  await tab.evaluate(`document.querySelector("[data-conv-id='conv:big']").click()`);
  await waitFor(() => tab.evaluate(`!!document.querySelector("[data-item-id='msg:big-q'] .om-clamp-note")`), { timeout: 5000, interval: 50 });
  const switchMs = Date.now() - t0;
  check('切回超长会话秒开（< 800ms）', switchMs < 800, `${switchMs}ms`);

  // 3. 截断只影响显示：在超长会话里追问，mock 收到的历史带完整 200 万字符提问
  const n0 = mock.requests.length;
  await tab.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = '继续'; document.getElementById('om-send').click(); return 1; })()`);
  const req = await waitFor(() => (mock.requests.length > n0 ? mock.requests.at(-1) : null), { timeout: 15000 });
  const maxUser = Math.max(0, ...req.messages.filter((m) => m.role === 'user').map((m) => (m.text || '').length));
  check('发送的历史带全文（> 200 万字符）', maxUser > 1_999_000, `maxUserLen=${maxUser}`);
  check('历史含超长提问标记', req.messages.some((m) => (m.text || '').includes('HUGE-Q-MARKER')));
  await waitFor(() => tab.evaluate(`!document.getElementById('om-send').classList.contains('om-streaming')`), { timeout: 15000 });
  await sleep(500);

  // 4. 普通会话无截断提示
  await tab.evaluate(`document.querySelector("[data-conv-id='conv:small']").click()`);
  await sleep(300);
  const smallNote = await tab.evaluate(`!!document.querySelector('.om-clamp-note')`);
  check('普通会话无截断提示', !smallNote);
  check('页面无未捕获异常', exceptions.length === 0, exceptions.join(' | ').slice(0, 200));
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
}
process.exit(summary());
