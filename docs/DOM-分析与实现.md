# AI Studio DOM 分析与实现依据

输入：用户提供的 `1.zip`、`2.zip`、`3.zip` 和 `3.1.zip`。`1.zip` 包含 6 个对话与回复状态快照，采集日期 2026-09-03；`2.zip` 包含 1 个打开 Run settings 且三个辅助工具开启的快照；`3.zip` 包含 3 个新版空白页、Model selection 和 System instructions 快照；`3.1.zip` 包含图片上传完成待发送、两个生成中状态和回复完成状态。后三包采集日期均为 2026-09-04。页面均来自 `https://aistudio.google.com/app/prompts/new_chat`。

## `3.zip` 的改版差异

新版把模型卡片从一个按钮拆成了容器和内部按钮。旧页面是 `button.model-selector-card`，并用 `[data-test-id="model-name"]` 显示完整模型 ID；新版外层 `div.model-selector-card` 不可点击，入口改为内部的 `button.model-selector-trigger`，当前主模型只在 `.title` 中显示名称。旧选择器因此会直接报“找不到模型选择器”。

新版 Model selection 仍使用 `button[id^="model-carousel-row-models/"]`，`3.zip` 中有 21 个模型，完整 ID、`.model-title-text` 和搜索框都保持不变。适配器现在同时支持两种入口；新版通过目标模型列表行的名称与当前 `.title` 精确对应，切换后再次校验。后续轮次也会重新核对，避免页面模型被手动改变后继续发送。

新版默认页展示 `Antigravity Agent Preview`，并额外提供 `data-test-id="agent-model-badge"` 的内部模型徽章。该徽章表示 Agent 的 harness 模型，不等于主模型选择。扩展会点击主模型入口并选择用户设置的普通 Gemini 模型，避免把“Gemini 3.8 Flash”徽章误判为已经切换到普通 Gemini 3.8 Flash。

System instructions 的按钮、面板、textarea、预设下拉和关闭按钮没有发生影响现有流程的变化。章节输入框、上传 input、Run 按钮以及三个工具的语义标签也保持兼容。`3.zip` 没有发送完成后的页面；随后提供的 `3.1.zip` 已补齐图片上传完成、生成中和完成后的 DOM，并确认现有回复完成信号仍然成立。

## `3.1.zip` 的图片与运行状态

| 页面 | 状态 | 直接证据 |
| --- | --- | --- |
| 01 | 1 张图片上传完成、尚未发送 | 一个 `ms-prompt-media`，内部有 `data-test-id="prompt-media-container"`、`ms-prompt-image img.loaded-image`、文件名 `image.png`、`data-test-id="token-count"` 的 `259 tokens` 和 `aria-label="Remove media"`；没有上传进度节点；Run 为 `type="submit"`、`aria-disabled="false"`。 |
| 02 | 已发送、生成中 | 输入区附件已进入用户消息；Run 区显示 `progress_activity` 和 `Stop`。 |
| 03 | 继续生成，已有思考与正文结构 | Run 仍为 `Stop`；出现新的模型和思考节点，尚无反馈按钮。 |
| 04 | 正式回复完成 | Run 恢复为 `Run`，输入框为空所以 `aria-disabled="true"`；正式回复出现 `Good response` 与 `Bad response`。 |

生成中的快照还揭示了一个容易误判的结构：对话区同时存在两个 `User` 角色节点。第一个只是下一轮输入用的空白占位节点，只有普通 Angular 类；第二个才是已经提交的消息，带 `text-chunk-host` 和独立 turn ID。长正文在后续快照中又会被虚拟滚动卸载，节点正文变空，但 `text-chunk-host` 与 turn ID 仍保留。因此回复边界会忽略空白占位节点，并以已提交 chunk host、turn ID 和消息顺序跟踪当前轮次；不能简单按 `User` 节点数量或当前文字内容判断。

由此可以确认：待发送时，图片完成的强信号是每张图片对应一个 `ms-prompt-media`，并且该节点已经出现 token count 与 Remove media；Run 同时恢复可用。输入框内的语音按钮还包含一个 `<canvas>`，它不是附件，不能计入图片数量。

## 六份快照各自证明了什么

| 快照 | 实际状态 | 直接证据 |
| --- | --- | --- |
| 01 | 新对话空白页 | 空的 `ms-prompt-box`；Gemini 2.5 Pro 模型卡片；系统指令按钮；文件 input；Run 的 `aria-disabled="true"`。 |
| 02 | 打开 Model selection | 21 个以 `model-carousel-row-models/` 开头的模型按钮；模型标题、模型 ID 与搜索输入框。 |
| 03 | System instructions 面板与预设下拉展开 | `ms-system-instructions` 中的 textarea 和 `mat-select[role="combobox"]`；`Create new instruction` 与“经济类拆书”选项。 |
| 04 | 已选中“经济类拆书”预设 | combobox 显示该名称；面板中有 Saved 状态与 Close panel。 |
| 05 | 待发送章节文字状态 | 输入框的 `ng-dirty` 和较大的 height；Run 的 `aria-disabled="false"`；系统指令卡片显示长文本。 |
| 06 | 一次正式回复完成 | 共 3 个 `ms-chat-turn`，分别是用户、思考过程、正式正文；正文有反馈按钮；全局 announcer 文本是 `Response ready.`；Run 再次禁用。 |

重要：HTML 序列化没有可靠保存 `<textarea>.value` 的实时属性。05 的 HTML 中 textarea 标签内部为空，不能据此断言原网页没有输入。实际运行必须读取和写入 DOM 元素的 `.value`，并触发框架监听的 input / change 事件。

## 定位策略

| 操作 | 采用的选择器或结构 | 为什么这样选 |
| --- | --- | --- |
| 输入章节文字 | `ms-prompt-box textarea[aria-label="Enter a prompt"]` | 限定在底部输入区，避免误写历史消息编辑框或系统指令。 |
| 上传图片 | `ms-prompt-box input[data-test-upload-file-input]` | 包中存在真实的 multiple 文件输入框，无需弹出操作系统选择器。 |
| 发送 / 检查运行标签 | `ms-run-button button`，内部 `.run-button-label` | 读取 Run / Stop 语义，同时检查 disabled 与 aria-disabled。 |
| 当前模型 | 旧版用 `ms-model-selector [data-test-id="model-name"]`；新版将 `.model-selector-trigger .title` 与目标列表行名称精确对应 | 兼容完整模型 ID 和新版只显示名称的卡片；不会把 Agent 内部模型徽章当成主模型。 |
| 模型入口 | `ms-model-selector button.model-selector-card, ms-model-selector button.model-selector-trigger` | 前者来自 `1.zip`，后者来自 `2.zip` / `3.zip`。 |
| 选择某模型 | `button[id^="model-carousel-row-models/"]` 的完整 ID | 完整 ID 与目标精确匹配，避免把名字近似的其他模型选中。 |
| 打开系统指令 | `button[aria-label="System instructions"]` | 稳定语义标签。 |
| 自定义指令 | `ms-system-instructions textarea[aria-label="System instructions"]` | 先选 Create new instruction，再写正文，避免覆盖已有具名预设。 |
| 选择已有预设 | `ms-system-instructions mat-select[role="combobox"]` → `[role="option"]` | 按用户指定的预设名称精确匹配。 |
| 关闭设置面板 | 当前面板中的 `button[aria-label="Close panel"]` | 限定面板作用域，避免点到其他同名按钮。 |
| 用户轮次 | `ms-chat-turn` 内的 `[data-turn-role="User"]` 或 `.chat-turn-container.user`，再核对已提交 chunk host / 内容结构 | 以本轮新增的真实已提交用户节点作为回复边界，忽略 AI Studio 常驻的空白 User 输入位。 |
| 模型轮次 | `ms-chat-turn` 内的 `[data-turn-role="Model"]` 或 `.chat-turn-container.model` | 不抓取全部页面文字。 |
| 排除思考 | `.thought-activity-host` 与 `ms-thought-chunk` | 06 中思考过程也是 Model 消息，单看 Model 角色会出错。 |
| 提取正式内容 | 本轮新增正式模型轮次里的 `ms-text-chunk` | 不包含用户输入、系统指令、历史回复或工具栏。 |
| 正式完成正信号 | 当前正式回复的 `button[aria-label="Good response"]` | 页面 06 中存在，配合 Run 标签恢复和正文稳定判断。 |

不依赖 `_ngcontent-*`、`_nghost-*`、`ng-tns-*`、`mat-mdc-dialog-1` 等运行时生成标识。采集到的消息 `turn-*` ID 则作为当前执行轮次的事实记录保存，不写死其值。

## 三个辅助工具默认关闭

`2.zip` 显示，三个开关都是 `button[role="switch"]`；开启状态同时具有 `aria-checked="true"` 和 `mdc-switch--checked`。输入框工具栏还会为已启用工具提供以下语义明确的移除按钮：

| 工具 | 开关标签 | 已启用时的移除按钮 |
| --- | --- | --- |
| Code execution | `aria-label="Code execution"` | `aria-label="Remove Code execution"` |
| Google Search | `aria-label="Grounding with Google Search"` | `aria-label="Remove Grounding with Google Search"` |
| URL context | `aria-label="Browse the url context"` | `aria-label="Remove URL context"` |

执行器在模型和系统指令设置完成后、填入本轮内容之前检查这三项。优先点击工具栏中的移除按钮，因为 Run settings 折叠时这些按钮仍可存在；如果只有开关可见，则直接关闭开关。随后同时检查移除按钮已经消失，并且对应开关不再是开启状态。任何一项无法确认关闭都会暂停当前轮次，不点击 Run。这个检查在每轮发送前执行，防止模型切换或页面状态变化重新启用默认工具。

## 最容易写错的地方

### 不能用“按钮重新启用”表示输出结束

页面 06 明明已经 Response ready，但 Run 是禁用的，因为输入框为空。实现要求：

1. 先记录发送前所有消息节点 ID。
2. 发送后识别唯一新增的用户消息。
3. 只采集这个用户消息后面的新模型正文节点，排除思考节点。
4. 正文非空；其反馈按钮存在；Run 标签回到 Run、没有 Stop；正文稳定至少 2.5 秒。
5. 正文保存成功后才推进下一轮。

稳定时间不是独立完成条件。即使模型思考很久、某段文字几秒不变化，只要正式结束信号没出现，就不能续发。全局 `Response ready.` 也可能保留上一轮的文本，因此没有单独把它当作完成信号。

`3.1.zip` 的生成状态快照确认了 Stop / Cancel 标签与生成中图标；正式反馈按钮仍是本版采用的正向确认之一。如果后续版本移除反馈按钮，会暂停而不是猜测完成。

### 不能直接 innerText 全页，也不能不分层级拼每个 cmark 节点

正式回复用 `ms-cmark-node` 嵌套包装 `<ul>/<li>/<p>`。递归抓每个 cmark 节点会多次读取相同段落，直接 innerText 则丢失列表缩进。

实现先克隆本轮 `ms-text-chunk`，移除按钮、图标和附加信息，将自定义包装节点展开为语义 HTML，然后用本地 Turndown 转换。代码块使用 `<pre><code>` 原始文本，保留代码换行；GFM 插件处理表格等结构。全过程不占用用户剪贴板。

### 不能把隐藏工具提示当成当前错误

01 和 06 的页面尾部都含有关于付费 API Key 的说明或工具提示，有些隐藏文案在成功输出后仍然存在。实现只读取可见错误区域，不在整页文本中简单搜索“API key”然后判断失败。

### 图片“赋给 input”不等于已上传成功

本版将本地 Blob 转成浏览器 File，通过 DataTransfer 设置真实文件 input，再触发 change。上传确认与 Run 可用性分成两个阶段：先确认附件预览数量符合本轮图片数、上传进度消失并稳定，再单独等待 Run。这样模型权限、API Key 或额度导致的 Run 禁用不会被错误显示成“等待图片上传”。

`3.1.zip` 提供了精确结构：每张完成的附件对应一个 `ms-prompt-media`，其内部必须有 `prompt-media-container`、token count 和 Remove media 控件。适配器优先使用这组强信号；同时保留旧版 `ms-image-chunk`、含媒体的 `ms-prompt-chunk`、普通图片/媒体节点和语义预览容器作为兼容后备。多个信号取最大数量而不是相加，避免外层容器和内部 `<img>` 被重复计数；语音按钮中的 `<canvas>` 被明确排除。上传中状态识别 progressbar、spinner、`aria-busy` 和上传进度类。图片处理确认后再等待 Run 可用，然后才记录发送意图。内容脚本重载后，如果页面草稿与当前轮次文字完全一致、已有图片数也完全吻合，则沿用页面附件，避免重复上传。

## 数据与执行结构

```text
组（name、默认 model、默认 system、异常等待上限、导出方式）
├─ 对话 A（可覆盖 model / system）
│  ├─ 轮次 1（文字、图片引用、正式回复）
│  ├─ 轮次 2
│  └─ 轮次 3
├─ 对话 B
│  └─ 3 轮
└─ 对话 C
   └─ 4 轮

执行顺序：A.1 → A.2 → A.3 → B.1 → … → C.4
```

一个组在任意时间只有一个执行中的轮次，扩展同时只运行一个组。程序为活动组建立一个贴在当前显示器右边缘的专用 AI Studio 大窗口，目标宽度为可用屏幕的 68%，常见桌面限制在约 1050–1400 像素，避免 AI Studio 在窄屏响应式布局中隐藏模型与 Run settings。对话各自使用全新的页面，按需创建，不并发发送。当前页面始终被激活并设置为不可自动丢弃；页面心跳按组内 `focusIntervalSeconds`（默认 10 秒）请求后台重新应用窗口位置并将窗口切到最前面。进入下一对话时，先创建并激活新页面，再关闭上一对话页面；保存最后一轮后关闭整个执行窗口。浏览器若拒绝指定窗口边界，调度器退回普通窗口并继续置顶，避免因窗口布局失败而卡住任务。

每个对话的 `run.sessions[conversationId]` 会持续保存最后观察到的 AI Studio URL。标签页关闭不删除该记录；工作台在“运行与结果”中按对话列出并重新打开。URL 必须已经离开 `/app/prompts/new_chat` 才视为可恢复的独立会话。若当前轮次已有 ARM/checkpoint，重新打开后会替换失效的标签 ID，并继续观察和采集，绝不再次点击 Run；历史对话则作为普通查看页打开，不混入当前专用执行窗口。

### 各组件的职责

| 组件 | 职责 |
| --- | --- |
| `manager.html / manager.js` | 完整工作台，编排组、对话、轮次，管理图片与文件导入，展示结果并下载。 |
| `background.js` | 短事件驱动的调度、消息来源检查、持久化、专用执行窗口与标签页生命周期、通知、暂停和恢复。 |
| `content/dom.js` | AI Studio 页面控件适配、模型和系统指令设置、附件准备、正文识别和 Markdown 转换。 |
| `content/runner.js` | 当前轮次执行、MutationObserver 与轮询、完成确认、心跳、结果回传。 |
| `lib/db.js` | IndexedDB：groups、assets、meta。图片按 Blob 保存，避免把整本书塞进小容量同步存储。 |
| `lib/model.js` | 层级数据、下一待执行轮次、配置继承、文件名处理与 Markdown 组装。 |

后台不持有“等整本书完成”的 Promise。内容脚本收到任务后立即应答，长时间观察发生在执行标签页，结果通过新的短消息回传。后台随时被 Chrome 回收后，可从数据库恢复任务。

Chrome MV3 后台是事件型 service worker，内存变量不能当长期数据存储；依据 [Chrome 官方迁移说明](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)。通过内容脚本操作共享 DOM、与扩展后台通信的机制依据 [Chrome Content scripts 文档](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。运行期间保持系统唤醒使用 [chrome.power](https://developer.chrome.com/docs/extensions/reference/api/power)。

### 一轮的持久化顺序

```text
准备页面 → 模型/指令校验 → 三个辅助工具关闭并校验 → 文字/附件就绪
  → ARM（先保存发送意图与旧消息 ID）
  → 点击 Run
  → SENT（等待回复）
  → 收到本轮正式回复
  → 同一组记录内提交 result，并清除 current
  → 页面 READY / 调度事件启动下一轮
```

所有后台写操作经过串行队列；正式结果和当前指针保存在同一个 IndexedDB group 记录，事务成功才回执。内容脚本对执行 token 去重。

如果 ARM 已保存，但 Run 点击/回执结果不确定，只能恢复观察，不自动重发。原标签失效时，可在 AI Studio 已生成独立会话 URL 的前提下重新打开并接管；URL 仍是 `new_chat` 时停止并提示。网页刷新导致发送前状态丢失时，需要检查残留草稿和附件后再继续。若当前独立对话的第 1 轮还没有 ARM 记录，说明 Run 一定尚未点击；此时原标签页关闭或扩展重载后标签 ID 失效，可以安全新建页面并从模型设置阶段重新准备。同一对话的后续轮次只有恢复到原独立会话地址后才允许继续核对上下文。

## 确认过的边界

- 包内已经包含图片上传完成、生成中、正式回复完成和长正文虚拟卸载状态，但没有连续多轮、图片正在上传、配额错误、浏览器重启和刷新恢复的完整证据。
- 本版的多轮编排和防重复由实际扩展 + 模拟页面验证；这不等于对当前 AI Studio 网站的全量兼容性认证。
- 没有调用网站内部接口、注入/读取登录凭证、切换 API 模式或设置付费 Key。
- 模型权限、账号额度和 AI Studio 本身的限制仍然适用；网页不可操作时扩展停止。
- 页面 DOM 改版时优先更新 `content/dom.js`，无需重写层级数据、保存机制和导出逻辑。
- 不承诺重启电脑后跨任意标签 ID 自动恢复；不承诺浏览器主动冻结页面时仍以原速度运行。
- 本地“临时 Markdown”是可随时重新组装的已持久化回复集合，不直接持续写用户磁盘上的某个文件。用户点击下载时才生成“组名.md”并保存到浏览器默认下载目录；工作台可直接打开该目录。
