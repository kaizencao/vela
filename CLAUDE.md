# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目构成

一个仓库两个独立交付物：

- **扩展本体**：Chrome MV3 扩展（`manifest.json` 在仓库根）。零构建、零第三方依赖，纯 ES module 由 Chrome 直加载。功能：聊天（原生侧边栏 / 独立聊天页 / 页内聊天卡）、网页总结、整页翻译、划词动作、思维导图（划词高亮 / 整页正文）、网页图片 / 视频理解（悬停弹层）。
- **bridge/**：Node ≥18 伴生进程，独立 npm 项目（依赖 `ws` + `@anthropic-ai/claude-agent-sdk`）。WS 服务监听 `127.0.0.1:39217`，把本机 agent CLI（Claude Code 经 Agent SDK、Codex 经 `codex app-server` JSON-RPC）暴露给扩展页。不进扩展包，单独分发。

设计文档是权威参考，改协议或架构前先读：`docs/DESIGN.md`（扩展架构 / 数据模型 / 翻译协议 / 并发一致性）、`docs/agent-bridge.md`（WS 协议全部 op、归一化事件词汇表、bridge 模块职责）。

## 常用命令

扩展无构建步骤：`chrome://extensions` 开发者模式加载仓库根目录，改代码后在扩展页点「重新加载」。

```bash
# bridge 启动（首次先 npm install）
cd /d E:\code\vela\bridge && node index.js    # 或双击 bridge\start.bat；--port 可改端口

# bridge 测试（都在 bridge/ 目录下跑）
npm test                    # = node turn.test.js && node codex-adapter.test.js（hub 与 codex 适配器自测）
node smoke.js               # 协议冒烟：进程内起 server + ws 客户端走关键 op（需先 npm i）
node claude-options.test.js
node live-check.js          # 真实 claude turn，产生真实调用，不进 CI

# 扩展全量自动化测试（仓库根）：单元 → 打包 → 浏览器 e2e，串行；需要 bridge 的项自动拉起
node scripts/test-all.mjs              # 离线全量（LLM 走本地 mock，不产生真实调用）
node scripts/test-all.mjs --network    # 追加真实网页车道；--real-llm 追加真实供应商/agent 调用
node scripts/test-all.mjs --only=llm   # 按名称过滤
node scripts/test-kb-unit.mjs          # 本机知识库 / 文件工具单元（内存假文件系统）
node --experimental-vm-modules scripts/check-syntax.mjs  # 全部 ES module 语法检查
node scripts/test-llm-unit.mjs         # LLM 适配器 / 路由 / 工具循环单元（node:test，无浏览器）

# 打包
node scripts/package.mjs         # → dist/vela-<manifest 版本>.zip（白名单：manifest.json/src/assets）
node scripts/package-bridge.mjs  # → dist/vela-bridge-<版本>.zip

# 辅助
node scripts/restart-bridge.mjs  # 杀 39217 监听进程并隐藏窗口重启 bridge
node scripts/make-icons.mjs      # 图标生成（零依赖 PNG 编码）
```

`scripts/verify-*.mjs` 是 e2e / 诊断脚本，用本机 Playwright Chromium 驱动真实浏览器（`scripts/lib/chrome.mjs` 自动挑 `%LOCALAPPDATA%\ms-playwright` 下最新的 chromium-*，`VELA_CHROME` 可覆盖；品牌版 Chrome 137+ 已禁用 `--load-extension`）。新写的 e2e 用 `scripts/lib/cdp.mjs`（拉起浏览器 / 连 target / 真实鼠标）与 `scripts/lib/mock-llm.mjs`（OpenAI + Anthropic 双协议 SSE mock，含工具调用）。真供应商类脚本先跑 `node scripts/tmp-extract-llm.mjs`（从已安装扩展的 LevelDB 提取 llmSettings 到 `%TEMP%/vela-llm-settings.json`，key 不落日志）。

## 架构

### MV3 生命周期约束（决定所有网络代码的落点）

- 流式 fetch 一律在扩展页（sidepanel / chatpage / 聊天卡 iframe）执行，不进 service worker——MV3 SW 空闲约 30 秒回收，挂起的流式响应不可靠。
- `src/background/service-worker.js` 只做路由：右键菜单组、pendingTask 中转、浮窗注册、快捷键，不做任何网络请求。
- 页面功能编排（`src/page/page-actions.js`）也在扩展页：翻译是长任务（多批次 × 流式），同样不能进 SW。
- pendingTask 管线：SW 把动作（quick-action / page-summary / translate-page）写 `storage.session.pendingTask`，聊天卡 / 面板监听 `storage.session.onChanged` 消费执行。`ask` 类（划词提问 / 面板追问）消费时若当前会话是零消息空白会话且引擎为 agent，先掰到 LLM 再过引擎守卫——按页新建的会话默认引擎常为 agent，不掰会被守卫拦住等 bridge，快问石沉大海；已有内容的会话不碰。

### 视图与数据模型

- 三个页面：`src/sidepanel/sidepanel.html`（原生侧边栏与页内聊天卡 iframe 复用同一文档）、`src/chatpage/`、`src/options/`。
- 侧边栏与聊天页同构：`shell.js`（DOM 骨架）+ `chat-ui.js`（交互与编排，最大文件），差异经 variant（panel/wide）区分。
- 数据全在 `chrome.storage.local`：`llmSettings`（供应商、翻译参数、quickActions、agentBridge 配置）与 `conversations`。ID 客户端生成（`conv:` / `msg:` 前缀），消息树靠 `parentItemId` 串联。
- 多视图会话同步：各视图持有内存 conversations，经 `storage.onChanged`（200ms 防抖、内容比对去自写）互相刷新。

### 双引擎聊天（engine 是会话级字段；顶栏 `#om-engine` 切换：Agent / LLM 问答 / LLM 任务）

- `engine:'llm'`：`streamChat`（`src/llm/store.js`）→ `openai.js` / `anthropic.js` 两协议 SSE 适配器，UI 只见归一化增量 `{text, finished, error, toolCalls?}`（每次请求 finished 只发一次）；`sse.js` 共用分帧解析。`tasks.js` 是总结 / 翻译 prompt 构建纯函数。会话记 `llmProviderId`/`llmModel`，发送时按 providerId 精确路由（不传则用激活供应商，翻译等页面功能走这条）。user 消息可带 `attachments`（图片附件：OpenAI 序列化为 `image_url`、Anthropic 为 base64 `image` 块，纯文本消息仍序列化为字符串）——媒体面板的视觉理解走这条。
- `llmMode:'tools'`（LLM 任务）：`tool-loop.js` 纯逻辑工具循环（参数校验、审批、步数上限、取消），`browser-tools.js` 11 个浏览器工具（读当前页 / 选中 / 标签页 / 元素快照 / 等待信号、联网读取、开标签、下载、按 ref 点击、配方循环点击采集；fetch_url / open_tab / download_file / click_element / extract_click_collect 先弹审批卡）。`extract_click_collect` 让模型出一次配方 JSON、扩展页机器速度循环「点击→等待→抽取→翻页」零模型调用（配方与上限见 `validateExtractRecipe` / `EXTRACT_CAPS`）。点击开出新标签页的处置：click_element 带 `on_new_tab` 三档（capture 默认等加载完提取正文附进结果后自动关 / block 拿到 URL 即关 / allow 保留），护栏挂 `tabs.onCreated/onUpdated`、只认 `openerTabId == 源标签页`，源标签页永不触碰，多开超 3 个直接关；extract_click_collect 循环固定按 block 拦（`guardNewTabs`）。权限档两引擎贯通：`#om-perm` 在任务模式同样可见，生效档 = `conv.permissionMode ?? settings.agentBridge.permissionMode ?? 'default'` 每轮读；bypassPermissions 在 approve 闸门直接放行全部工具不弹审批卡，acceptEdits 只放行 write_file/edit_file。页面侧函数在 `injected.js`，经 executeScript 注入必须自包含；`runIn` 带 Promise.race 注入预算（注入撞上整页跳转的文档销毁窗口会永不落定，实测挂死工具循环）。事件复用 agent 归一化词汇，步骤存 `answer.meta.tools.steps`，与 agent 步骤同款渲染。
- 聊天卡的网页上下文与页绑定：会话有持久绑定字段 `conv.pageKey`（去 #hash 的页地址），`pageCtx` 只是上下文内容。widget 开卡带 `?page=&pt=`，卡 init 三级选会话（`?conv` 记忆 > pageKey/pageCtx 推导匹配 > 新建绑本页会话），不再回退全局最近活跃——B 页的卡不会串 A 页的会话；`reconcileHostCtx`（chat-ui.js）按绑定比对，空会话原地换绑、有消息的会话新建对话，老会话按 pageCtx.url 推导认领（零迁移）；`pagehide` 里 agent 轮发 cancel、LLM 流式 abort+flushNow（fire-and-forget，bridge「断开不杀」语义不动）；`pendingTask` 只由可见实例消费。细节见 `docs/DESIGN.md`。
- 知识库（会话级，三种引擎共用一个入口）：除 bridge 类条目（上传 / 本机路径，仅 Agent）外，`kind:'handle'`——浏览器 File System Access 授权的本机文件夹 / 文件，句柄存 IndexedDB（`src/kb/store.js`，chrome.storage 存不了句柄），会话只记 `{id, name, handleKind, wsPath}`；发送时在用户手势内补授权（浏览器重启后会回到「询问」）。聊天卡（跨源 iframe）弹不出选择框、跨源 requestPermission 也被禁，「授权文件夹 / 文件」自动降级为 `kind:'snapshot'` 只读快照：`<input type="file">`（webkitdirectory）选中的文件字节复制进 IDB `snapshots` store，`src/kb/snapshot-fs.js` 包成与句柄同形的只读根（写入抛 ReadOnlyError，`files.js` 的 `notFound` 原样放行），三引擎共用、重载后仍可读、无需 bridge，上限 200 个 / 单个 50MB / 合计 200MB。LLM 任务经 `src/llm/fs-tools.js` 读写（list / search / read / write / edit / load_skill，写入先弹 diff 审批）；LLM 问答把授权的单个文件附进 system；Agent 发送前由 `src/kb/sync.js` 增量上传到工作区 `wsPath`（bridge `upload.begin` 的 `overwrite`）。`src/kb/files.js` 按格式读取：文本带行号（UTF-8 失败退 GBK）、docx/xlsx/pptx 经 `zip.js` + `office.js` 转 Markdown、PDF / 图片作为工具结果附件交给模型原生读取。说明型 skill 放在知识库目录 `.vela/skills/<名>/SKILL.md`（只支持文档，MV3 禁止执行外部脚本）。
- LLM 引擎的知识库也能用 bridge 路径（`kind:'local'`）：聊天卡里浏览器弹不了文件选择框，`src/kb/bridge-fs.js` 把 bridge `fs.*` 包成与 File System Access 同形的虚拟句柄，`fs-tools.js` 共用；bridge `fs.read` / `fs.list{hidden,stat}` / `fs.check{size,mtimeMs}` 是为此新增（bridge 0.4.2）。
- `search_files` 先遍历全树再并发读内容，结果末尾必须说明没搜全的原因；不要把遍历 / 读取上限改回静默截断（会让模型误判「知识库里没有」）。`node scripts/test-search-unit.mjs` 覆盖。
- `engine:'agent'`（新会话默认；顶栏切换后的选择记入 `llmSettings.chat.defaultEngine`）：`src/agent/client.js` 单例 WS 客户端（重连退避、seq 缺口补帧、768KiB 分块上传）→ bridge → Claude Agent SDK。`render.js` 纯函数把归一化事件折叠成渲染状态（离线可从 `answer.meta.agent` 重放）；`compose.js` 纯函数组装 prompt（知识库 / 附件以工作区相对路径附加）。bridge 侧 systemPrompt preset 追加两段引导（`LARGE_TASK_HINT` 大任务拆分 + `TAB_DISCIPLINE_HINT` 标签页纪律：优先当前页导航、新标签页读完即关、绝不关用户主页面），SDK snapshot 语义只有新会话生效。

### bridge 内部链路

`index.js`（启动 / 端口 / 单实例锁）→ `server.js`（token 自动配对、Origin 必须以 `chrome-extension://` 开头、id 配对请求 / 响应、分发 `upload.*`）→ `workspace.js`（工作区 `baseDir/<workspaceId>` 解析 + 分块上传状态机）→ `turn.js`（会话 hub：seq、500 帧环形缓冲、权限请求 / 应答）→ `agents/claude.js`（SDK 适配器，把 SDK 消息流归一化为事件）、`agents/codex.js`（spawn `codex app-server`，JSON-RPC 按行分帧，事件归一化同词汇表）。新增 agent 只加 `bridge/agents/` 适配器，协议不动。

事件帧 `{type:'event', sessionId, seq, event}`；事件 kind 词汇表（`message_chunk` / `thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `permission_request` / `session_info` / `usage` / `turn_end`）见 `docs/agent-bridge.md`。未知 kind 丢弃不报错——CLI 迭代快，容错优先。

### 页面功能层

- `src/content/widget.js` + `selection-popup.js`：常驻浮窗与划词工具条，经 `scripting.registerContentScripts` 注册（http/https，persistAcrossSessions）。浮窗默认收起为 40×40 品牌紫悬浮球（`.om-ball`），悬停 180ms 展开、移开 300ms 收起、点球立即展开；收起态按住球、展开态按住胶囊本体（角上隐藏/暂停钮除外）都能上下拖（位移超 4px 才算拖，松手吞掉合成 click 不展开不误开聊天卡——只绑球等于没有拖动，悬停 180ms 就展开，球态几乎按不到），锚点存 `chrome.storage.local` `om-widget-pos` 跨页记忆，resize 只对已固化为 px 的锚点 clamp（默认态 `style.top` 是 `'38%'`，`parseFloat('38%')`=38px 是坑，锚点计算走几何位置）；聊天卡或翻译设置弹层开着时常开，点击 host 外收起——凡真鼠标点浮窗动作钮的 e2e 必须先 hover 球展开（JS `.click()` 不受 display:none 影响）。胶囊右上角「暂停本页」钮（`.pause`，跑网页自动化前点；点击先弹确认卡说明作用，确认才执行——title 悬停提示太隐蔽，用户不知道钮干嘛）：sessionStorage `om-page-paused` 按标签页记 `{u: 页地址}`，浮窗 / 媒体悬停钮 / 划词工具条 / 代码钮一起摘除并判停（widget 注入早退 + 媒体 mouseover 守卫 + selection-popup show/showCodeBtn/showHlBtn 只读同一 key）；换页（整页跳转）保持暂停，注入时记的地址 == 当前地址视为同址刷新，清标记恢复（前进/后退回到暂停地址同样恢复），关标签页自然清空；`scripts/verify-page-pause.mjs` 覆盖。浮窗「下载为 Markdown」钮 / 右键菜单「下载此网页为 Markdown」：SW 注入 `injected.js` 的 `pageToMarkdown()` 整页原样转 GFM（与 `extractArticle` 的取正文相反，不裁内容），经离屏文档 `src/page/offscreen.js` 用 `<a download>` 锚点落盘——SW 造不了 blob URL、离屏 API 面没有 downloads，落定由 SW 查 `downloads.search({url})` 精确匹配确认；不可注入页（PDF / chrome://）静默失败。`scripts/verify-download-md.mjs` 覆盖。
- `src/content/bridge.js`：翻译回填 + 浮球 + SPA 守卫，按需 files 注入（IIFE，禁 import）。
- `src/content/injected.js`：自包含正文提取函数与任务模式页面工具（元素快照 / 按 ref 点击 / 等待信号 / 配方采集，executeScript func 注入，ISOLATED world；每个导出函数必须自包含——只序列化函数本体，辅助函数内联进函数体）。
- 连续阅读（连读，跟随「下一页」）：从当前文档页读完一组系列文档。入口 = 浮窗「连读」钮 / 右键菜单，经 pendingTask 管线（`kind:'read-series'`）由聊天卡/面板消费；不走引擎管线（与翻译同类，逐页总结直接 `streamChat` temperature 0）。导航是确定性打分不烧 LLM：`src/read/series.js pickNextLink`（`<link rel=next>` 120 > `<a rel=next>` 100 > 整段文本「下一页/next…」80 > 前缀「下一页：…」60 > 纯箭头 50，nav/分页容器 +15，同分取文档序靠后；**只跟同源**、去 hash 同址不算翻页）。第 1 页从实况标签页取（`extractArticle` + `collectAnchors`），第 2 页起 `fetchSeriesPage`（20s 超时 / 3MB 上限 / 跟重定向）+ `parseSeriesHtml`——**DOMParser 文档必须显式传 baseUrl**（解析文档的 base 是扩展页，相对 href 会解析到扩展源）；解析统一走 `src/common/html.js` 的 `parseFetchedHtml`（与 fetch_url 工具共用）：字符串层先剥 `on*=` 内联事件处理器，否则惰性解析文档继承扩展页 CSP，控制台会刷「Executing inline event handler violates…」违例噪音。visited 集合防回环，上限 30 页（`llmSettings.readSeries.maxPages`），逐页 800ms 礼貌间隔；Map-reduce：逐页小结流式进同一回答 + 收尾总览（≥2 页才做），连续两页失败即停；停止原因（no-next/visited/max-pages/error/aborted）与页清单落 `answer.meta.readSeries`。`scripts/test-read-unit.mjs` + `scripts/verify-read-series.mjs` 覆盖。
- 划词思维导图：**高亮只记录、生成永远显式**。点「高亮」即把选中文本记入素材库 `chrome.storage.local` `omMindmapInbox`（按页 key 分组、去重、上限 100 段，`src/mindmap/draft.js` 纯函数，取消高亮同步移出）；两个入口：工具条「思维导图」钮与浮窗动作列「导图」钮（无需划词，像翻译一样常驻可见）——都只是查看入口，SW 顺带带回页面正文快照（快照前隐藏自身浮层，防 toast 文案混进正文；没有素材条目也建，items 为空——整页生成不需要高亮）写 `storage.session` `omMindmapJob:<id>` 后开 `src/mindmap/mindmap.html`。查看页双生成模式：高亮素材（`buildMindmapPrompt`，网页正文作上下文 +【片段n】编号片段，默认）与整页正文（`buildMindmapFullPrompt`，零高亮可用），顶栏「高亮导图 / 整页导图」切换钮（画布与输入视图都在）：当前模式钮禁用高亮为主色，切另一模式时同页该模式已有记录则直开（零 LLM 调用），没有才显式生成（`switchPageMode`）；「新导图」清空前记 `state.backId`，顶栏亮出「‹ 返回导图」退回。共用颗粒度规则（`MINDMAP_GRAIN_RULES` 宁整勿碎、按原文章节脉络组织、2~6 子节点，高亮要点不可遗漏），叶子出处标注〔片段n〕/〔§小节名〕由 `outline.js splitRef` 拆成 11px 灰色角标渲染（label 保留完整标注，编辑/导出不丢）。流式期间节流渐进渲染；成品按页 key 高亮/整页各一条存 `omMindmaps`（`rec.mode` 区分，老记录按 material 认领；指纹 `draftSig`（素材）/`textSig`（正文，`p` 前缀防互撞），没变重开零调用，变了仅状态提示；`#id=` 重开不调 LLM）。查看页支持就地改名（双击）、「编辑大纲」textarea 往返（`outline.js` 的解析与 `outlineToMarkdown` 同构）、折叠 / 平移缩放、导出 .md / FreeMind .mm（均纯函数，Node 可自测）。注意 SVG 元素没有 `hidden` 属性语义，必须 `toggleAttribute('hidden', bool)`，写 `el.hidden = false` 只会留一个无效 expando（画布空白一类问题的元凶）。
- 划词荧光笔颜色自检（`selection-popup.js diagnoseHl`）：400ms 首检（computed 底色/尺寸/opacity/遮挡）→ 像素终验（SW 代截视口，采样坐标 = CSS 矩形 × 位图宽/innerWidth——比例式换算对 Windows 显示缩放与浏览器缩放天然成立，DPR 1.25/1.5/2 e2e 实测全绿）。遮挡判定命中 span 祖先不算遮挡（`el.contains(span)`：Google 结果卡 `<a><h3>` 内层 pointer-events:none 把 hit-test 让给外层 `<a>`，祖先绘制在后代之下、高亮画得着，命中祖先误报「被遮挡」）。失败 toast 内嵌采样区实际截屏缩略图（canvas 直绘绕开页面 img-src CSP）+ 占比/均值，「空白截屏」与「绘制被吃」由截图即可分辨；像素类报障每会话只弹一次（sessionStorage 去重，复发仅 console）。增强绘制补 background-clip:border-box + text-fill-color（破「背景裁进字形」类压制）。**跨块选区逐块包裹**（`wrapRangePerBlock`，真实 Flink 报障根因）：选区跨段落时 `extractContents` 把 `<p>` 块级片段包进 inline span——Chrome 不绘制含块级子元素的行内盒自身背景，computed 全绿但屏幕零显色（增强绘制同无效）；修后相交文本节点按块级宿主分组逐块包纯行内 span（自检挂首块；纯空白节点跳过——无行盒包了造 0x0 span），取消高亮走既有 `unwrapHighlights` 天然兼容多 span。报障前有**对照探针终审**：视口角落画一粒同色相实心小块走同一截屏链路，探针显色才算真拦截（报障成立），探针也不显色 = 截屏/全局色彩链路不可信（系统色彩滤镜、GPU 合成等环境因素，用户眼睛多半看得见高亮），静默跳过不报——「每次高亮都弹红框」假警报由此截断（Flink 实报即探针判真拦截，顺出跨块根因）。祖先链 filter/mix-blend-mode（暗色/护眼）与捏合缩放静默跳过。划词工具条在选区已处于高亮内时带显式「删除此高亮」钮（`del-hl`，走 toggleHighlight 取消分支）——删除入口此前只在悬停小胶囊上。`scripts/verify-hl-pixel.mjs` 覆盖（含 nested 祖先路由、xblock 跨段落逐块与删除钮链路）。
- 网页媒体理解（Monica 式悬停交互，**悬停是唯一入口**，浮窗「媒体」大面板钮已按需求移除）：鼠标停在 ≥80px 的 `img`/`video` 上 200ms，其右上角浮出品牌紫圆钮（`#om-media-hover` shadow host）；点钮就地弹 `src/media/panel.html?mode=hover&kind=…&src=…` 单媒体弹层（`#om-media-pop` 扩展页 iframe，LLM 流式视觉调用 / 跨域图片字节 fetch / `chrome.downloads` 都在扩展页，SW 零参与；单媒体模式隐藏页签/重扫，✕ 经 `om:media-close` 请宿主收起），换悬停目标弹层就地重载（`popSrc` 对比）；弹层开着钮是锚不收起，弹层外点击 / ✕ / 再点钮收起（收起后指针仍压在媒体上时 Blink 重发 mouseover，钮会重新长出——合理行为）。`widget.js` 负责 blob 图片 canvas 转码、视频关键帧抽取（含 MediaRecorder webm `duration=Infinity` 的 `currentTime=1e7` 修复；MSE 流 `'seeked'` 后再等一拍 `requestVideoFrameCallback` 确认新帧上屏才画，否则拿到旧帧 / 半解码模糊帧），经 postMessage 对接（`om:media-img-req` / `om:media-frames-req`，iframe 在 shadow root 里，取 `contentWindow` 必须经 `.shadowRoot`；宿主消息来源白名单 `isMediaWin` = 当前悬停弹层，转码 / 截帧按 src **精确匹配**页面元素，匹配不到明确报错「目标已不在页面上」——不退回首个元素，那会悄悄分析到无关对象）。图片四动作：分析 / 提取（附件随 user 消息，`tasks.js buildImagePrompt`）/ 进导图（描述以 `【图片】` 前缀经既有 `om:mindmap-collect` 入素材库，已分析过直接复用，冷路径先跑一句话概括）/ 下载（URL 直交下载器，`filename` 生效；blob: 先转 data:）。视频 = 关键帧视觉分析（`buildVideoFramesPrompt`，直连文件可下载，流式 / MSE 只列出）。整页扫描清单与嵌入 iframe 播放器列举随大面板一并移除。`scripts/verify-media.mjs` 覆盖。
- 翻译协议走 Port `'om-tx'`（`om:tx_start` / `om:tx_need` / `om:tx_batch` …），视口驱动：IntersectionObserver 上报进视口的块，编排页分批流式翻译后回填，滚动续译。编排页在扩展页或隐藏 runner iframe（`src/page/tx-runner.html`）。代码块整体不译：块收集在 `candidateText` 里 `closest('pre')` 拒收 pre 内部所有节点——语法高亮（Pygments/highlight.js）逐 token span 曾被 a/span 兜底扫描逐个收录（该扫描只查自身与子树、不看祖先），「翻译中」标记逐行打进代码块、伪译文破坏代码展示（Flink 文档 SQL 块实报）；行内 `<code>` 不受影响（prompt 保持原样）。`scripts/verify-immersive.mjs` 覆盖。

## 约定与红线

- **命名前缀 `om-` / `om:`**：DOM id/class、runtime 消息类型、storage 键、菜单 id 全用（历史沿用，别引入新前缀）。
- **零依赖**：扩展 `src/` 只用 chrome.\* API，不引入 npm 包；`bridge/` 是唯一 npm 项目。不引入打包器 / 转译器，代码直加载。
- 注释与 UI 文案用中文，标识符用英文。
- **流式持久化模型**：内存 `localContent` 是权威值，写入经 promise 链串行化、全量覆盖，500ms 节流；流式期间锁定会话切换。轮收尾的存储重载带 `preparing` 增量守卫：重载 await 期间有新发送推进内存版就保持内存版（否则存储旧快照整表替换会把刚发出的提问洗掉）。改持久化逻辑时保持这套模型，防读-改-写交错丢字。
- **上传路径双侧清洗**：扩展侧 `sanitizeName`（chat-ui.js）+ bridge 侧 `sanitizeRelPath`（workspace.js），落盘约束在工作区内。
- bridge 只绑 `127.0.0.1`，不转发到外网；token 首次握手自动配对，无手工配置环节。
- **注册式内容脚本的坑**：persistAcrossSessions 注册在扩展重载后仍用缓存旧脚本注入，`onInstalled` 里每次 `updateContentScripts` 强制按磁盘文件重读——改浮窗代码后必须重新加载扩展才在页面生效。
- Windows 环境：cmd 的 `cd` 跨盘符必须带 `/d`；`.bat` / `.vbs` 里不要写中文注释（按 ANSI 解析 UTF-8 中文会语法错乱）。
- 版本各自独立：`manifest.json` 的 version 驱动扩展包名与打包产物，`bridge/package.json` 单独维护。
