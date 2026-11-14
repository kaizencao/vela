# Vela 设计

## 需求

参考 Monica 的交互形态做自用 Chrome AI 助手：侧边栏 + 独立聊天页 + 会话管理 + 流式输出 + 网页级功能（总结/翻译/选中快捷动作）。LLM 层自定义：设置页维护多个供应商（Base URL + Key + 模型），兼容 OpenAI 与 Anthropic 两种协议，替换 Monica 的服务端私有协议。所有数据本地存储，无服务端。

## 总体架构

```
manifest.json
├─ background service worker   右键菜单组 / 页面浮窗动作 / pendingTask 中转 / 快捷键（无网络职责）
├─ side panel  ─┐
├─ chat page   ─┼─ shell.js（DOM 骨架）+ chat-ui.js（交互）
└─ options page ┘     ├─ llm/（streamChat 入口 → 适配器；tasks.js 纯函数）
│                     ├─ page/page-actions.js（页面功能编排）
│                     └─ agent/（bridge WS 客户端 + 事件渲染状态机）
├─ content/widget.js   页面常驻浮窗（registerContentScripts，http(s)，动作交 SW 中转）
├─ chrome.scripting 按需注入（用户触发）
│    ├─ content/injected.js   自包含提取函数（func 注入，ISOLATED world）
│    └─ content/bridge.js     回填 + 浮球 + SPA 守卫（files 注入，IIFE）
│         ↕ tabs.connect Port 'om-tx'
└─ bridge/（可选伴生进程，Node）
     ws 服务（127.0.0.1:39217）→ agent 适配器（Claude Agent SDK …）→ 本机 CLI agent
         ↕ WebSocket（token 配对 + Origin 校验）
```

依赖只有 chrome.* API，零构建、零第三方包，`chrome://extensions` 加载即用。bridge 是可选例外：Node 伴生进程，依赖 `ws` 与 `@anthropic-ai/claude-agent-sdk`，不进扩展包。

两个关键决策：

- **流式 fetch 放在扩展页面，不放 service worker**。MV3 SW 空闲约 30 秒回收，挂起的流式响应不可靠；页面生命周期随面板/标签页存活。SW 只做路由。
- **页面功能编排也放在扩展页面**（page-actions.js）。翻译是长任务（多批次 × 流式），同理不能进 SW；提取/回填经 `chrome.scripting` + Port 与页面通信。

## 数据模型

`chrome.storage.local`：

- `llmSettings`：`{providers: LlmProvider[], activeProviderId, defaults{temperature, maxTokens, systemPrompt}, agentBridge{url, token, defaultAgentId, baseDir, permissionMode, model}, chat{defaultEngine: 'agent'|'llm'|'llm-tools', toolMaxSteps}, translation{targetLang, mode, maxBlocks, maxChars, batchBlocks}, quickActions[{id, title, prompt}]}`
- `conversations`：会话数组，每项 `{id: 'conv:<uuid>', title, engine?: 'llm'|'agent', llmMode?: 'chat'|'tools', llmProviderId?, llmModel?, agentId?, agentSessionId?, knowledge?, cwd?, contextDirs?, items: [{id: 'msg:<uuid>', type: 'question'|'answer', parentItemId, content, model, stopped, error, meta, createdAt}]}`。engine 为 `llm` 的会话：`llmProviderId`/`llmModel` 是顶栏选中的 [供应商, 模型]，发送时按 providerId 精确路由（供应商被删则报错，不静默换家）；`llmMode:'tools'` 为 LLM 任务模式。engine 为 `agent` 的会话：`agentId`/`agentSessionId` 续接 agent 侧会话（`agentSessionId` 是 SDK 会话 id，由 `session_info` 事件回填）；`permissionMode`/`model`/`projectDir` 是会话级覆盖（权限模式、agent 模型、绑定项目目录，空即回退设置页默认）；`knowledge` 是会话知识库条目（`{id, kind:'upload', name, relPath}` 已拷入工作区 `knowledge/`，或 `{id, kind:'local', path}` 本机绝对路径原地引用）；`cwd`/`contextDirs` 是 0.5.0 前的遗留字段，工作目录现由 `baseDir/<会话 id>` 生成；answer 项 `meta.agent={agentId, agentSessionId, steps, thought, costUSD?}` 支撑离线重放，LLM 任务模式的 answer 项 `meta.tools={steps, trail}`（steps 同 agent 步骤形状；trail 是本轮消息轨迹——assistant 工具调用 + 工具结果 + 各段正文，追问轮原样回传给模型接力），question 项 `meta.attachments=[{name, path, relPath}]` 回显附件 chips知识库条目另有 `{id, kind:'handle', name, handleKind:'dir'|'file', wsPath}`：浏览器授权的本机文件夹 / 文件，句柄本体存 IndexedDB `om-kb`（键 = 条目 id），`wsPath` 是 Agent 同步到工作区的落点。
- `storage.session.pendingTask`：`{kind:'quick-action', actionId, title, prompt, sourceUrl, ts}` / `{kind:'page-summary', tabId, ts}` / `{kind:'translate-page', tabId, ts}`（SW 不跑 LLM，交面板编排；兼容读旧 `pendingPrompt` 一个版本；面板未配置供应商时保留任务，配置后重开面板自动继续）
- `storage.session.omWidgetHidden`：已废弃（0.3.0 移除）。浮窗「×」现为纯 DOM 隐藏，仅当前页生效，刷新即恢复

ID 全部客户端生成，UUID 前缀区分类型；消息树靠 `parentItemId` 串联（v1 线性渲染，字段先就位）。`meta={kind:'page-summary',url,title,chars}` 标记网页总结来源消息，渲染为来源 chip + 一行指令「总结这个网页」+ 折叠的完整 prompt（`content` 存全文不动：发给模型 / 复制 / 导出 / 追问历史都读它，只是气泡不铺开整页正文）。

## LLM 适配层

一个接口两个实现，UI 只见归一化增量 `{text, finished, error}`（沿用 Monica `parseStreamResult` 的契约形状）：

| | OpenAI 兼容 | Anthropic |
|---|---|---|
| 端点 | `{base}/chat/completions` | `{base}/v1/messages` |
| 凭证头 | `Authorization: Bearer` | `x-api-key` + `anthropic-version: 2023-06-01` + `anthropic-dangerous-direct-browser-access` |
| system | `messages[0]` | 顶层 `system` |
| max_tokens | 可选（默认不发） | 必填（默认 4096） |
| 文本增量 | `choices[0].delta.content` | `content_block_delta.delta.text_delta.text` |
| 结束 | `data: [DONE]` / `finish_reason` | `event: message_stop` |
| 流内错误 | `{"error":{…}}` 帧 | `event: error` 帧 |

SSE 分帧两协议相同：空行（`\r?\n\r?\n`）切帧、拼接 `data:` 行，`sse.js` 共用；内建空转看门狗（首帧 180s / 帧间 60s 无数据即断开报错，防中转挂死把批次卡在「翻译中」）。部分中转夹杂非 JSON 帧，解析失败静默跳过。

baseUrl 归一：剥尾斜杠与已知端点后缀，适配器只拼自己的路径；用户粘整条端点 URL 也能用。

## 本地 Agent bridge（可选）

Chrome 扩展不能起进程、不能枚举目录，本机 CLI agent（Claude Code 等）经由一个 Node 伴生进程暴露给扩展页面。协议、模块职责、事件映射详见 [agent-bridge.md](agent-bridge.md)，此处只记架构落点：

- **bridge/ 伴生进程**：`index.js`（启动与端口）→ `server.js`（WS 服务：hello token 鉴权、Origin 必须以 `chrome-extension://` 开头、id 配对请求/响应、事件帧带 seq；分发 `upload.*` 到上传管道）→ `workspace.js`（工作区解析 `baseDir/<workspaceId>` 与分块上传状态机，与 session 生命周期解耦）→ `turn.js`（会话表 + 事件序号 + 500 帧环形缓冲 + 权限请求/应答）→ `agents/claude.js`（Claude Agent SDK 适配器：probe 探测、startTurn 把 SDK 消息流归一化为 `message_chunk`/`thought_chunk`/`tool_call(+update)`/`plan`/`permission_request`/`usage`/`turn_end`）。新增 agent 只加 `agents/` 适配器，协议不动
- **src/agent/ 扩展侧**：`client.js` 单例 WS 客户端（重连退避 1s→10s、30s 请求超时、多页面共享单连接各自回调；`uploadFile` 768KiB 原始块分片上传并回报进度），`render.js` 纯函数状态机（事件进、状态出，`stateFromMeta` 离线重放历史消息），`compose.js` 纯函数（知识库 local 条目去重为 `contextDirs` 并在 prompt 里点名——不点名模型不知道本机有这些内容，会按先验去网上找；知识库上传件与附件以工作区相对路径附加进 prompt；handle 条目按本轮同步结果如实标注，未同步的注明「内容可能过期或缺失」）
- **chat-ui.js 编排**：引擎是会话级记忆属性（顶栏 `#om-engine` 三选一：Agent / LLM 问答 / LLM 任务。**一律原地切换**：会话有无消息都直接改写当前会话的 engine/llmMode，历史与 `agentSessionId` 保留，实际换了引擎才 toast 提示——两种引擎语义在混合会话里各自成立：agent 记忆在 SDK 会话侧续接、不回放扩展历史，LLM 每轮全量带扩展历史；流式 / 翻译中禁止切换并 toast；所选值记入 `chat.defaultEngine` 作为新会话默认；`syncEngineUi` 按引擎同步模型/agent/权限选择器显隐、恢复会话记住的 [供应商, 模型] 与知识库按钮高亮）；LLM 任务模式经 `runToolLoop`（`src/llm/tool-loop.js`）跑 `browser-tools.js` 的浏览器工具，副作用工具（fetch_url / open_tab / download_file / click_element / extract_click_collect）弹内联审批卡，可勾「本对话不再询问」，停止本轮按拒绝收场；工具循环出口保证轨迹完整（assistant 的每个工具调用都有对应结果消息，缺了的话该会话之后每次请求都会被服务端 400 拒掉），追问轮拼装历史时再过一遍 `repairToolTrail` 修复旧版本存下的残缺轨迹；会话字段小改走 `patchConversation`（同一 fn 依次作用于内存与存储副本并回写 updatedAt——传空函数等于把旧值写回存储；存储里还没有该会话时 250ms 后重试一次，init 建初始会话的写盘可能在途），发送准备期 `preparing` 与 patch 在途（`patchPending`）计数挡住多视图同步整表替换内存（否则刚发的消息 / 刚 patch 的字段会被旧快照冲掉）；两引擎轮收尾的存储重载兜底带 preparing 增量守卫——重载 await 期间有新发送推进内存版时保持内存版（存储快照不含那条消息，整表替换会把刚发出的提问从 DOM 与后续落盘里洗掉）；`runAgentTurn` 每轮带 `{cwdBase, workspaceId: 会话 id, contextDirs: 知识库本地路径, permissionMode, projectDir}` 建/续会话并接住响应的 `workspacePath`，`agentSessionId`（SDK 会话 id，`s:` 前缀的旧值不 resume）有效则 resume 否则 new，turn 结束把 `session_info` 给的 id 写回会话；流式渲染 rAF 合帧；停止按钮走 `session.cancel`，由 `turn_end(cancelled)` 事件收尾落盘，避免双写；重连后 `events.replay` 从上次 seq 补帧；`permission_request` 事件除消息区审批卡外同步 toast 提醒（审批卡滚出视口等于静默挂起，30 分钟超时自动拒绝）
- **权限模式（会话级，两引擎贯通）**：输入框下方工具行的下拉（`#om-perm`，Orca 布局），三档 default/acceptEdits/bypassPermissions 对应每步审批/自动接受编辑/自动放行；显示值 = `conv.permissionMode ?? 设置页默认`（设置页 `#om-agent-perm` 配全局默认），切换写回会话记录，下一轮生效无需新会话。agent 引擎：session.new/resume 每轮带上（bridge 侧透传，无改动）。LLM 任务（llm-tools）：下拉在任务模式同样可见，生效档 = `conv.permissionMode ?? settings.agentBridge.permissionMode ?? 'default'` 每轮发送时读取；bypassPermissions 在工具审批闸门（tool-loop 的 `approve` 回调）直接放行全部工具不弹审批卡，acceptEdits 只放行 `write_file`/`edit_file`（其余照弹），默认档走审批卡与「本对话不再询问」短路。LLM 问答（不调工具）下拉隐藏
- **LLM 任务模式页面操作工具（`browser-tools.js` 11 个，页面侧函数在 `injected.js`）**：读侧 get_current_page / get_selection / list_tabs / read_tab / snapshot_interactive / wait_for，写侧 fetch_url / open_tab / download_file / click_element / extract_click_collect（五个 needsApproval，任务粒度：一次批准管整轮工具调用，勾「本对话不再询问」后会话内同类免审批）。页面函数全部经 `executeScript({func})` 注入 ISOLATED world——**自包含红线**：只序列化函数本体，模块级辅助函数必须内联进函数体（漏了在页面侧 ReferenceError，部分 Chrome 版本以 `InjectionResult.error` 字段返回而不是 reject）。元素寻址用快照打在页内的 `data-om-ref="omx-<n>"`，扩展侧零状态；页面重渲染后旧 ref 失效，报错引导模型重新快照。**循环点击采集**：模型只出一次配方 JSON，扩展页驱动循环逐项「点击 → 等待 → 抽取」并按 `next` 翻页，机器速度零模型调用，收尾模型汇总。配方 `{items 列表选择器, scope? 容器, click? 项内点击目标, waitText?/waitSelector?/waitMs? 等待信号, fields[{name,selector,attr?}], fieldsScope?, rel:'item'|'page' 字段基准, itemLimit, intervalMs, next:{click, waitText?, waitMs?, maxPages}}`；上限 `EXTRACT_CAPS`：200 项 / 50 页 / 20 字段 / 等待 ≤30s / 间隔 ≤5s / 选择器 ≤400 字符（`validateExtractRecipe` 拒绝越界配方）。驱动循环每步单独 executeScript（停止即时生效）；翻页与逐项迭代每轮重查列表（SPA 重渲染安全）；翻页后「首项文本未变」判翻页失败、连续两页异常即停；单项失败记 `_error` 行不中断；产出 >16000 字符截断并注明。**注入竞速兜底**：executeScript 的 promise 可能永不落定——注入恰好落在整页跳转的文档销毁窗口时既不执行也不报错（实测挂死整个工具循环），`runIn` 一律 `Promise.race` 预算（默认 8s，带页内等待的调用 = 等待时长 + 5s）。推荐流程写进 TOOLS_SYSTEM_PROMPT：snapshot_interactive 看结构 → 需要时 click_element 点开一项确认展开后的 DOM → extract_click_collect 配方批量采集（选择器没把握先 item_limit 1~3 小批量验证）→ 汇总回答。**新标签页处置（`on_new_tab`）**：页面点击开出 target=_blank / window.open 的新标签页时，click_element 按 `on_new_tab` 三种处置——`capture`（默认）等加载完提取正文附进工具结果后关闭、`block` 拿到 URL 即关（创建事件里 URL 往往还没填，等 onUpdated 首帧回填）、`allow` 保留；护栏挂 `tabs.onCreated/onUpdated`，只认 `openerTabId == 源标签页` 的新建页，源标签页与无关标签页永不触碰，多开超 3 个只处理前 3 个其余直接关；extract_click_collect 循环固定按 block 拦（采集目标是当前页），拦截说明进结果备注。护栏必须在点击前挂上，否则 onCreated 已错过。已知边界：合成点击 isTrusted=false（不触发 `<details>` 展开这类激活行为，addEventListener 监听正常收到）、只作用 light DOM（不进跨源 iframe / shadow root / canvas）。e2e：`node scripts/verify-extract.mjs`（本地 fixture：配方采集两页 10 项 + click_element/wait_for 链路）；配方校验单测在 `scripts/test-llm-unit.mjs`。
- **模型透传（两级）**：设置页 agent 卡「模型」（`#om-agent-model`，可手填任意模型 id，留空用默认）→ `agentBridge.model` 全局默认；输入框下方另有会话级下拉 `#om-agent-model-sel`，写 `conv.model` 覆盖全局。下拉选项经 bridge 的 `models.list` 动态拉取（按当前所选 agent 分流：claude 适配器问网关 `GET /v1/models`，codex 适配器起临时 app-server 问 `model/list`；走中转时返回网关真实模型，与 Orca 同思路）。列表缓存以 agentId 为键：切换 agent 即重建下拉并重拉（渲染层也只认当前 agent 的缓存，防迟到响应串台），杜绝 codex 下仍显示 claude 网关的模型；拉不到回退预设别名——claude 系 opus/sonnet/haiku，codex 系模型名迭代快不硬编码（只留默认项），会话已存的自定义值始终保留为选项。`runAgentTurn` 每轮带 `model: conv.model || agentBridge.model || ''` → bridge 存 session → claude 适配器非空时作 SDK `query()` 的 `model` 选项
- **运行中可发消息**：agent 轮进行中 `streaming={kind:'agent'}`，`sendPrepared` 把消息入 `agentQueue`（userItem 已落盘，关页不丢），toast 报队列位次；本轮 `runAgentTurn` 收尾后 `drainAgentQueue` 用重查的会话引用逐条发起（无在途发送时 loadConversations 已替换对象；重载 await 期间有新发送则保持内存版，两种情况下重查引用都成立）。LLM 轮不变：发送按钮仍是「发送 ⇄ 停止」一体。agent 轮的停止移到 composer 独立按钮 `#om-stop`（`session.cancel`，`turn_end(cancelled)` 事件收尾）；停止同时撤掉本会话还在排队的消息的自动发送（消息本体已落盘不动，toast 报撤销条数）——否则收尾后 drainAgentQueue 立刻开下一轮，停止看起来不生效。**两级停不下来的兜底**：cancel 送达但 SDK 卡死不出 `turn_end` 时，8s 后本地按已停止收尾（老版本 bridge 无宽限收场时 UI 不永久卡流式态，toast 提示可重启 bridge）；轮内 2 分钟无任何事件帧 toast 提示可能卡住（只提示不自动收尾，长工具静默期不误杀）。bridge 侧配套：claude 适配器 abort 后 5s 强制收场（见 docs/agent-bridge.md 取消行）
- **跳到最新**：`scrollPinned` 贴底跟随（距底 <40px 视为贴底）。流式期间用户上滚即停跟随并浮出 `#om-jump` 浮标（绝对定位在 `.om-main` 底部居中），点按回底恢复；`flush`/`flushAgentTurn` 的自动滚动与 `renderMessages` 的复位都走同一开关
- **回答尾部动作行（对齐 Orca）**：每条回答末尾两个图标按钮——复制（`navigator.clipboard.writeText` 写 `item.content` 的 Markdown 原文）与回到该问题（按 `parentItemId` 找提问消息元素 `scrollIntoView` 平滑滚过去，同时置 `scrollPinned=false` 并浮出 `#om-jump`，语义同用户上滚翻历史）。流式期间经 `.om-streaming` 类 CSS 隐藏，轮结束 `renderMessages` 重建后出现；LLM 与 agent 引擎共用（`messageEl` 单点渲染）
- **工具步骤详情**：适配器把完整工具输入（键值行 ≤1200 字符，assistant 消息回填时补发）与工具结果（≤2500 字符，`is_error` 时 status=failed）附在 `tool_call.detail` / `tool_call_update.result` 上；`render.js` 的步骤值扩为 `{title, status, detail, result}`（序列化进 meta 自动持久化、离线重放可用，值内带 `id` 供回放把 `parentId` 重映射到合成 key）；有详情的步骤渲染为 `<details>` 可展开卡（输入 pre + 「工具结果」pre，textContent 赋值防注入），无详情维持单行。步骤状态 `in_progress` 的行尾 spinner 只在轮运行中有意义：`turn_end` 时把没等到结果的步骤定格为 `cancelled`（行尾「–」，取消时最后一个工具不会有 tool_call_update），`stateFromMeta` 离线回放对旧数据同样收口
- **耗时与子智能体分组**：适配器按 `tool_call`/`tool_result` 两侧时间戳差算每步 `durationMs`（步骤行右侧徽标），SDK `result.duration_ms` 与 `total_cost_usd` 经 `usage` 事件透传（消息头显示「已工作 总耗时 · 费用」）；SDK 消息的 `parent_tool_use_id` 透传为 `parentId`，非空即子智能体内部调用，前端折叠到对应 Task 步骤下并在步骤区顶部汇总「运行了 N 个子智能体」
- **步骤流视觉（对齐 Orca）**：步骤行 = 工具图标（按 title 前缀工具名映射：Read→文件、Grep/Glob→搜索、Bash→终端、Edit/Write→编辑、Task→机器人、未知→扳手，灰度单色）+ 标题 + 耗时徽标 + 行尾状态标记（完成 ✓ / 失败 ✕ 红字 / 运行中 spinner / 取消 –）；连续同名已完成步骤聚合为一行「读取 N 次」「执行 N 次」（中文工具名，可展开看每步明细，明细行各自可再展开输入/结果；子智能体组或未完成步骤打断聚合）；轮运行中步骤区顶部常驻计时头「已工作 X」（spinner + 细分隔线，独立 setInterval 每秒走字，不参与事件驱动的整块重建，轮结束随 renderMessages 全量重建消失）；思考块素面化（左侧竖线缩进，无卡片底色边框）
- **流式渲染增量化**：文本增量帧只重渲染正文，Markdown 全量重解析按 250ms 节流（思考间隙无新事件时定时补帧，轮结束强制渲染）；思考/步骤/审批卡只在各自事件到达时重建——逐 token 帧不再触发布局块整块重建，长回答后期不再卡顿
- **工作目录绑定（会话级）**：知识库弹层顶部「工作目录」行，`renderFsBrowser` pickDir 模式选本机目录写入 `conv.projectDir`（可清除）；绑定后 bridge 以该目录为 cwd（不存在/非目录报 `bad-path`），工作区照常创建管上传且自动加入 contextDirs，`compose.js` 把上传件/附件改列为工作区绝对路径；未绑定时维持 `baseDir/<会话 id>` 独立工作区与相对路径引用。导出默认位置文案随 cwd 语义变为「当前工作目录 docs/」
- **知识库与附件**：知识库三条路径——「浏览本机…」走 bridge `fs.list` 目录浏览器勾选真实路径零拷贝引用（扩展页拿不到所选文件的真实磁盘路径，`<input type=file>` 只能拷贝；bridge 有 fs 权限，是零拷贝的主入口，勾选跨目录累积），「上传文件/上传目录」上传进工作区 `knowledge/`（目录保留层级），「本地路径」手填经 `fs.check` 校验后原地作为附加目录引用；书按钮角标显示当前会话条目数。附件（回形针/拖放/粘贴，≤100MB）发送时上传进 `uploads/`，prompt 只引用工作区内相对路径，agent 用自己的工具读取。LLM 引擎会话两者均拦截并 toast 提示
- **本机知识库（浏览器授权）**：知识库弹层「授权文件夹 / 授权文件」走 `showDirectoryPicker` / `showOpenFilePicker`，不依赖 bridge；发送 / 重新生成时在用户手势内 `requestPermission` 补授权，被拒的条目本轮跳过。页内聊天卡是嵌在网页里的跨源 iframe，既弹不出选择框、跨源 `requestPermission` 也被禁（侧边栏授过的句柄在卡片里读不了）——两条入口在卡片里自动降级为**只读快照**：`<input type="file">`（文件夹用 webkitdirectory）在 iframe 里可以弹，选中文件的字节复制进扩展 IndexedDB（会话知识库存 `kind:'snapshot'` 条目，`om-kb` 库 `snapshots` store，上限 200 个文件 / 单个 50MB / 合计 200MB，与 Agent 同步一致；超限提示去侧边栏按需授权）；`src/kb/snapshot-fs.js` 把副本包成与浏览器句柄 / bridge 虚拟句柄同形的只读根，`files.js` 的 `notFound` 对 `ReadOnlyError` 原样放行（错误文案写明原因与出路），三种引擎共用：LLM 问答把授权的单个快照文件附进 system、LLM 任务全套文件工具可列 / 搜 / 读 / 载入 skill（写入明确报只读错误）、Agent 发送前经 `kb/sync.js` 照常增量同步（清单按 `大小:修改时间`，副本不变即不重传）；File 对象结构化克隆进 IDB，重载 / 重启后仍可读，不依赖原文件还在。LLM 任务的文件工具（`src/llm/fs-tools.js`）路径以知识库名称开头、禁止 `..` 与绝对路径，遍历跳过 node_modules / .git / dist 等；write_file / edit_file 审批卡先算 diff（`lineDiff`，LCS）再给用户确认，允许后请求 readwrite 授权并写入；工具结果可带 PDF / 图片附件，Anthropic 放进 tool_result 的 document / image 块，OpenAI 在同组 tool 消息后补一条带 file / image_url 的 user 消息。Agent 引擎读不到句柄，`runAgentTurn` 建会话前按清单增量上传到 `wsPath`（单文件 50MB、合计 200MB、2000 个文件上限），prompt 里按工作区相对路径列出（`compose.js` 对 handle / snapshot 同等列出）。
- **LLM 引擎经 bridge 读写本机路径**：浏览器的文件选择框在网页里的聊天卡（跨源 iframe）里被 Chrome 硬性禁止（`Cross origin sub frames aren't allowed to show a file picker`，实测），所以 LLM 引擎的知识库弹层也提供 Agent 引擎用的「浏览本机…」/ 粘贴路径（`kind:'local'` 条目，经 bridge `fs.list` / `fs.check`）。`src/kb/bridge-fs.js` 把 bridge 的 `fs.check / fs.list(hidden, stat) / fs.read / fs.write` 包成与 File System Access 同形的虚拟句柄（`entries / getFileHandle / getDirectoryHandle / getFile / createWritable`），`fs-tools.js` 的全部工具（含 skill、diff 审批、docx/xlsx/pptx 解析）对两种来源完全共用。`grantedRoots(conv, {bridge:true})` 合并三类根；bridge 未连接 / 路径不存在的条目本轮跳过并 toast 原因。Agent 同步只收浏览器句柄与快照副本，bridge 路径 Agent 本来就能直接读，不再拷一份。没装 bridge 的机器上，卡片里的本机知识库就是上一条的只读快照（零依赖）；要在卡片里可写引用，仍走本条的 bridge 路径。
- **search_files 的覆盖说明**：大仓库（如 Flink 源码，数万文件）里旧版遍历到 2 万条目就静默停止并报「内容无匹配」，模型据此认定知识库里没有、转去联网并凭记忆猜 URL。现在分两阶段：先遍历整棵树（上限 `LIMITS.walkEntries`=30 万，只看名字，文件名匹配在此阶段完成），再以 16 并发读取候选文件内容（总时限 40 秒）；结果末尾必须声明没搜全的原因（遍历达上限 / 目录被数据源截断 / 读取超时 / 大文件跳过），未声明且无命中时写明「已完整遍历 N 个文本文件」。bridge `fs.list` 的 `limit` 参数把单目录条目上限从 UI 的 1000 放宽到最多 5 万（虚拟句柄请求 2 万，`dir.truncated` 由 walk 汇总）。系统提示要求：搜不到先换词 / 缩小范围，确认没有再下结论；联网 URL 不得凭记忆猜测。`fetch_url` 遇 raw.githubusercontent.com 的 404 自动互换 master ↔ main 重试，并在错误里提示先用 GitHub contents API 列目录核实路径。
- **扩展重载后的旧页面**：开发者点「重新加载」/ 商店更新后，网页里还开着的聊天卡 iframe 仍在跑旧代码，`chrome.*` 失效（报 `Extension context invalidated`，或 `chrome.storage` 直接变 undefined 报 `reading 'local'`），旧版的 bridge 重连定时器每次重试都抛未捕获异常，被记进扩展「错误」页。`src/util/ctx-guard.js` 的 `installCtxGuard`（chat-ui 启动时装）吞掉这类未处理异常，并在检测到上下文失效（3 秒轮询兜底）时让嵌在网页里的聊天卡 `location.reload()` 成新版（15 秒内已重载过一次则不循环，改为提示）；顶层页面只提示，不自动重载以免丢输入。`agent/client.js` 的 `_open` 遇到上下文失效即停止重连。`node scripts/verify-ctx-invalid.mjs` 以 Chrome 自己记录的扩展运行时错误（developerPrivate）为断言。
- **聊天卡网页上下文跟随宿主页**：会话有持久页绑定字段 `conv.pageKey`（origin+pathname+search 去 #hash），`pageCtx` 只承载上下文内容（用户点 × 移除不解除绑定）。卡片加载时向宿主 widget 索取正文（`om:card-ctx-req` → `om:card-ctx`，含 url），并在同一标签页 SPA 换页时由 widget 轮询地址（忽略 #hash，卡片打开期间 1s 一次，变化后等 1.2s 渲染稳定）重发。`reconcileHostCtx` 对齐会话：绑定比对取 `conv.pageKey`，老会话无该字段回退按 `pageCtx.url` 推导（命中本页即补写 pageKey，零迁移），两者都没有 = 从没绑过页（侧边栏会话）→ 挂上当前页上下文并写 pageKey；绑的是本页 → 只补上下文不动；没说过话且绑的是别的页 → 原地换上下文与绑定（当前页正文不足 80 字则清空，`cardCtx` 同步置空，避免新对话带上上一个网页的正文，agent 会话清 `pageCtxSent` 让新页上下文随首条 prompt 再注入）；已有消息且绑的是别的页 → 新建绑当前页的对话，原对话保留。流式 / 发送准备期不切会话，约 90 秒内重试。启动时 `pendingTask`（划词翻译 / 总结 / 追问等）等宿主上下文回来并对齐会话后才消费（最多等 800ms），保证任务用的是触发它的那个网页。实时消费 `storage.session.pendingTask` 只由可见（active 标签页）的实例执行，否则别的标签页里开着的聊天卡会抢走任务。
- **会话列表与总结导出**：会话列表按最后一条消息的 `createdAt` 降序渲染（无消息回退会话 `createdAt`），存储序不变；标题支持行内编辑（铅笔按钮或双击进入，Enter/blur 提交、Esc 取消、空值回退原标题），经 `updateConversation` 落 storage。顶栏下载按钮把当前会话整理成 Markdown 落盘：agent 引擎由扩展按会话存储记录（`compose.js buildConversationMarkdown`，问题与回答全文逐轮整理，不依赖 agent 的会话记忆——长会话在 agent 侧被自动压缩后记忆只剩尾部）拼出文档，经 bridge `fs.write` 直接落盘（默认工作区 `docs/`，绑定项目目录时落项目 `docs/`，自定义目录先 `fs.check` 校验），导出瞬时完成不进 transcript；LLM 引擎一次性 `streamChat` 生成 Markdown 后经 `chrome.downloads.download({saveAs:true})` 弹系统保存对话框，不进 transcript、导出期间按钮置灰。文件名 `YYYYMMDD-HHmm_<清洗后标题>.md`（非法字符→`_`、≤60 字、空标题回退「会话总结」），空会话导出按钮置灰。目录选择复用 `fs.list` 浏览器（`renderFsBrowser` 双模式：knowledge 多选 / pickDir 单选目录）
- **删除会话与多视图同步**：删除会话时除清 storage 外，fire-and-forget 调 `workspace.remove` 清掉 `baseDir/<会话 id>` 工作区（bridge 不在线则跳过，op 幂等）；侧边栏/聊天页/聊天卡各自持有内存 `conversations`，任一视图写 storage 后其余视图经 `storage.onChanged`（200ms 防抖、内容比对去自写）重载列表与消息，流式中跳过（turn 收尾本就 reload 兜底），消除 stale 全量写复活已删会话的问题
- **聊天卡按标签页恢复会话、按宿主页绑定会话**：聊天卡当前会话变化即经 `om:card-conv` postMessage 上报宿主 widget，存页面 `sessionStorage`（按标签页隔离，随标签页关闭销毁）；重开卡时 iframe 带 `?conv=<id>` 恢复本标签页上次会话。widget 开卡时 iframe 另带 `?page=<宿主页 URL>&pt=<宿主页标题截 60 字>`：卡 init 按三级选会话——`?conv` 命中优先，其次按 `pageKey(?page)` 匹配会话绑定字段（老会话回退按 pageCtx.url 推导认领），都没有则新建绑本页的会话（标题用 pt）——不再回退「全局最近活跃」，A 页的会话不会串到 B 页的卡。会话创建放在 init 尾部的初始会话块（`newConv` 依赖的模块常量彼时才就绪，init 顶部直接建会 ReferenceError）。顶层视图（侧边栏/聊天页）与缺 `?page` 的卡（旧版缓存 widget 开的）保持旧回退（最近活跃，`lastActive` 降序），与列表排序一致。**页面关闭停跑**：`pagehide`（聊天卡随宿主页销毁、独立聊天页/侧边栏关标签页都触发）里 agent 轮发 `agentClient.cancel(sessionId)`、LLM 流式 abort + `flushNow` 落盘尾部，全部 fire-and-forget（页面销毁路径不能 await）；bridge「断开不杀、重连补帧」语义不动，pagehide 时 WS 通常还开着、取消帧能发出，帧丢失的残窗口接受
- **聊天窗按标签页隔离（对齐 Monica）**：页面级聊天入口（浮窗胶囊、总结/解释动作、右键菜单动作）一律打开本标签页的页内聊天卡，新标签页不出现任何聊天窗，须主动打开；后台不为这些动作调 `sidePanel.open`——原生面板窗口级常驻、跟随新标签页出现且无关闭 API。工具栏图标与 Ctrl+M（`_execute_action` → `action.onClicked`）开关当前标签页聊天卡（`om:toggle-card`，无浮窗页面回落独立聊天页），`openPanelOnActionClick` 置 false——原生侧边栏不设扩展自己的入口，只能从 Chrome 自带侧边栏下拉显式打开；面板打开时经 `om:panel-visible` 广播收起各页聊天卡。会话全局共享：所有窗口（各页聊天卡、原生面板、独立聊天页）读写同一份 chrome.storage 会话并经 storage.onChanged 实时同步（200ms 防抖），每个标签页只经 sessionStorage 记住自己上次打开的会话（`?conv=` 恢复）——多个窗口连同一个会话，窗口各自独立开合。浮窗已隐藏但内容脚本仍存活时，`om:open-card` 照常可展开聊天卡；`om:open-card` 无人应答（扩展重载后旧页面浮窗上下文失效、页面不可注入）时，后台先 `executeScript` 补注浮窗重试，仍失败则开独立聊天页兜底，全程不调 `sidePanel.open`。浮窗脚本自带失效自检：旧上下文失效时摘除残留的浮窗 / 聊天卡 / 翻译 runner 宿主后重铺，补注才能生效
- **安全**：bridge 只绑 `127.0.0.1`；token 首次启动生成落 `~/.vela-bridge/token.json`（0600）；权限请求默认 30 分钟无人应答自动拒绝；上传 relPath 双侧清洗（扩展 `sanitizeName` + bridge `sanitizeRelPath`），落盘约束在工作区内

## 权限与 CORS

- `host_permissions: ["<all_urls>"]`：总结/翻译面向任意网页，optional 逐站授权在每个新站都要静默失败→补授权一轮，自用工具不值得。同时覆盖扩展页面 fetch 的 CORS 豁免与 `tab.url/title` 可读（无需 tabs 权限）
- `permissions` 加 `downloads`：仅 LLM 引擎会话的总结导出用（`chrome.downloads.download({saveAs:true})` 弹系统保存对话框选位置）；Agent 引擎导出走 bridge 侧文件写入，不用此权限
- Anthropic 直连需 `anthropic-dangerous-direct-browser-access` 头
- SW 无 host 权限需求（不做网络请求）
- 上架商店需回退 `optional_host_permissions` + 用户手势内 `chrome.permissions.request` 流程（options.js 的 `ensureOriginPermission` 保留为 contains 检查）

## 页面功能层

入口：页面常驻浮窗（主要）、右键菜单；面板顶栏不放页面动作（对齐 Monica：面板只做聊天）。动作脚本按需注入 ISOLATED world。

### 页面浮窗

`widget.js` 经 SW `onInstalled` 里的 `scripting.registerContentScripts`（id `om-widget`，match http/https，`persistAcrossSessions`）常驻注入；同批对已打开的 http(s) 标签页 `executeScript` 补注（注册式注入不追溯已加载页面）。经典 IIFE + open Shadow DOM：注入后默认收起为一颗 40×40 品牌紫悬浮球（`.om-ball`，logo 图标，页面占用从整列动作条缩到一颗球）；悬停 180ms 展开动作列（`.stack.open`，入场 `om-pop-in` 动画），移开 300ms 收起，点球立即展开（触屏兜底）。收起态按住球、展开态按住胶囊本体（角上隐藏 / 暂停钮除外）都能上下拖：位移超 4px 判为拖动（否则按悬停 / 点击语义走），拖动中抑制悬停展开与移开收起，松手吞掉紧随的合成 click（不弹菜单、不误开聊天卡；只绑球等于没有拖动——悬停 180ms 就展开，球态几乎按不到），锚点（host 中心，配合 `translateY(-50%)`）写 `chrome.storage.local` `om-widget-pos`，所有页面注入后还原同一位置；锚点计算走几何位置（rect 中心）而非 `parseFloat(style.top)`——默认态该值是 `'38%'`，解析成 38px 是错值；窗口 resize 只对已固化为 px 的锚点 clamp 回视口，默认 38% 态交给 CSS。`scripts/verify-ball-drag.mjs` 覆盖球拖 / 胶囊拖 / 抑制展开 / clamp / 刷新恢复 / 胶囊点击开卡。聊天卡开着或翻译设置弹层开着时常开（胶囊关卡入口 / 弹层关闭钮都在列侧，收掉就够不着了），点击 host 外收起（pin 时不收）。展开列含 6 个深色圆形动作钮（总结/翻译/解释选中/导图/连读/下载 MD）+ 品牌紫胶囊 +「×」（纯 DOM 隐藏当前页浮窗并收起聊天卡，刷新恢复）+ 右上角「暂停本页」小圆钮（`.pause`，跑网页自动化前点——浮窗 / 媒体悬停钮 / 划词工具条的持续 DOM 注入会让快照式自动化的元素 ref 失效）。点击先弹确认卡（`.om-w-confirm`，说明停用范围与恢复方式，确认 / 取消 / Esc / 点外部关闭，开着时动作列 pin 不收）再执行——作用只写在 title 上的钮没人看得懂。暂停语义：sessionStorage `om-page-paused` 记 `{u: 页地址}`（按标签页隔离，关标签页自然清空）；点下即摘浮窗、聊天卡、媒体悬停钮 / 弹层与划词工具条 / 代码钮 / 高亮钮，后续 widget 注入早退不铺浮窗、媒体 mouseover 守卫直接返回、selection-popup 的 show / showCodeBtn / showHlBtn 只读同一 key 判停（与 widget.js 同 world、注册序在后，清除逻辑只在 widget 注入时做）。**换页保持暂停**：整页跳转后的新文档记的地址 ≠ 当前地址，不复活（自动化连续操作多页不中断）；**同址刷新恢复**：注入时记的地址 == 当前地址视为用户手动刷新，清标记并正常铺浮窗（前进 / 后退回到暂停地址同此语义）；正在跑的翻译任务不拦（用户显式发起的长任务，杀掉不可见）。`scripts/verify-page-pause.mjs` 覆盖正面对照 / 暂停后三类注入哑火 / 换页保持 / 同址恢复。原生侧边栏没有关闭 API，胶囊的开关语义由**页内聊天卡**承担：iframe 指向 `src/sidepanel/sidepanel.html`（`web_accessible_resources` 放行文档，页内自有资源属扩展源内加载无需放行），卡片贴右满高（`right:0;top:0;bottom:0`，仅左侧圆角，对齐原生侧边栏形态），打开时浮窗列左移让位（`right` = 卡宽 + 12px，卡宽表达式 `min(420px, calc(100vw - 104px))` 与压缩上限共用）、收卡复位，胶囊就地开合，不依赖 SW。侧边栏/独立聊天页与聊天卡不同时并存：顶层实例（`window.self === window.top`，卡片 iframe 不算）可见时 `om:panel-visible` 通知 SW，SW 向全部 http(s) 标签页广播 `om:close-card`，浮窗监听后收卡。总结/解释走 SW：`sendMessage({type:'om:widget-action',kind,from:'widget'})` → SW `handleWidgetAction` 写 `pendingTask`（from='widget' 时不开侧边栏，卡由浮窗自行打开）→ 聊天卡/面板消费，与右键菜单同管线；聊天卡与面板监听 `storage.session.onChanged` 实时消费 `pendingTask`。**翻译不走 SW、不弹聊天卡**：浮窗本地校验供应商后就地开 0×0 隐藏 iframe 加载 `src/page/tx-runner.html`（`web_accessible_resources` 放行），runner 页驻留跑视口驱动翻译管线（滚动续译），收场经 `postMessage`（`om:tx-done` 静默 / `om:tx-failed` 带原因）通知浮窗复位并撤除 iframe。解释动作用 `window.getSelection()` 取选区，空选区出浮窗内提示不发任务。`send()` 带 2.5s 无响应落定：扩展重载导致旧页面上下文失效时（sendMessage 同步抛错或永不回调），浮窗出「刷新扩展并刷新本页」提示，不再静默。翻译期间 bridge 广播 `om:tx-active` CustomEvent（同一 ISOLATED world），浮窗隐藏、浮球接管；还原后回归。

### 总结

tabs.query 活动标签 → 不可注入页（chrome:// 系等）toast → 无会话则建「网页总结」→ executeScript 注入 `extractArticle()`（剔 script/style/nav/footer/aside 后按文本密度选容器，回退 body，截 12000 字符）→ <80 字符报错 → user item `meta={kind:'page-summary',url,title,chars}`：气泡渲染来源 chip + 「总结这个网页」+ 折叠原文（点开可看完整 prompt）→ 常规流式回复。提取文本随消息 `content` 全文持久化（渲染折叠只是显示层，不截断），追问时历史自然带上下文。

### 连续阅读（连读，跟随「下一页」）

从当前文档页开始自动翻页读完一组系列文档（Flink 文档式多页教程/手册）。入口：浮窗动作列「连读」钮 / 右键菜单「连读此文档（跟随下一页）」→ SW 写 `pendingTask{kind:'read-series'}`，与总结同管线由聊天卡/面板消费。不走引擎对话管线（与翻译同类，不 ensureEngine），逐页总结直接 `streamChat` 强制 temperature 0。

- **导航是确定性规则，不烧 LLM**（`src/read/series.js` 纯函数，Node 可单测）：`pickNextLink` 打分挑「下一页」——`<link rel=next>` 120 > `<a rel=next>` 100 > 整段文本命中（下一页/下一节/下一章/下一篇/下页/下一个/next/next page，先剥首尾箭头装饰）80 > 前缀命中（「下一页：安装步骤」≤40 字）60 > 纯箭头（»/›/→）50；位于 nav/footer/分页容器（`[class*=pag]`/`[class*=next]`）+15；同分取文档序靠后的（分页条通常在页尾）。**只跟同源**（跨域诱饵一律不跟）、去 hash 后与当前页同址不算翻页（页内锚点「下一页」骗不过）。URL 归一化 `normalizeUrl` 只收 http(s)。
- **翻页循环在扩展页**（MV3：长循环不进 SW，`chat-ui.js runReadSeriesTurn`）：第 1 页经 `readSeriesFirstPage` 从实况标签页取（`extractArticle` 正文 + 新增 `collectAnchors` 链接清单，innerText 质量最好）；第 2 页起 `fetchSeriesPage` 抓 HTML（20s 超时、3MB 有界读、跟随重定向）经 `parseSeriesHtml` 提正文与链接——**必须显式传 baseUrl**，解析文档的 base 是扩展页自身，相对 href 会解析到扩展源；解析统一走 `src/common/html.js parseFetchedHtml`（fetch_url 工具共用）：DOMParser 文档虽是惰性的，但继承扩展页 CSP，源码带 `on*=` 内联事件处理器的页面在解析瞬间就会往控制台刷「Executing inline event handler violates…」违例（新 Chrome 按两条策略各报一条，纯噪音），字符串层剥掉 `on*=` 零损失（只提取正文与链接，转义过的代码示例不受影响）。visited 集合防回环（重定向落回已读页也判读完），单次上限 30 页（`llmSettings.readSeries.maxPages` 可调），逐页 800ms 礼貌间隔（`sleepAbortable`：点「停止」立刻醒）。
- **Map-reduce 式总结**：每页一次无状态 `buildSeriesPagePrompt`（第 n 页 + 标题 + URL + 正文截 12000 字符）流式追加进同一条回答（`## n. 标题` 分节 + 原文链接）；读完后 ≥2 页再做一次 `buildSeriesDigestPrompt`（逐页摘要 reduce 成「总览」）。连续两页总结失败即停（供应商层面问题不往后烧调用）。停止原因五种：`no-next`（没有下一页了）/ `visited`（指回已读页，判定读完）/ `max-pages`（上限，提示可从最后一页续读）/ `error` / `aborted`（手动停止），落进 `answer.meta.readSeries{pages:[{index,url,title}], stopReason}`，正文状态行同步注明。
- 持久化与引擎轮次同纪律：内存 `localContent` 权威、writeChain 串行化全量覆盖、500ms 节流、结束强制落盘；流式期间「停止」按钮可随时中止（abort 贯穿 streamChat / 礼貌等待 / fetch）。

### 下载网页为 Markdown

入口：右键菜单「下载此网页为 Markdown」（`om-download-md`）/ 浮窗动作列「下载为 Markdown」钮。不走聊天管线、不建会话：SW `downloadMarkdown(tab)` 只接 http(s) 标签页 → `executeScript` 注入 `injected.js` 的 `pageToMarkdown()`（func 注入只序列化函数本体，辅助函数全部内联）→ Markdown 文本回 SW → 离屏文档落盘。

- **pageToMarkdown 转写约定**：与总结的 `extractArticle` 相反，不按文本密度选主容器，整页可见内容原样转写。SKIP 集（script/style/noscript/template/svg/iframe/canvas/表单控件等）整棵丢弃；隐藏元素以 `getComputedStyle` 判 display/visibility（只在实况树有效）；其余标签当块容器（前后补空行）或透明容器拼接内联。GFM 映射：标题、ul/ol 嵌套缩进、管道表格（单元格内 `\|` 转义）、围栏代码（fence 反引号长度按内容里最长的反引号连续段自适应）、引用 `> ` 前缀、DL、DETAILS；行首 `#`/`-`/`>`/`1.` 类文本加反斜杠防伪结构，链接与图片地址按 `document.baseURI` 补全为绝对 URL。输出以 `# 标题` 与 `> 来源：<url>` 两行打头，返回 `{title, url, md}`。
- **落盘走离屏文档**（`src/page/offscreen.html` + `offscreen.js`，manifest `permissions` 加 `offscreen`，BLOBS 理由）：SW 是无 DOM 环境，造不了 blob URL；离屏文档是精简 API 面，没有 `chrome.downloads`，blob 落盘走 `<a download>` 锚点点击，回执带 blob URL。落定由 SW `downloads.search({url})` 按 blob URL 精确匹配轮询确认（250ms × 120 ≈ 30s，complete / interrupted / 超时三出口）。`createDocument` 返回时离屏模块脚本可能还没挂上 onMessage：`sendOffscreen` 对 `Receiving end does not exist` 每 250ms 重发（上限约 3s）；其余错误不重发——「message port closed」说明已送达只是没等到回执，重发会触发第二次下载。文档留活由 SW 按在途计数（`offscreenBusy`）延时 15s 关闭，关闭时 blob URL 随之失效，无需 revoke。
- **文件名与失败**：`mdFilename()` 标题清洗（非法字符→`_`、≤80 字、空标题回退 `page.md`）；锚点下载落浏览器默认下载目录（开了「下载前询问保存位置」则由浏览器接管）。不可注入页（PDF / chrome:// 系）/ 非 http(s) / 正文为空返回 `{ok:false}`，浮窗出「本页无法转存」提示，`console.warn` 记原因留诊断。
- **验证**：`node scripts/verify-download-md.mjs`（本地 http 站点 fixture：标题 / 相对链接补全 / 行首转义 / 表格 / 隐藏元素与 script 剔除 / downloads 记录 complete 且 text/markdown）。

### PDF 文档（标签页管线，一期）

Chrome 内建 PDF 查看器是 PDFium plugin 文档，不注入任何内容脚本——浮窗、页内聊天卡、scripting 注入全不通。PDF 支持走「标签页 URL → 扩展页拉字节 → 会话知识库快照 → 模型原生读文件」管线（`src/page/pdf-doc.js` 纯函数 + SW 路由 + chat-ui 编排），消费层复用既有三引擎知识库链路，零新消费代码。

- **入口矩阵**：① 工具栏图标 / Ctrl+M 落在 PDF 标签页（`action.onClicked` 先判 `isPdfUrl(tab.url)`）→ 自动发起总结；② 右键 PDF 链接「Vela：总结此 PDF / 翻译此 PDF」（`contexts:['link']`，按 `info.linkUrl` 判定；contextMenus 无法按链接目标过滤，所有链接右键都显示这两项，非 PDF 链接点击静默忽略）；③ PDF 标签页上右键「翻译此网页」「连读此文档」自动转投 PDF 管线（翻译 → 整份翻译；连读没有「下一页」可跟 → 退化为总结）。
- **任务体与一次性消费**：SW 写 `chrome.storage.session['omPdfJob:<id>']`（`{v:1, url, title, action:'summary'|'translate'|'chat', ts}`，title 取 URL basename 截 120 字）后 `tabs.create` 开独立聊天页 `chat.html#pdf=<id>`（PDF 页注入不了浮窗，独立聊天页是唯一可跑流式的落点）；聊天页 init 读到 hash 即 `history.replaceState` 剥掉（刷新不重放），任务读后即删（一次性）。失败路径（下载失败 / 非 PDF / HTTP 错误）只出 toast、不建会话，无半截副作用。
- **fetch 约束**（`fetchPdfDocument`，扩展页执行，不进 SW）：20s 超时、30MB 有界读、跟随重定向、`credentials:'omit'`、`%PDF-` 魔数校验。错误按 `Error.name` 分类出文案：`http-status`（带状态码）/ `timeout` / `too-large` / `not-pdf`（后缀像 PDF、内容是 HTML 错误页的伪装）/ `file-access`（file:// 未开「允许访问文件网址」→ 引导文案）/ `network`。URL 判定 `isPdfUrl`：http(s)/file + 路径 `.pdf` 后缀（无后缀的 http PDF 不识别，不做 webRequest 探测）。
- **snapshot 复用链**：下载成功先建会话（标题 = 文件名）→ `putSnapshot` 把 PDF 字节写 IndexedDB `snapshots`（复用知识库快照存储）→ 会话挂 `{id, kind:'snapshot', handleKind:'file', wsPath:'knowledge/<名>'}` 条目。此后 QA 的附件注入、LLM 任务的 fs-tools 读取、Agent 发送前的 syncKbToWorkspace 全走既有快照链路，追问跨轮字节持久。
- **QA 附件预算**：`llmKbContext` PDF 分支按字节预算（≤2 份 / 合计 16MB——16MB 覆盖单文件 `LIMITS.pdfBytes`=15MB，总结永不因预算失败）；附件挂在**当轮最后一条 user 消息**（不能挂 system：anthropic 适配器丢弃 system 消息；无状态 API 每轮重发字节）。OpenAI 序列化 `type:'file'` 块、Anthropic `type:'document'` base64 块——OpenAI 兼容网关需支持 file 块，不支持时报错走常规错误路径，不做适配器降级。
- **超限降级 Agent**：>15MB（`LIMITS.pdfBytes`）时总结与翻译都自动切 `applyEngineKey(conv,'agent')` + `buildPdfAgentPrompt`（引导 read_file 分段读、双语 md 写工作区 `docs/<名>-译稿.md`），字节经发送前 syncKbToWorkspace 上工作区；bridge 未启动则保留会话 + 预填 prompt + toast 引导。翻译强制 `temperature: 0`（`runAssistantTurn` 新增 `opts.temperature` 透传），单次 streamChat 整文档输出双语 Markdown，导出走现有 .md 导出，无分批（PDF 原生读没有文本可切，分批协议不适用）。
- **file:// 双重前置**：`host_permissions` 加 `file:///*` + 用户在 `chrome://extensions` 详情页手动开「允许访问文件网址」（无 API 可编程开启）。开关未开时 SW 读不到 file:// 标签页 URL，入口静默落回原路径（工具栏图标 → 普通聊天页）；扩展页 fetch file:// 报 `file-access` 时文案引导开开关。
- **验证**：`node scripts/verify-pdf-doc.mjs`（本地 http 站回 200 application/pdf / HTML 伪装 / 404 三种 URL，mock LLM 断言 anthropic wire 带 document 块、追问第二轮仍带、失败路径不建会话）；SW 侧 `isPdfUrl` 路由由 `scripts/test-llm-unit.mjs` 单测覆盖；右键菜单真实点击人工验收。

### 翻译协议（Port 'om-tx'，视口驱动）

编排页（隐藏 runner iframe / 聊天卡 / 面板）→页面：`om:tx_start{mode,targetLang}` / `om:tx_batch{items:[{id,text|null}]}` / `om:tx_progress{phase:'done'}` / `om:tx_set_mode` / `om:tx_cancel` / `om:tx_restore`。页面→编排页：`om:tx_ready{total}` / `om:tx_need{items:[{id,text}],total}` / `om:tx_batch_applied{appliedIds,failedIds}` / `om:tx_ended{reason}`（页面侧已还原）/ `om:tx_error`。

1. **注入**：bridge.js（IIFE，禁 import）+ `insertCSS`（`.om-tx-dst` 渐入动画、`.om-tx-wait::after`「翻译中」标记、失败下划线；页面级样式不受页面 CSP 管）。`om:tx_start` 先清扫页面残留的译文节点与打标——bridge 重复注入时新实例的 state 是空的，restore 清不掉旧译文，不清扫会新旧叠加
2. **块发现**（bridge 内置）：块选择 `p,h1-h6,li,blockquote,td,th,[role=rowheader/columnheader/cell/gridcell],figcaption,dd,dt`（ARIA 角色覆盖 x.ai / Notion 式 div 对比表——不是 `<table>`，纯图标格子无文本被文本过滤自然淘汰），leaf-most 过滤；子树含 pre 等结构元素跳过（`<a>`/`<code>`/`<kbd>`/`<samp>` 不跳——文档站标题内嵌锚点、正文/表格单元格混行内代码都是正常内容，行内代码由 prompt 保持原样，代码块整体不译（pre 在拒收名单、pre 内部节点由 `candidateText` 的 `closest('pre')` 拒收）；**svg 不在拒收名单**——图标无文本，不是拒收理由，导航链接带 chevron 图标必须照常收录；**h1-h6 豁免 button**——手风琴问题头是标准模式 `h3 > button > span 问题文本`，整块拒掉 FAQ 问题就永远译不了）；第二遍兜底收录**祖先与后代都没被已收录块覆盖的裸 `a`/`span`**（顶栏/页脚导航链接、列标题 span、面包屑；不能把 a/span 放进主选择器——leaf-most 会把带内联链接的正文段落拆成只译链接；后代检查防悬停大菜单 `a` 内含 `span` 标题 + `p` 描述时重复收录双译；按钮内文本是 UI 控件仍不译，**选项卡标签 `role=tab` 例外**——Individual/Teams/API 是内容导航不是动作按钮；**pre 内部节点一律拒收**——语法高亮（Pygments/highlight.js）把代码拆成逐 token 的 span，兜底扫描只查自身与子树、不看祖先，token span 会逐个收录，「翻译中」标记逐行打进代码块、伪译文回填破坏代码展示（Flink 文档 SQL 块实报，`closest('pre')` 统一在 `candidateText` 拦，行内 `<code>` 不受影响））；**自身插入的译文节点（`.om-tx-dst` 或其后代）不收录**，否则 MutationObserver 会把对照译文当新内容再译一遍；**header / banner role 不再整块跳过**——顶栏导航链接与悬停大菜单都挂在 `<header>` 里，一跳全跳正是「顶部区域不翻译」的根因；**li 的全部文本来自唯一子链接时让 `<a>` 自己当块**——沉浸模式 li 整块替换会抹掉链接，导航就点不动了；`checkVisibility()` 不可见、<2 字符、数字/URL/符号占比 >60% 跳过；**纯 ASCII 无空格且含 `._-/:=@#` 的标识符/路径、`key: value` 形态的配置项跳过不译**；单段 >2000 字符截断；发现阶段不设量上限——上限由编排页按已受理翻译量执行（见第 4 步），否则长页下半部分进不了视口观察器，滚动续译会断
3. **视口调度**：bridge 用 IntersectionObserver（rootMargin 下方 1 屏预取）观察已收录块，进视口才打 `om-tx-wait` 标记并节流 150ms 上报 `om:tx_need`；MutationObserver（去抖 500ms，去抖窗口内累计节点不丢弃）收录后续动态插入的块并纳入观察——滚动到哪译到哪，新内容自动续译。**可见性只卡「未渲染」（裸 `checkVisibility()`，不含 checkOpacity/checkVisibilityCSS）**：IO 只在几何量变化时回调，opacity/visibility 变化不会再触发——淡入弹层/悬停菜单若因 `opacity:0` 被扣下就永远等不到第二次回调（「弹框弹出后不自动翻译」即此）；淡入中的块直接上报，译文落在透明容器里展开即见，`display:none` 的块没有几何量本就进不了回调、展开后 IO 自然补发
4. **分批**：编排页受理 `om:tx_need` 时执行累计上限（maxBlocks 段 / maxChars 字符，只计已受理的翻译量，到顶静默忽略后续需求）；队列按序攒批，块数（batchBlocks，默认 6）或 1600 字符先到为准；2 worker 并发，每批独立 `streamChat` 调用强制 `temperature: 0`，译完一批回填一批（逐段渐入）
5. **容错**：批次失败重试 2 次（退避 1s/3s，prompt 追加严格 JSON 提醒）；429 全队列中止；上下文超限 → 批内对半拆分递归重试；**流挂死由 `sse.js` 空转看门狗兜底**（连接开着但零数据时 `read()` 永不落定——中转/上游挂死的典型形态，批次会无限卡在「翻译中」；首帧 180s / 帧间 60s 超时断开报错，走普通重试路径，`node scripts/test-llm-unit.mjs` 覆盖）；译文解析走容错阶梯（直接 parse → 剥围栏 → 首`[`到末`]` → `{"translations":[…]}` → 字符串字面量正则兜底 → 长度对齐）；prompt 要求代码/命令/路径/配置键值/标识符保持原样
6. **回填**（bridge）：对照 = 段后插 `.om-tx-dst` 兄弟节点（渐入动画）；格子型宿主（`td`/`th`/`li`/`blockquote`、ARIA 表格角色）译文追加进格子内部——表格行/ARIA 行是表格或网格布局，插兄弟会多出一列挤乱整行；沉浸 = `textContent` 整块替换为纯译文，收录时记 `innerHTML` 快照（**行内 `<a>/<code>` 等标记在还原/切回对照时按快照恢复**，不再对富内容块降级对照——真实页面正文几乎都带行内链接，降级会让沉浸模式名存实亡）；失败段落保留原文加点状下划线；已请求全部落定且队列排空 → `om:tx_progress done`，浮球置完成态，后续 `om:tx_need`/`om:tx_batch` 自动回到进行中态
7. **浮球**：closed Shadow DOM，44px 固定右下，进度环（已落定/已请求）+ 菜单（对照/沉浸/还原原文/关闭）；**完成态只停留 3 秒自动收场**——还原由浮窗 ✓ 按钮承接、切模式由设置齿轮承接（齿轮改动经 `om:tx-mode` 事件即时重铺已译内容，无需重译），常驻的「双/译」球与浮窗并存像残留；译完后 Port 断开浮球直接撤，译到一半断开才变灰保留本地还原；新批次（`om:tx_batch`）到达自动重建浮球；扩展重载遗留的旧浮球 DOM 在 `ensureBall` 时先移除再建，避免跨 isolated world 双球
8. **还原**：沉浸从缓存写回、对照移除插入节点、清样式/观察器/浮球/定时器，并向编排页发 `om:tx_ended`（编排页静默收场）
9. **SPA 守卫**：1.5s 轮询 `location.href` + popstate/hashchange，URL 变化自动还原复位（快照语义，不做跨页续译）

### 快捷动作

SW 右键菜单从 `llmSettings.quickActions` 动态生成（父菜单「Vela」+ 4 条默认动作 + 「翻译此网页」）；`om:refresh-menus` 消息触发重建。动作点击 → SW 先向来源标签页发 `om:open-card` 展开页内聊天卡，再替换 prompt 模板 `{text}` 为选中文本（截 2000 字符）写 `pendingTask`，聊天卡 iframe（与原生面板同为 sidepanel.html）加载时消费或经 `storage.session.onChanged` 实时消费自动发送；`ask` 类任务（划词提问 / 面板追问）消费时若当前会话是零消息的空白会话且引擎为 agent，先把引擎掰到 LLM（按页新建会话取全局默认引擎常为 agent，不掰会被 agent 守卫拦住等 bridge，快问石沉大海；已有内容的会话引擎不动）；来源页浮窗无应答（扩展重载后旧页面浮窗失效、chrome:// 页不可注入）时，后台先 `executeScript` 补注浮窗重试，仍不可注入则开独立聊天页兜底——不调 `sidePanel.open`，原生面板一旦打开收不回去。

### 划词思维导图

**交互模型：高亮只记录，生成永远显式。** 频繁增删高亮若逐次生成会让导图结构反复重排，所以素材先落库，用户读完再一键生成。

- **记录**：划词工具条点「高亮」→ content script 发 `om:mindmap-collect` → SW 把归一化文本记入 `chrome.storage.local` `omMindmapInbox`（`src/mindmap/draft.js` 纯函数：按页 key（URL 去 hash）分组、文本归一去重、单页 100 段上限、全库 200 页 LRU；取消高亮（再点一次）同步移出对应段，页面素材清空即删页）。右下角 toast 只提示段数。
- **查看入口（两个，都不生成、只开查看页）**：划词工具条「思维导图」钮；浮窗动作列「导图」钮（无需选中文字，像翻译一样常驻可见）。SW 顺带把页面正文快照（content script 快照前先隐藏自身浮层——收集 toast 等文案不属于页面内容；`innerText` 压连续空行截 12000）写进素材库该页条目——**没有条目也建（items 为空）**：整页生成模式不需要任何高亮素材，同样按 updatedAt LRU 淘汰——再写 `storage.session` `omMindmapJob:<id>`（`{view:1, url, title}`）后 `tabs.create` 打开 `src/mindmap/mindmap.html#job=<id>`；查看页消费即删（刷新不带任务，无任务落输入视图可手动粘贴任意主题）。
- **生成（双模式，顶栏可切换）**：查看页素材卡列出本页全部高亮段（可逐段 × 删除）。「生成思维导图」＝**高亮素材模式**（默认）：`buildMindmapPrompt` 用网页正文作上下文 + 【高亮片段】逐段编号（`assembleDraftText` 组装，超限按比例截断），高亮是要点（所有片段要点不可遗漏、可归纳合并不逐段硬拆），未高亮内容不单独成支。「用整页正文生成」＝**整页模式**：`buildMindmapFullPrompt` 直接用整页快照，零高亮也可用，忽略导航/目录/页脚。顶栏「高亮导图 / 整页导图」切换钮（画布与输入视图都显示；当前模式禁用并高亮为主色）：切另一模式时同页已有该模式记录则**直接打开零 LLM 调用**，没有才走对应生成（`switchPageMode`，生成仍由点击显式触发）。「新导图」清空画布回输入视图（粘贴另起一张），清空前记 `state.backId`，顶栏亮出「‹ 返回导图」一键退回被清空的图。两套 prompt 共用颗粒度规则（`MINDMAP_GRAIN_RULES`）：宁整勿碎（叶子是可独立看懂的完整要点短句、严禁单词级拆分与同义分支）、按原文章节脉络归纳组织（不逐条机械映射）、父节点 2~6 个子节点、没有真正子结构不再加层。**出处标注**：高亮模式叶子末尾标〔片段n〕（多来源〔片段1、片段3〕；素材无【片段n】编号时不标——手动粘贴即无），整页模式标〔§小节名〕（截 12 字内），推理补全的节点不标。生成在查看页上下文（MV3：流式 fetch 不进 SW）用激活供应商 `streamChat` 单轮完成，流式期间 250ms 节流渐进解析渲染。
- **历史与增量**：成品按页 key 存 `omMindmaps`（最近 50 份）——**同一页高亮与整页各一条**（`rec.mode: 'material' | 'full'`，老记录无 mode 按 material 认领；查看入口默认展示高亮记录，本页无高亮素材时回落整页记录；历史列表带「高亮 · / 整页 ·」模式标签）。指纹双轨：高亮记 `draftSig`（素材，顺序敏感 djb2，增删改/换序都变），整页记 `textSig`（正文，`p` 前缀，与素材指纹永不互撞）。没变重开直接渲染旧图零调用；有变仅状态提示（「素材有更新（N 段）」/「网页正文有更新」），点「重新生成」沿用当前模式覆盖对应记录。`#id=<mm:>` 重开不调 LLM。手动粘贴生成的是无页 key 的独立条目。
- **编辑**：双击节点就地改名（fixed 定位浮层跟节点，Enter 提交 / Esc 取消）；「编辑大纲」切 textarea 视图，`outlineToMarkdown` 回填、改完 `parseOutline` 解析回来（roundtrip 同构，单一顶层节点即根、多顶层包在原标题下），应用即重渲染并回存。
- **渲染与导出**：零依赖 SVG 双侧树：根居中、一级分支左右分列（整洁树布局，分支配色子树继承），节点点击折叠（外侧直接子节点数徽标，双击不触发折叠闪动）、拖拽平移、滚轮缩放（光标为锚）、适配视图。叶子标签尾部的出处标注（〔片段n〕/〔§小节名〕）经 `splitRef` 拆出，渲染成 11px 灰色小字 tspan（同行放得下紧接主体、放不下退自身一行；label 本身保留完整标注，编辑/导出往返不丢）。大纲解析与导出是纯函数（`src/mindmap/outline.js`，Node 可自测）：`parseOutline` 支持标题层级与 2/4 空格、tab 缩进的嵌套列表（缩进栈推断层级、列表挂靠最近标题），剥模型爱加的 ``` 围栏与行内标记；`outlineToFreemind` 输出 FreeMind 1.0.1 XML；导出 .md / .mm 经 Blob `<a download>` 落盘。注意：SVG 元素上 `el.hidden = false` 只是无效 expando（SVG 无 hidden 属性语义），显隐必须 `toggleAttribute('hidden', …)`。

### 划词高亮颜色自检（selection-popup.js diagnoseHl）

- **三保险着色**：class + 页内 `<style>` + 内联样式（CSSOM 赋值不受页面 CSP 限制），内联侧 background-color 与同色 background-image（linear-gradient）双写，`forcedColorAdjust:none` 保 Windows 高对比度。应用后 400ms 首检（computed 底色 / 尺寸 / opacity / 逐行盒 elementsFromPoint 遮挡 / 内联样式），1s×15s 监测移除与颜色覆盖（覆盖自动重写最多 3 次）。遮挡判定对行盒中心做命中测试：命中 span 自身 / 后代为正常可见；**命中祖先同样不算遮挡**（`el.contains(span)`）——祖先绘制在后代之下不可能盖住高亮，Google 结果卡（`<a><h3>` 内层 pointer-events:none）把 hit-test 让给外层 `<a>` 属此类，此前误报「被 A 遮挡」。
- **像素终验**（700ms/5.2s/12s 三次）：SW 代截当前视口（`om:capture-visible-tab`，PNG），canvas 按 span 矩形采样、按色相族判定。采样坐标 = CSS 矩形 × (位图宽 / innerWidth)——比例式换算对 Windows 显示缩放与浏览器缩放天然成立（e2e 实测 DPR 1.25 / 1.5 / 2.0 位图=视口×DPR 均匀映射，采样全绿）。两类页面静默跳过不报障：祖先链带 filter / mix-blend-mode（暗色/护眼改色，屏幕颜色不可按原色预期）、页面捏合缩放（截屏与 DOM 坐标不同系）。
- **失败报障带证据**：toast 内嵌采样区实际截屏缩略图（canvas 直绘，绕开页面 img-src CSP）与占比 / 采样区均值 / 采样框尺寸——「截屏空白」（均值贴白/黑边，截屏没拍到该区域）与「画了但颜色被改」（均值有色，绘制被吃）由截图 toast 即可分辨，不再依赖控制台截图。像素类报障每次会话只完整弹一次（`sessionStorage` 按 origin 去重，复发仅 console）；无证据的失败（遮挡 / 被移除 / 覆盖）仍逐次弹。
- **增强绘制**（终验失败先自动补层再复验）：box-shadow inset 999px + outline 2px + background-clip 压回 border-box + `-webkit-text-fill-color` 强制实色，全部内联 `!important`（压过页面样式表的 `!important`），覆盖「只按 background 下手」与「背景裁进字形」两类压制。
- **跨块选区逐块包裹**（`wrapRangePerBlock`，真实 Flink 文档页报障的根因）：选区跨段落时 `range.extractContents()` 把块级片段（`<p>` 等）整只包进一个 inline span——**Chrome 不绘制含块级子元素的行内盒自身背景**，computed 样式全绿、文字照排、屏幕零像素显色（增强绘制同样无效：box-shadow 也属该行内盒）。单行与段内跨行选区保持纯行内不受影响。修后把 range 相交的文本节点按最近块级祖先分组（`isBlockish` 按 computed display 排除 inline / inline-block / contents / none），每块单独 extract + 包一只纯行内 `.om-hl` span（元素边界端点自动落 0 / length 偏移；纯空白文本节点跳过——块间换行没有行盒，包了只造 0x0 隐形 span 还会把自检引到零尺寸矩形上）；自检（diagnoseHl）挂首块 span，各块同一构造同一 CSS 不逐块进管线。取消高亮走既有 `unwrapHighlights`（解包 range 相交的全部 `.om-hl`），多 span 天然兼容，逐块可单独删。
- **对照探针终审**（报障前的最后闸门）：像素终验两连败后，先在视口左上角画一粒与高亮**同色相**的实心小块（`#om-hl-probe`，fixed 顶层、alpha 抬到 1、`forced-color-adjust:none`、pointer-events:none），走同一条 `captureVisibleTab` 链路截下来验色。探针显色而高亮不显色 → 截屏链路可信，判定「绘制被页面/扩展针对性拦截」，报障成立；探针也不显色 → 截屏或全局色彩链路本身不可信（系统色彩滤镜、GPU 合成、截屏 API 环境差异），不判 vela 故障、不弹报障（此类环境里用户眼睛多半看得见高亮，报障是假警报），仅 console 留痕。探针首轮不显色时 350ms 后复测一轮，其间高亮自己显色按「截屏时序抖动恢复」处理。探针底色取 `HL_COLORS[key].bg` 把 alpha 置 1——绿色高亮配黄色探针过不了绿色 pred，会把真压制误判成链路不可信而漏报。Flink 文档页实报即探针判「paint」（真拦截）顺出上面的跨块根因——探针机制首战即正确。
- **删除高亮入口**：悬停小胶囊（showHlBtn）的垃圾桶钮之外，划词工具条在选区处于高亮内时（`hlOn` = 选区两端 `closest('.om-hl')` 都命中且非代码模式）追显「删除此高亮」钮（`data-act="del-hl"`），点击与「高亮」钮共用 `toggleHighlight` 取消分支（解包 span 并同步移出素材库）——此前再选中已高亮文字时工具条上没有可见删除钮，取消入口过藏。`scripts/verify-hl-pixel.mjs` 覆盖祖先路由不误报、删除钮全链路与 xblock 跨段落逐块包裹（含单块删除保邻块）。

### 网页媒体

Monica 式悬停交互，**悬停是唯一入口**（原浮窗「媒体」大面板与整页扫描清单已按需求移除）：鼠标停在媒体元素上浮出操作钮，点钮就地展开单媒体弹层（`src/media/panel.html?mode=hover`，扩展页 iframe，shadow host `#om-media-pop`，约 400px）。**分工由上下文能力决定**：弹层是扩展页——host_permissions 让它直接 fetch 跨域图片字节、流式视觉调用与 `chrome.downloads` 都合规（MV3：网络不进 SW）；宿主 `widget.js` 在页面源里——blob: 图片 canvas 转码（字节只存在于页面源）、视频 seek 截帧必须在这边做。两侧 postMessage 对接（来源校验 `isMediaWin(ev.source)`：仅当前悬停弹层的 contentWindow，iframe 挂在 shadow root 内，取 `contentWindow` 必须经 `.shadowRoot.querySelector`）：`om:media-img-req{src,idx}` → `om:media-img{ok,dataUrl|error}`、`om:media-frames-req{src,idx,count}` → `om:media-frames{ok,frames:[{t,dataUrl}]|error}`、`om:media-close` ←（弹层 ✕）请宿主收起，面板侧 `hostCall` 带 4~20s 超时。转码 / 截帧的目标元素**按 src 精确匹配**（弹层只带 src，没有扫描列表；匹配不到明确报错「目标已不在页面上」——退回首元素会把无关媒体悄悄分析掉）。

- **图片 → 视觉附件**（`imageAttachment` + `downscale`）：blob: 先经宿主 canvas 转 data:（同源不污染画布；跨域图抛 SecurityError 时提示「受跨域保护」）；http/data 直接 fetch。png/jpeg/webp ≤3.5MB 原样透传，其余（gif 取首帧、超大图、SVG 经 Image 栅格化）OffscreenCanvas 降采样到最长边 1568 / jpeg q0.85。附件随 user 消息 `attachments` 下发（OpenAI `image_url` / Anthropic base64 `image` 块，适配层已支持）。
- **图片四动作**：分析 / 提取 = `buildImagePrompt`（分析讲主体与要点；提取要求逐字保留图中所有文字、表格出 markdown、代码出代码块；图注 alt 与来源 URL 随 prompt 给出），结果流式渲染进卡片结果区（缓存复用，带复制按钮）；进导图 = 一句话描述（`mode:'describe'`）以 `【图片】` 前缀经既有 `om:mindmap-collect` 入本页素材库（显式带 `url`——弹层页没有 tab 上下文），**已分析过的图直接复用分析结果零额外调用**（冷路径先跑一句话概括）；下载 = 文件名取 URL basename（清洗非法字符，mime 兜底扩展名），URL 直交 `chrome.downloads`（`filename` 生效；blob: 先转 data:——objectURL 交给下载器会丢指定文件名落成 UUID）。
- **视频**：LLM 看不了视频，按时间轴抽关键帧整包交给视觉模型（`buildVideoFramesPrompt`：分析 = 主题与内容演进分点，提取 = 逐帧字幕/文案逐字标注先后）。截帧在宿主 `captureFrames`：seek 到 [4%, 25%, 50%, 75%, 96%] 时长（最多 5 帧至少 2 帧，768px jpeg 0.82，帧序还原 `currentTime`）；`'seeked'` 只代表定位完成，**MSE 流（bilibili 类）上新帧要再等一拍 `requestVideoFrameCallback` 确认上屏才能画**——立刻画会拿到旧帧或半解码的模糊帧（慢解码 / 不支持该 API 由超时与 rAF 兜底）；**MediaRecorder 产的 webm `duration=Infinity`**，先 seek `1e7` 触发 durationchange 拿到真实时长再回到 0（durationchange 慢机器上可能迟到，重试一轮，两轮都失败按单帧兜底）；跨域保护视频报「无法截帧分析」。下载只对**直连文件**（http(s) src）开放——URL 直交下载器；流式（blob:/MSE）没有独立文件地址不可下载，只能截帧分析；嵌入播放器 iframe 跨域进不去，随大面板一并不再支持。
- **悬停钮与就地弹层**：`widget.js` 在 document 上监听 `mouseover`，命中 ≥80px 的 `img`/`video`（渲染矩形任一边达标，过滤 `#om-` 前缀宿主与 chrome-extension 源）停留 200ms 后，于目标右上角浮出品牌紫圆钮（`#om-media-hover`，fixed，滚动/缩放 rAF 跟随）；离开宽限 350ms 收起，命中钮/弹层视为未离开。点钮开就地弹层 `#om-media-pop`（复用 `panel.html?mode=hover&kind=img|vid&src=…&w=…&h=…&alt=…&vk=…&dur=…&url=…&title=…`——页面 url/标题随 query 带入，进导图素材入库要用）：面板检测 `mode=hover` 即单媒体模式，隐藏页签/重扫、单卡全宽大图、头部加 ✕。弹层开着 `popPinned` 让钮保持为锚；再悬停别的媒体钮跟过去、弹层按 `popSrc` 对比**就地重载**（不关再开）；收起路径 = 弹层外点击（document capture 阶段判定）/ 弹层内 ✕（`om:media-close`，只认弹层窗口）/ 再点同目标的钮。收起后指针仍压在媒体上时，遮罩移除会让 Blink 重发 `mouseover`、钮重新长出——留在原地即可再点，属预期行为。

## 样式系统

`tokens.css` 定义全部设计 token（色板/表面/边框/间距/圆角/字号），`chat.css`、`options.css` 只消费变量；暗色经 `prefers-color-scheme` 全套覆盖。主按钮为实心品牌紫（#6841EA，暗色 #9880F8），圆角 6/12/16/pill 四档，基准字号 14px。图标全内联 SVG。浮球样式内嵌 Shadow `<style>`。

## 并发与一致性

- 流式增量到达快于 storage 往返：内存 `localContent` 是权威值，写入经 promise 链串行化，全量覆盖（不做增量追加，杜绝读-改-写交错丢字）
- 流式 persist 500ms 节流；结束/停止/出错强制落盘（总结消息含 12000 字符正文，避免逐增量全量重写放大）
- DOM 渲染 rAF 节流；流式期间锁定会话切换与删除，总结/翻译按钮置忙
- 翻译按需队列：bridge 视口上报 → 2 worker 顺序领批，AbortController 贯穿整轮，取消即中止未发批次；`done` 只代表当前已请求范围译完，滚动新需求继续入队
- 用户停止：AbortController + `stopped` 标记持久化

## 错误处理

HTTP 状态 → 固定文案（401/403 Key 无效、404 URL 版本根错、429 限流、5xx 上游错、TypeError 网络或 CORS）；流内错误帧经 `onDelta.error` 上抛并同帧 `finished: true`。错误写入消息项持久化，重新打开会话可见。

## 测试连通性

- OpenAI 兼容：`GET {base}/models`，成功回填模型列表（合并去重）
- Anthropic：先 `/v1/models`，404 时退回 `max_tokens: 1` 最小补全请求（部分网关不实现 models 端点）
- 模型列表始终允许手动输入，不依赖拉取

## 边界（暂不做）

YouTube 总结、思维导图、截图问答、画图；PDF 页内对照阅读器（二期，自建 pdf.js 阅读器 + 复用 om-tx 视口协议做页内对照翻译——一期 PDF 标签页管线见上文，整文档级已可用）；翻译跨页续译（同页动态内容经 MutationObserver 续译，跨页/导航不续）；聊天卡或面板发起的翻译在卡/面板关闭后终止（浮窗路径的隐藏 runner 不受影响）；工具调用（OpenAI `tools` / Anthropic `tools`，接口已留 `params` 扩展位）；会话导出；多窗口并发流式。
