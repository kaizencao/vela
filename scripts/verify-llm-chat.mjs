// e2e：LLM 直连聊天 + LLM 任务模式（浏览器工具循环），全程走本地 mock LLM（不产生真实调用）。
// 覆盖：顶栏引擎切换与记忆、同名模型按供应商精确路由、刷新后会话引擎/模型恢复、
// OpenAI 与 Anthropic 两种协议的工具调用、读当前网页、下载文件审批（允许 → 文件真实落盘）、
// 联网读取审批（拒绝不发请求 / 勾选不再询问后自动放行；页面带内联事件处理器时解析不刷 CSP 违例）、
// 流式中停止、停止的工具轮轨迹
// 完整性（残缺轨迹会被服务端 400 拒掉，拼装时修复）、网页总结气泡折叠正文（全文仍发模型）、
// 点击开出新标签页的三种处置（on_new_tab: block/capture/allow）与批量采集自动拦截、
// 页面无未捕获异常。
// 用法：node scripts/verify-llm-chat.mjs
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();
const PAGE_MARKER = 'VELA-PAGE-MARKER-42';
const EXT_MARKER = 'EXT-MARKER-7';

// 被读取的网页 + 外链（计数：验证拒绝时没有发出请求）
let extHits = 0;
const web = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // target=_blank 链接与列表：第 13 节验证点击开出新标签页的三种处置与采集自动拦截
    res.end(`<!doctype html><html><head><title>测试文章</title></head><body><nav>导航</nav><article><h1>测试文章</h1>
<p>这是一段用于验证 LLM 任务模式读取当前网页的正文。${PAGE_MARKER}。</p>
<p>${'填充内容，保证正文长度足够。'.repeat(20)}</p>
<p><a id="nb" href="/detail" target="_blank">打开详情页</a></p>
<ul id="nb-list"><li><a class="nb-item" href="/detail?i=1" target="_blank">条目一</a></li><li><a class="nb-item" href="/detail?i=2" target="_blank">条目二</a></li><li><a class="nb-item" href="/detail?i=3" target="_blank">条目三</a></li></ul></article></body></html>`);
  } else if (req.url.startsWith('/detail')) {
    const id = req.url.includes('i=') ? req.url.split('i=')[1] : '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>详情页${id}</title></head><body><main><p>详情页正文 DETAIL-MARKER-${id || 'main'}。</p></main></body></html>`);
  } else if (req.url === '/ext') {
    extHits++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // 页面带内联事件处理器（on*=）：fetch_url 用 DOMParser 解析时若不先剥掉，
    // 解析出的文档继承扩展页 CSP（script-src 'self'），控制台会刷 CSP 违例噪音
    res.end(`<html><head><title>外链</title><script>var x=1</script></head><body onload="boot()" onmouseover=track()><main onclick="go()"><p>外链正文 ${EXT_MARKER}</p></main></body></html>`);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}`;

const lastResult = (req) => req.messages.at(-1)?.role === 'tool' ? req.messages.at(-1).toolResults : null;
const mock = await startMockLlm({
  respond: (req) => {
    const results = lastResult(req);
    const userText = [...req.messages].reverse().find((m) => m.role === 'user')?.text || '';
    if (/路由测试/.test(userText)) return { text: `[${req.prefix}] 路由OK` };
    if (/请总结下面的网页内容/.test(userText)) return { text: '网页总结完成：这是测试文章的要点。' };
    if (/慢回答/.test(userText)) return { text: '慢'.repeat(1800), chunkDelayMs: 40 };
    if (/总结当前页面/.test(userText)) {
      if (!results) return { text: '我先读取页面。', toolCalls: [{ id: 'tu_page', name: 'get_current_page', arguments: {} }] };
      const m = results[0].content.match(/VELA-PAGE-MARKER-\d+/);
      return { text: `页面标记=${m ? m[0] : '未找到'}` };
    }
    if (/下载报告/.test(userText)) {
      if (!results) return { toolCalls: [{ id: 'tu_dl', name: 'download_file', arguments: { filename: 'vela-report.md', content: '# 报告\nREPORT-BODY' } }] };
      return { text: `下载结果: ${results[0].content}` };
    }
    if (/读外链/.test(userText)) {
      if (!results) return { toolCalls: [{ id: `tu_fetch_${req.messages.length}`, name: 'fetch_url', arguments: { url: `${WEB}/ext` } }] };
      return { text: `外链结果: ${results[0].content.slice(0, 200)}` };
    }
    // 点击开出新标签页：snapshot 拿「打开详情页」锚点序号 → 按 user 指令带 on_new_tab 点击 → 回显结果
    if (/点开详情链接/.test(userText)) {
      if (!results) return { toolCalls: [{ id: 'tu_snap_nb', name: 'snapshot_interactive', arguments: {} }] };
      const m = results[0].content.match(/#(\d+) <a> 打开详情页/);
      const mode = /拦截/.test(userText) ? 'block' : /读取/.test(userText) ? 'capture' : 'allow';
      if (m && mode) return { toolCalls: [{ id: `tu_click_${mode}`, name: 'click_element', arguments: { ref: `#${m[1]}`, on_new_tab: mode } }] };
      return { text: `点击结果: ${results[0].content.slice(0, 300)}` };
    }
    if (/批量采集条目/.test(userText)) {
      if (!results) {
        return {
          toolCalls: [{
            id: 'tu_extract_nb', name: 'extract_click_collect',
            arguments: { recipe: { items: '#nb-list li', click: 'a.nb-item', waitMs: 400, fields: [{ name: 't', selector: 'a.nb-item', rel: 'item' }], itemLimit: 3 } },
          }],
        };
      }
      return { text: `采集结果: ${results[0].content.slice(0, 600)}` };
    }
    // 长任务：模型反复调工具直到本轮攒够 8 条工具结果才收尾——天然跨步数上限，验证「继续」接力。
    // 计数只数最后一条「长任务」user 之后的 tool 消息：原地切换后同一会话带着其他轮次的轨迹，不能全历史数
    if (req.messages.some((m) => m.role === 'user' && /长任务/.test(m.text || ''))) {
      const start = req.messages.map((m) => m.role === 'user' && /长任务/.test(m.text || '')).lastIndexOf(true);
      const done = req.messages.slice(start + 1).filter((m) => m.role === 'tool').length;
      if (done < 8) return { toolCalls: [{ id: `tu_long_${done}`, name: 'get_current_page', arguments: {} }] };
      return { text: `长任务完成：共 ${done} 条工具结果，标记=${PAGE_MARKER}` };
    }
    return { text: 'mock 默认回答' };
  },
});

const downloadDir = mkdtempSync(join(tmpdir(), 'vela-dl-'));
const browser = await launch({ port: 9361, url: `${WEB}/page` });
const exceptions = [];
const securityIssues = []; // CSP 违例等安全类控制台条目（Log 域，Runtime.consoleAPICalled 收不到）
const consoleErrs = []; // 页面 console error / warning（诊断发送被吞一类竞态用）
try {
  const sw = await browser.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [
        { id: 'p-a', name: '供应商A', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'ka', models: ['same-model'] },
        { id: 'p-b', name: '供应商B', kind: 'openai', baseUrl: mock.url('b') + '/v1', apiKey: 'kb', models: ['same-model'] },
        { id: 'p-c', name: '供应商C', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'kc', models: ['claude-mock'] },
      ],
      activeProviderId: 'p-a',
      // bridge 指向死端口：本测试只走 LLM，不受本机 bridge 状态影响
      agentBridge: { url: 'ws://127.0.0.1:39299', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' },
    },
    conversations: [],
  });
  sw.close();

  const openChat = async () => {
    const s = await browser.openTab(`chrome-extension://${browser.extId}/src/chatpage/chat.html`, { wait: 1800 });
    await s.send('Log.enable');
    s.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      if (m.method === 'Log.entryAdded' && m.params.entry?.source === 'security') securityIssues.push(m.params.entry.text);
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) consoleErrs.push((m.params.args || []).map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 200));
    });
    await s.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: false });
    await waitFor(() => s.evaluate(`!!document.getElementById('om-engine')`));
    return s;
  };
  let chat = await openChat();
  const E = (expr) => chat.evaluate(expr);
  const store = async () => JSON.parse(await E(`chrome.storage.local.get(['conversations','llmSettings']).then((o) => JSON.stringify(o))`));
  const setSelect = (id, value) => E(`(() => { const s = document.getElementById('${id}'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
  const sendMsg = (text) => E(`(() => { const i = document.getElementById('om-input'); i.value = ${JSON.stringify(text)}; document.getElementById('om-send').click(); return true; })()`);
  // 发送落地确认：点击后 3s 内用户气泡没涨说明 send 被收尾竞态吞掉，补发一次（先采样现场供诊断）。
  // 每次调用独立取 before 基线，换会话（气泡数清零重来）不受影响；两次都没落地就让 waitAnswer 带现场失败
  const sendAndConfirm = async (text) => {
    const qCount = () => E(`document.querySelectorAll('.om-msg-question').length`);
    const before = await qCount();
    await sendMsg(text);
    let landed = await waitFor(async () => (await qCount()) > before, { timeout: 3000 });
    if (!landed) {
      const snap = await E(`(() => ({ questions: document.querySelectorAll('.om-msg-question').length, streaming: document.getElementById('om-send').classList.contains('om-streaming'), sendLabel: document.getElementById('om-send').textContent.trim(), card: !!document.querySelector('.om-llm-perm'), toast: document.getElementById('om-toast')?.textContent.slice(0, 60) || '', input: document.getElementById('om-input').value.slice(0, 30) }))()`);
      console.log(`[诊断] 发送未落地补发：现场=${JSON.stringify(snap)} 近期console错误=${JSON.stringify(consoleErrs.slice(-3))}`);
      await sendMsg(text);
      landed = await waitFor(async () => (await qCount()) > before, { timeout: 3000 });
    }
    return landed;
  };
  const lastAnswer = () => E(`(() => { const a = [...document.querySelectorAll('.om-msg-answer')].at(-1); return a ? a.querySelector('.om-body').innerText : ''; })()`);
  const answerCount = () => E(`document.querySelectorAll('.om-msg-answer').length`);
  const idle = () => E(`!document.getElementById('om-send').classList.contains('om-streaming')`);
  const waitAnswer = async (re, n) => {
    const ok = await waitFor(async () => (await answerCount()) >= n && re.test(await lastAnswer()) && (await idle()), { timeout: 15000 });
    return { ok: !!ok, text: await lastAnswer() };
  };

  // ---- 1. 引擎下拉 ----
  const opts = JSON.parse(await E(`JSON.stringify([...document.getElementById('om-engine').options].map((o) => [o.value, o.disabled]))`));
  check('顶栏引擎下拉含 Agent / LLM 问答 / LLM 任务且 LLM 可选', JSON.stringify(opts) === JSON.stringify([['agent', false], ['llm', false], ['llm-tools', false]]), opts);
  check('新会话默认 Agent 引擎', (await E(`document.getElementById('om-engine').value`)) === 'agent');
  await setSelect('om-engine', 'llm');
  await sleep(400);
  let st = await store();
  check('空会话切 LLM 问答：原地改引擎', st.conversations.length === 1 && st.conversations[0].engine === 'llm' && st.conversations[0].llmMode === 'chat', st.conversations.map((c) => [c.engine, c.llmMode]));
  check('引擎选择记为新会话默认', st.llmSettings.chat?.defaultEngine === 'llm', st.llmSettings.chat);
  check('LLM 引擎下显示模型下拉、隐藏 agent 下拉', await E(`document.getElementById('om-model').style.display === '' && document.getElementById('om-agent').style.display === 'none'`));

  // ---- 2. 同名模型按供应商路由 ----
  await setSelect('om-model', JSON.stringify(['p-b', 'same-model']));
  await sleep(200);
  const before = mock.requests.length;
  await sendAndConfirm('路由测试');
  let a = await waitAnswer(/路由OK/, 1);
  check('LLM 问答流式回答渲染', a.ok, a.text);
  check('选中「供应商B / same-model」请求精确落到 B（不串到激活的 A）', /^\[b\]/.test(a.text) && mock.requests[before]?.prefix === 'b' && mock.requests[before]?.headers.authorization === 'Bearer kb', a.text);
  check('问答模式请求不带工具', mock.requests[before]?.tools.length === 0);
  st = await store();
  check('会话记住供应商与模型', st.conversations[0].llmProviderId === 'p-b' && st.conversations[0].llmModel === 'same-model');

  // ---- 3. 刷新后恢复 ----
  chat.close();
  chat = await openChat();
  check('刷新后会话引擎恢复为 LLM 问答', (await E(`document.getElementById('om-engine').value`)) === 'llm');
  check('刷新后模型下拉恢复为供应商B', (await E(`document.getElementById('om-model').value`)) === JSON.stringify(['p-b', 'same-model']), await E(`document.getElementById('om-model').value`));
  check('历史回答回放', /路由OK/.test(await lastAnswer()));

  // ---- 4. 任务模式（Anthropic 协议）：读当前网页 ----
  await setSelect('om-engine', 'llm-tools');
  await sleep(400);
  st = await store();
  check('有消息的会话切 LLM 任务：原地切换，历史保留', st.conversations.length === 1 && st.conversations[0].llmMode === 'tools' && st.conversations[0].items.length === 2, st.conversations.map((c) => [c.engine, c.llmMode, c.items.length]));
  await setSelect('om-engine', 'llm');
  await sleep(400);
  st = await store();
  check('切回 LLM 问答：仍原地且历史保留', st.conversations.length === 1 && st.conversations[0].llmMode === 'chat' && st.conversations[0].items.length === 2, st.conversations.map((c) => [c.engine, c.llmMode, c.items.length]));
  await setSelect('om-engine', 'llm-tools');
  await sleep(400);
  await setSelect('om-model', JSON.stringify(['p-c', 'claude-mock']));
  await sleep(200);
  const b2 = mock.requests.length;
  await sendAndConfirm('总结当前页面');
  a = await waitAnswer(/页面标记=/, 1);
  check('任务模式：模型调用 get_current_page 并拿到网页正文（独立聊天页回退到最近网页标签）', a.text.includes(`页面标记=${PAGE_MARKER}`), a.text);
  const toolReq = mock.requests[b2];
  check('任务模式请求带 11 个浏览器工具（Anthropic 协议）', toolReq?.protocol === 'anthropic' && ['get_current_page', 'get_selection', 'list_tabs', 'read_tab', 'fetch_url', 'open_tab', 'download_file', 'snapshot_interactive', 'click_element', 'wait_for', 'extract_click_collect'].every((n) => toolReq.tools.includes(n)), toolReq?.tools);
  check('工具结果按 tool_result 回填', mock.requests[b2 + 1]?.raw.messages.at(-1).content[0].type === 'tool_result');
  const stepTitle = await E(`document.querySelector('.om-msg-answer:last-of-type .om-agent-step-title')?.textContent || ''`);
  check('工具步骤渲染在回答里', /get_current_page/.test(stepTitle), stepTitle);
  st = await store();
  const ans = st.conversations[0].items.at(-1);
  check('工具步骤持久化到 meta.tools', ans.meta?.tools?.steps?.length === 1 && ans.meta.tools.steps[0].status === 'completed', ans.meta);

  // ---- 5. 下载文件：审批允许 → 文件落盘（OpenAI 协议） ----
  await setSelect('om-model', JSON.stringify(['p-a', 'same-model']));
  await sleep(200);
  await sendAndConfirm('下载报告');
  const card = await waitFor(() => E(`document.querySelector('.om-llm-perm .om-perm-title')?.textContent || ''`));
  check('下载文件前弹审批卡', /下载文件 vela-report\.md/.test(card || ''), card);
  await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
  a = await waitAnswer(/下载结果/, 2);
  check('允许后执行下载并回填结果', /已开始下载 vela-report\.md/.test(a.text), a.text);
  // CDP 下载行为会把落盘文件名换成 GUID（downloads 记录里也是 GUID）：只断言下载完成且内容正确，
  // 文件名由上一条「已开始下载 vela-report.md」断言覆盖
  const dl = await waitFor(async () => {
    const r = JSON.parse(await E(`chrome.downloads.search({}).then((l) => JSON.stringify(l.map((d) => d.state)))`));
    return r.includes('complete') ? r : null;
  }, { timeout: 8000 });
  const files = readdirSync(downloadDir);
  const body = files.map((f) => readFileSync(join(downloadDir, f), 'utf8')).join('\n');
  check('文件真实落盘且内容正确', !!dl && body.includes('REPORT-BODY'), { dl, files });

  // ---- 6. 联网读取：拒绝不发请求；勾选不再询问后自动放行 ----
  await sendAndConfirm('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`document.querySelector('.om-llm-perm .om-perm-deny').click()`);
  a = await waitAnswer(/外链结果/, 3);
  check('拒绝后工具不执行（外链未被请求）且模型收到拒绝结果', extHits === 0 && /拒绝/.test(a.text), `${extHits} ${a.text}`);
  await sendAndConfirm('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`(() => { const c = document.querySelector('.om-llm-perm'); c.querySelector('input[type=checkbox]').checked = true; c.querySelector('.om-perm-allow').click(); })()`);
  a = await waitAnswer(new RegExp(EXT_MARKER), 4);
  check('允许后联网读取，HTML 转成正文（脚本被剔除）', extHits === 1 && a.text.includes(EXT_MARKER) && !a.text.includes('var x'), a.text);
  await sendAndConfirm('读外链');
  a = await waitAnswer(/外链结果/, 5);
  if (!a.ok) {
    // 竞态诊断：回答没等到时拿现场——气泡数、按钮状态、mock 是否收到请求、落库条目、console 错误；
    // 再等 3s 二次采样，区分「永久卡死」与「迟到完成」
    const dump = async (tag) => {
      const snap = await E(`(() => ({ answers: document.querySelectorAll('.om-msg-answer').length, questions: document.querySelectorAll('.om-msg-question').length, lastAnswerLen: ([...document.querySelectorAll('.om-msg-answer')].at(-1)?.querySelector('.om-body')?.innerText || '').length, streaming: document.getElementById('om-send').classList.contains('om-streaming'), sendLabel: document.getElementById('om-send').textContent.trim(), card: !!document.querySelector('.om-llm-perm'), toast: document.getElementById('om-toast')?.textContent.slice(0, 60) || '' }))()`);
      const items = await E(`(async () => { const { conversations } = await chrome.storage.local.get(['conversations']); const c = conversations[0]; return { convs: conversations.length, items: c?.items?.length, types: (c?.items || []).map((i) => i.type).join(','), lastLen: (c?.items || []).at(-1)?.content?.length ?? -1 }; })()`);
      console.log(`[诊断:${tag}] 现场=${JSON.stringify(snap)} 落库=${JSON.stringify(items)} mock请求数=${mock.requests.length} 末请求末条=${JSON.stringify(String((mock.requests.at(-1)?.messages || []).at(-1)?.content || '')).slice(0, 120)} 近期console错误=${JSON.stringify(consoleErrs.slice(-5))}`);
    };
    await dump('t0');
    await sleep(3000);
    await dump('t3');
  }
  const sawCard = await E(`!!document.querySelector('.om-llm-perm')`);
  check('勾选「本对话不再询问」后同类操作自动放行', a.ok && extHits === 2 && !sawCard, `hits=${extHits} sawCard=${sawCard} ok=${a.ok} a=${(a.text || '').slice(0, 120)}`);

  // ---- 6b. 权限档贯通 LLM 任务：自动放行不弹审批卡；自动接受编辑只免文件写入 ----
  await setSelect('om-perm', 'bypassPermissions');
  await sleep(300);
  st = await store();
  check('权限档写回会话（bypassPermissions）', st.conversations[0].permissionMode === 'bypassPermissions', st.conversations[0].permissionMode);
  await sendAndConfirm('下载报告');
  a = await waitAnswer(/下载结果/, 7);
  check('自动放行：下载文件不再弹审批卡、直接执行', a.ok && !await E(`!!document.querySelector('.om-llm-perm')`), a.text);
  await setSelect('om-perm', 'acceptEdits');
  await sleep(300);
  await sendAndConfirm('下载报告');
  const cardEdits = await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`), { timeout: 8000 });
  check('自动接受编辑：download_file 非文件写入，仍弹审批卡', !!cardEdits);
  await E(`document.querySelector('.om-llm-perm .om-perm-deny').click()`);
  a = await waitAnswer(/下载结果/, 8);
  check('自动接受编辑下拒绝后工具不执行、结果回填', /拒绝/.test(a.text), a.text);
  await setSelect('om-perm', 'default');
  await sleep(300);

  // ---- 7. 流式中停止 ----
  await setSelect('om-engine', 'llm');
  await sleep(400);
  // 等待锚定新回答：原地切换后会话带着上一轮的回答，lastAnswer 不能再当「正在流式的那条」用
  const answersBefore = await E(`document.querySelectorAll('.om-msg-answer').length`);
  await sendAndConfirm('慢回答');
  await waitFor(async () => (await E(`document.querySelectorAll('.om-msg-answer').length`)) === answersBefore + 1 && (await lastAnswer()).length > 5);
  await E(`document.getElementById('om-send').click()`); // 流式中发送按钮即停止
  await waitFor(() => idle());
  await sleep(600);
  const stopped = await E(`!![...document.querySelectorAll('.om-msg-answer')].at(-1)?.querySelector('.om-stopped')`);
  const len = (await lastAnswer()).length;
  check('流式中点停止：回答截断并标记已停止', stopped && len > 0 && len < 1800, `stopped=${stopped} len=${len}`);

  // ---- 8. 设置页 ----
  const opt = await browser.openTab(`chrome-extension://${browser.extId}/src/options/options.html`, { wait: 1500 });
  const ov = JSON.parse(await opt.evaluate(`JSON.stringify([document.getElementById('om-chat-engine').value, document.getElementById('om-chat-maxsteps').value])`));
  check('设置页显示顶栏记住的默认引擎与步数上限', ov[0] === 'llm' && ov[1] === '12', ov);
  await opt.evaluate(`(() => { const s = document.getElementById('om-chat-engine'); s.value = 'llm-tools'; s.dispatchEvent(new Event('change')); document.getElementById('om-chat-maxsteps').value = '5'; document.getElementById('om-save').click(); return 1; })()`);
  await sleep(1200);
  st = await store();
  check('设置页保存聊天引擎默认值与步数上限，不丢其他设置', st.llmSettings.chat?.defaultEngine === 'llm-tools' && st.llmSettings.chat?.toolMaxSteps === 5 && st.llmSettings.providers.length === 3, st.llmSettings.chat);
  opt.close();

  // ---- 9. 页内聊天卡（扩展源 iframe 嵌在网页里）：任务模式读宿主页 ----
  {
    const pageT = (await browser.targets()).find((t) => t.type === 'page' && t.url === `${WEB}/page`);
    await browser.activate(pageT.id);
    await sleep(500);
    const sw2 = await browser.sw();
    await sw2.evaluate(`chrome.tabs.query({ url: '${WEB}/page' }).then(([t]) => chrome.tabs.sendMessage(t.id, { type: 'om:open-card' })).then(() => 'ok')`);
    sw2.close();
    const cardT = await waitFor(async () => (await browser.targets()).find((t) => t.type === 'iframe' && t.url.includes('/src/sidepanel/sidepanel.html')), { timeout: 10000 });
    check('页内聊天卡 iframe 打开', !!cardT, cardT?.url);
    if (cardT) {
      const { connect } = await import('./lib/cdp.mjs');
      const card = await connect(cardT.webSocketDebuggerUrl);
      await card.send('Runtime.enable');
      await waitFor(() => card.evaluate(`!!document.getElementById('om-engine')`));
      // 聊天卡按宿主页绑定会话：该网页第一次开卡 → 新建绑页会话（pageKey + 宿主页标题），
      // 不再串独立聊天页正在聊的会话
      const cardConv = await waitFor(async () => {
        const cs = await store();
        return cs.conversations.find((c) => (c.pageKey || '').includes('/page') && c.pageCtx?.url === `${WEB}/page`) || null;
      }, { timeout: 6000 });
      check('聊天卡为宿主页新建绑定会话（pageKey + 宿主页标题）',
        !!cardConv && cardConv.items.length === 0 && cardConv.title === '测试文章',
        (await store()).conversations.map((c) => [c.title, c.pageKey]));
      check('新会话引擎用当前默认（llm-tools）', (await card.evaluate(`document.getElementById('om-engine').value`)) === 'llm-tools');
      await card.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = '总结当前页面'; document.getElementById('om-send').click(); return 1; })()`);
      const got = await waitFor(async () => {
        const t = await card.evaluate(`[...document.querySelectorAll('.om-msg-answer')].at(-1)?.querySelector('.om-body').innerText || ''`);
        return /页面标记=/.test(t) && t;
      }, { timeout: 15000 });
      check('聊天卡任务模式读到宿主网页正文', (got || '').includes(`页面标记=${PAGE_MARKER}`), got);
      card.close();
    }
  }

  // ---- 10. 步数上限暂停与「继续」（设置即时生效 + 轨迹回传） ----
  // 本节开始前设置页已把 toolMaxSteps 存为 5（第 8 节），聊天窗在保存前就开着：
  // 暂停提示必须写「最多 5 步」——验证发送时读当前值，而不是初始化时的旧值 12
  await setSelect('om-engine', 'llm-tools'); // 有消息的会话上切任务模式：原地切换（历史带着前几轮的轨迹，mock 计数只看本轮）
  await sleep(400);
  await setSelect('om-model', JSON.stringify(['p-a', 'same-model']));
  await sleep(200);
  const beforeLong = mock.requests.length;
  await sendAndConfirm('长任务');
  a = await waitAnswer(/最多 5 步工具调用/, 1);
  check('步数用尽暂停，提示当前上限（设置页改动对已开聊天窗即时生效）', a.ok, a.text);
  const usedInFirst = mock.requests.slice(beforeLong).filter((r) => r.messages.some((m) => m.role === 'user' && /长任务/.test(m.text || ''))).length;
  check('第一轮正好用满 5 步', usedInFirst === 5, `requests=${usedInFirst}`);
  await sendAndConfirm('继续');
  a = await waitAnswer(/长任务完成/, 2);
  check('「继续」从中断处接着做并完成任务', a.ok && a.text.includes(`标记=${PAGE_MARKER}`), a.text);
  // 继续轮的第一个请求必须在「长任务」与「继续」之间带着上一轮全部 5 条工具结果（trail 回传；
  // 原地切换后请求里还有更早轮次的 tool 消息，只数这两条 user 消息之间的）
  const contReq = mock.requests.find((r) => r.messages.some((m) => m.role === 'user' && m.text === '继续'));
  const cm = contReq?.messages ?? [];
  const contIdx = cm.findIndex((m) => m.role === 'user' && m.text === '继续');
  const longIdx = cm.map((m) => m.role === 'user' && /长任务/.test(m.text || '')).lastIndexOf(true);
  const carried = contIdx > longIdx ? cm.slice(longIdx + 1, contIdx).filter((m) => m.role === 'tool').length : -1;
  check('继续轮把上一轮工具结果原样带回模型（不从头再来）', carried === 5, `carried=${carried}`);
  st = await store();
  // 聊天卡的绑页会话（第 9 节建）可能排在会话列表最前，不能按 [0] 取——锚定含「长任务」的会话
  const longConv = st.conversations.find((c) => c.items.some((i) => i.type === 'question' && /长任务/.test(i.content || '')));
  const trails = longConv.items.map((i) => i.meta?.tools?.trail?.length ?? 0);
  // 同一会话里更早的轮次也有轨迹；trail 按 wire 消息计（每工具 2 条 + 收尾 assistant 1 条），
  // 本节落点是最后两份：长任务暂停轮 5 调用=10 条、继续轮 3 调用+收尾=7 条
  const nz = trails.filter((n) => n >= 2);
  check('消息轨迹持久化到 meta.tools.trail（长任务与继续轮各一份）', nz.length >= 2 && nz[nz.length - 2] === 10 && nz[nz.length - 1] === 7, JSON.stringify(trails));

  // ---- 11. 停止的工具轮不毒化会话：落库轨迹完整 + 残缺轨迹拼装时被修复 ----
  // 真实事故：旧版本停止轮存下「assistant 带工具调用却没有结果消息」的轨迹，之后这个
  // 会话的每次请求都被服务端 400 拒掉（An assistant message with 'tool_calls' must be
  // followed by tool messages…），「请继续」永远失败。
  // 新开对话跑：原地切换后本会话带着第 6 节勾选的「本对话不再询问」，审批卡不再弹。
  // 会话定位显式锚定（绑页会话可能占 conversations[0]，不能按序号取）
  await E(`document.getElementById('om-new').click()`);
  await sleep(600);
  const activeId = await E(`document.querySelector('.om-conv-item.om-active')?.dataset.convId || ''`);
  await sendAndConfirm('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`document.getElementById('om-send').click()`); // 审批卡上直接停止
  await waitFor(() => idle());
  await sleep(600);
  st = await store();
  const stoppedTrail = st.conversations.find((c) => c.id === activeId).items.at(-1)?.meta?.tools?.trail ?? [];
  const answeredIds = new Set(stoppedTrail.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  check('审批卡上停止：落库轨迹每个工具调用都有结果消息', stoppedTrail
    .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    .every((m) => m.toolCalls.every((c) => answeredIds.has(c.id))), JSON.stringify(stoppedTrail));
  // 模拟旧版本毒数据：把停止轮轨迹里的 tool 消息全部删掉，再重发——拼装时必须修复
  await E(`chrome.storage.local.get(['conversations']).then((o) => {
    const convs = o.conversations;
    const cv = convs.find((c) => c.id === ${JSON.stringify(activeId)});
    const it = cv.items.at(-1);
    it.meta.tools.trail = (it.meta.tools.trail ?? []).filter((m) => m.role !== 'tool');
    return chrome.storage.local.set({ conversations: convs });
  })`);
  await sleep(800); // 等 storage.onChanged 防抖同步进内存
  const beforeRetry = mock.requests.length;
  await sendAndConfirm('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
  a = await waitAnswer(/外链结果/, 2); // 新对话：停止轮 + 修复重试轮共 2 份回答
  check('残缺轨迹修复后请求不再 400，任务继续完成', a.ok, a.text);
  // 重试轮的第一个请求：assistant.tool_calls 必须紧跟覆盖每个 id 的 tool 响应
  const retryReq = mock.requests.slice(beforeRetry).find((r) => r.messages.at(-1)?.role === 'user' && /读外链/.test(r.messages.at(-1).text || ''));
  let wireOk = true;
  if (retryReq) {
    const msgs = retryReq.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      const need = new Set(m.toolCalls.map((c) => c.id));
      for (let j = i + 1; j < msgs.length && need.size; j++) {
        if (msgs[j].role !== 'tool') break;
        for (const tr of msgs[j].toolResults ?? []) need.delete(tr.id);
      }
      if (need.size) wireOk = false;
    }
  }
  check('重试请求的每个工具调用都有结果消息（残缺轨迹在拼装时修复）', !!retryReq && wireOk, `found=${!!retryReq}`);

  // ---- 12. 网页总结：气泡折叠正文，全文仍发给模型 ----
  // 经真实 pendingTask 管线触发（右键菜单/浮窗「总结此页」同路径）：活动标签切回网页，
  // 聊天卡（可见实例）消费任务，summarizeCurrentTab 注入活动网页提取正文
  {
    const pageT = (await browser.targets()).find((t) => t.type === 'page' && t.url === `${WEB}/page`);
    await browser.activate(pageT.id);
    await sleep(600);
    const sw3 = await browser.sw();
    await sw3.evaluate(`chrome.tabs.query({ url: '${WEB}/page' }).then(([t]) => chrome.tabs.sendMessage(t.id, { type: 'om:open-card' })).then(() => 'ok')`);
    sw3.close();
    const cardT = await waitFor(async () => (await browser.targets()).find((t) => t.type === 'iframe' && t.url.includes('/src/sidepanel/sidepanel.html')), { timeout: 10000 });
    check('网页总结：聊天卡就绪', !!cardT, cardT?.url);
    if (cardT) {
      const { connect } = await import('./lib/cdp.mjs');
      const card = await connect(cardT.webSocketDebuggerUrl);
      await card.send('Runtime.enable');
      await waitFor(() => card.evaluate(`!!document.getElementById('om-engine')`));
      // 会话内做总结（引擎切 LLM 问答：原地切换，总结追加在既有消息之后，断言都取 .at(-1)）
      await card.evaluate(`(() => { const s = document.getElementById('om-engine'); s.value = 'llm'; s.dispatchEvent(new Event('change')); return 1; })()`);
      await sleep(500);
      const sw4 = await browser.sw();
      await sw4.evaluate(`chrome.storage.session.set({ pendingTask: { kind: 'page-summary' } }).then(() => 'ok')`);
      sw4.close();
      const cap = await waitFor(() => card.evaluate(`[...document.querySelectorAll('.om-msg-question')].at(-1)?.querySelector('.om-summary-cap')?.textContent || ''`), { timeout: 15000 });
      check('网页总结：气泡渲染折叠指令行（不再铺整页正文）', cap === '总结这个网页', cap);
      const bubble = await card.evaluate(`(() => {
        const el = [...document.querySelectorAll('.om-msg-question')].at(-1);
        return {
          chip: el.querySelector('.om-chip a')?.textContent || '',
          open: el.querySelector('.om-summary-src')?.open ?? null,
          leaked: [...el.querySelectorAll('.om-body')].some((b) => b.textContent.includes('${PAGE_MARKER}')),
          summaryLine: el.querySelector('.om-summary-src summary')?.textContent || '',
        };
      })()`);
      check('网页总结：来源 chip 显示网页标题', bubble.chip === '测试文章', bubble);
      check('网页总结：正文默认折叠、指令行不含正文标记', bubble.open === false && !bubble.leaked, bubble);
      check('网页总结：折叠行标注正文字数', /网页正文 · \d+ 字/.test(bubble.summaryLine), bubble.summaryLine);
      await card.evaluate(`[...document.querySelectorAll('.om-msg-question')].at(-1)?.querySelector('.om-summary-src summary').click()`);
      const exp = await card.evaluate(`(() => {
        const el = [...document.querySelectorAll('.om-msg-question')].at(-1);
        return { open: el.querySelector('.om-summary-src')?.open, has: (el.querySelector('.om-agent-thought-body')?.textContent || '').includes('${PAGE_MARKER}') };
      })()`);
      check('网页总结：点开折叠可查看完整 prompt', exp.open === true && exp.has, exp);
      const ans = await waitFor(async () => {
        const t = await card.evaluate(`[...document.querySelectorAll('.om-msg-answer')].at(-1)?.querySelector('.om-body').innerText || ''`);
        return /网页总结完成/.test(t) && t;
      }, { timeout: 15000 });
      check('网页总结：模型流式回复渲染', /网页总结完成/.test(ans || ''), ans);
      const req = mock.requests.slice().reverse().find((r) => r.messages.some((m) => m.role === 'user' && /请总结下面的网页内容/.test(m.text || '')));
      const full = req?.messages.find((m) => m.role === 'user' && /请总结下面的网页内容/.test(m.text || ''));
      check('网页总结：发给模型的消息仍是完整 prompt（含全文）', !!full && full.text.includes(PAGE_MARKER), `len=${full?.text?.length ?? 0}`);
      st = await store();
      const sItem = st.conversations.flatMap((c) => c.items).find((i) => i.meta?.kind === 'page-summary');
      check('网页总结：落库 content 全文 + meta.chars 字数', !!sItem && sItem.content.includes(PAGE_MARKER) && typeof sItem.meta.chars === 'number' && sItem.meta.chars > 0, { chars: sItem?.meta?.chars });
      card.close();
    }
  }

  // ---- 13. 点击开出新标签页的三种处置（on_new_tab）+ 批量采集自动拦截 ----
  // target=_blank 锚点点击：block 开了立即关、capture 读取正文后关闭（正文随工具结果
  // 返回）、allow 保留；extract_click_collect 循环里开出的一律拦截。护栏只碰
  // openerTabId == 源标签页的新建页，源标签页（fixture /page）必须始终存活。
  {
    await E(`document.getElementById('om-new').click()`);
    await sleep(600);
    await setSelect('om-engine', 'llm-tools');
    await sleep(300);
    await waitFor(() => E(`!!document.getElementById('om-perm')`));
    await setSelect('om-perm', 'bypassPermissions'); // 免审批卡，护栏行为直接验证
    const detailTabs = async () => (await browser.targets()).filter((t) => t.type === 'page' && t.url.startsWith(`${WEB}/detail`));
    const pageAlive = async () => (await browser.targets()).some((t) => t.type === 'page' && t.url === `${WEB}/page`);

    // A. block：开了立即关
    let n0 = await answerCount();
    await sendAndConfirm('点开详情链接：拦截新标签页');
    a = await waitAnswer(/点击结果/, n0 + 1);
    await waitFor(async () => (await detailTabs()).length === 0, { timeout: 6000 }).catch(() => {});
    check('on_new_tab=block：新标签页被拦截关闭，工具结果带拦截说明', a.ok && a.text.includes('已拦截并关闭新标签页') && (await detailTabs()).length === 0, a.text);
    check('block：源标签页不受影响', await pageAlive());

    // B. capture：读取正文后关闭，正文进工具结果
    n0 = await answerCount();
    await sendAndConfirm('点开详情链接：读取后关闭新标签页');
    a = await waitAnswer(/点击结果/, n0 + 1);
    await sleep(400);
    check('on_new_tab=capture：新标签页正文随工具结果返回', a.ok && a.text.includes('DETAIL-MARKER'), a.text.slice(0, 200));
    check('capture：读完即关，不留标签页', (await detailTabs()).length === 0);
    check('capture：源标签页不受影响', await pageAlive());

    // C. allow：保留
    n0 = await answerCount();
    await sendAndConfirm('点开详情链接：保留新标签页');
    a = await waitAnswer(/点击结果/, n0 + 1);
    const kept = await waitFor(async () => (await detailTabs()).length === 1, { timeout: 6000 }).catch(() => null);
    check('on_new_tab=allow：新标签页保留', !!kept, JSON.stringify((await detailTabs()).map((t) => t.url)));
    check('allow：源标签页不受影响', await pageAlive());
    const dts = await detailTabs();
    if (dts.length) await fetch(`${browser.base}/json/close/${dts[0].id}`);
    await sleep(600); // 关掉后 /page 重新成为活动标签，下一节的 currentTab 才落对

    // D. extract_click_collect：循环里点击开出的新标签页一律拦截，采集照常
    n0 = await answerCount();
    await sendAndConfirm('批量采集条目列表：拦截所有新标签页');
    a = await waitAnswer(/采集结果/, n0 + 1);
    await sleep(400);
    const blockedN = (a.text.match(/已拦截并关闭新标签页/g) || []).length;
    check('extract 循环：新标签页被拦截、采集照常 3 行', a.ok && /采集完成：3 行 \/ 1 页/.test(a.text) && blockedN >= 1 && (await detailTabs()).length === 0, `blocked=${blockedN} ${a.text.slice(0, 600)}`);
    check('extract 循环：源标签页不受影响', await pageAlive());
  }

  check('联网读取解析 HTML 不刷 CSP 违例（内联事件处理器在字符串层剥掉）', !securityIssues.some((t) => /Content Security Policy/i.test(t)), securityIssues);
  check('聊天页无未捕获异常', exceptions.length === 0, exceptions);
  chat.close();
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
  await mock.close();
  web.close();
  rmSync(downloadDir, { recursive: true, force: true });
}
process.exit(summary());
