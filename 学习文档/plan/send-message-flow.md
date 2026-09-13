# 发一条消息的完整流程:从回车到渲染(白话版)

> 时效基线:2026-09-05,okta_login 分支(HEAD 3de05910c);文中行号当日逐文件核对。
> 实测基线:apps/vscode `npx vitest run` 373/376 通过(3 个失败为引擎集成测试既有超时,与本文链路无关,已用 stash 对照确认)。

先一句话说清整件事:你在输入框按下回车,webview 把这条消息通过 bridge 发给扩展宿主;宿主找到(或新建)引擎会话,把消息递给 v2 引擎;引擎每一步(step)都要先解析出"用哪个模型、走哪个协议、凭据是谁、地址在哪",然后由对应的适配器发出 HTTP 请求;流式返回的每个片段经事件投影广播回 webview,逐 token 渲染。失败则按退避表重试,最多 10 次。本文按六步走完这条链,每一站都有代码。

## 全景图

```
【webview】InputArea.tsx:175 handleSend 按下回车
   └→ chat.store.ts:199 sendMessage:流式中则入队(流结束自动发,见 1.2),否则置 isStreaming 并调 doSend
        └→ chat.store.ts:143 doSend:启动 30 秒握手定时器(:13),调 bridge.streamChat(:162)
             └→ bridge.ts:202 streamChat:postMessage {method:"streamChat", params}
── ── postMessage 跨进程 ─ ──
【宿主】bridge-handler.ts:142 dispatch:查 handlers 表,命中 chat.handler 的 streamChat
   └→ chat.handler.ts:74 streamChat:预检(工作区/自动保存)→ :95 getOrCreateSession
        └→ bridge-handler.ts:168 getOrCreateSession → kimi-runtime.ts:89 openSession
             (同视图同会话则复用 :96-106;否则 :117 harness.createSession / :124 resumeSession)
                  └→ kimi-harness.ts:128 → sdk-rpc-client-v2.ts:1255 建引擎会话
        └→ chat.handler.ts:107-124 对齐模型/思考档/计划模式(会话已存在时不被默认值覆盖)
        └→ chat.handler.ts:139 runtime.prompt(prependSystemContext(消息))
             └→ session-runtime.ts:175 prompt → session.prompt → sdk-rpc-client-v2.ts:1903
                  └→ agentFacade(sessionId).prompt   ← RPC 到此返回 {done:true},后面全是广播
【v2 引擎(与宿主同进程)】loopService.ts:849 llmRequester.start
   └→ llmRequesterService.ts:220 start → :233 requestWithTrace → :639 resolveRequest
        ├→ profileService.ts:443 modelCatalog.get      ← 第一次进模型目录(★)
        │    └→ catalogService.ts:255 buildModel:解析 provider/protocol/baseUrl/auth
        └→ :656 getRequester(命中同一个缓存条目)
   └→ :317 runRequest(:319 裁剪历史,:320 媒体降级策略)
        └→ :381 for await requester.request
             └→ modelRequesterImpl.ts:46 request → :75 runRequest
                  ├→ :32 resolveChatProvider → protocolAdapterRegistry.ts:101 选适配器
                  └→ :117 runWithAuthRefresh(getAuth → 401 强刷重试一次)
                       └→ generate.ts:87 generate(消费流)
                            └→ openai-responses.ts:1096 generate
                                 └→ :1214 new OpenAI({apiKey, baseURL})
                                      └→ :1166 client.responses.create(POST {baseURL}/responses)
【失败路】openai-common.ts:121 convertOpenAIError 归一化
   └→ stepRetryService.ts:110 recover:最多 10 次,退避 500ms×2ⁿ×(1+0~25% 抖动)
        ("provider retry 3/10 in 1233.22ms" 就来自这里)
【回流】session-runtime.ts:107 session.onEvent → :440 onSdkEvent(投影成 UI 事件)
   └→ :582 emitStreamEvent:对每个挂着的 webview 广播 Events.StreamEvent
        └→ App.tsx:23 bridge.on(StreamEvent) → chat.store.ts:251 processEvent 逐 token 渲染
```

---

### 第 1 步:webview —— 回车到 postMessage

文件:apps/vscode/webview-ui/src/components/inputarea/InputArea.tsx、apps/vscode/webview-ui/src/stores/chat.store.ts、apps/vscode/webview-ui/src/services/bridge.ts

1.1 按下回车,组件的 `handleSend`(InputArea.tsx:175-182)先做两道检查,然后清空输入框:

```ts
  const handleSend = useMemoizedFn(() => {
    if (isProcessing || (!text.trim() && draftMedia.length === 0)) {
      return;
    }

    addToHistory(text);
    sendMessage(text);
    clearInput();
  });
```

1.2 `sendMessage`(chat.store.ts:199)是 zustand store 里的方法:正在流式输出 → 入队等本轮结束;否则把状态置为"流式中",交给模块级的 `doSend`:

```ts
    // If streaming, enqueue instead of sending
    if (isStreaming) {
      get().enqueue(content, currentModel);
      set({ draftMedia: [] });
      return;
    }
    ...
    doSend(get(), content, currentModel);
```

入队之后呢?队列的出口在 `processEvent`(chat.store.ts:274-280):每收到一个事件都检查 —— 这轮流式结束了(收到 `stream_complete` 或 `error`)、队列里还有货,就 50 毫秒后自动发下一条:

```ts
    // Auto-send next queued item when streaming ends (complete or error)
    if (event.type === "stream_complete" || event.type === "error") {
      const { queue, isStreaming: stillStreaming } = get();
      if (!stillStreaming && queue.length > 0) {
        setTimeout(() => get().sendNextQueued(), 50);
      }
    }
```

`sendNextQueued`(chat.store.ts:465-484)弹出队首,走和手打消息完全一样的 doSend 链 —— 置 isStreaming、重置握手标记、清审批请求、重新启动 30 秒握手定时器:

```ts
  sendNextQueued: () => {
    const { queue, isStreaming } = get();
    if (isStreaming || queue.length === 0) {
      return;
    }

    const [next, ...rest] = queue;
    ...
    useApprovalStore.getState().clearRequests();

    doSend(get(), next.content, next.model);
  },
```

也就是说排队消息一条接一条串行发;排队期间还能编辑或撤单(removeFromQueue :443、editQueueItem :447)。

1.3 `doSend`(chat.store.ts:143)干两件事。第一件是**握手定时器** —— 发出消息后 30 秒内如果没收到引擎的任何一个事件(handshake),就主动中止并报"连接超时"(常量在 chat.store.ts:13):

```ts
const HANDSHAKE_TIMEOUT_MS = 30_000;
...
function doSend(state: ChatState, content: string | ContentPart[], model: string) {
  ...
  clearHandshakeTimer();
  handshakeTimer = setTimeout(() => {
    const s = useChatStore.getState();
    if (s.isStreaming && !s.handshakeReceived) {
      void bridge.abortChat().catch(() => undefined);
      s.processEvent({ type: "error", code: "HANDSHAKE_TIMEOUT", message: "Connection timed out.", phase: "runtime" });
    }
  }, HANDSHAKE_TIMEOUT_MS);
```

第二件是发 RPC(:162-163):

```ts
  void bridge
    .streamChat(content, model, thinkingEffort, planMode, sessionId ?? undefined)
    .catch((error: unknown) => { ...processEvent({type:"error", phase:"preflight"})... });
```

1.4 `bridge.streamChat`(bridge.ts:202-203)拼出请求并发给扩展 —— webview 和扩展不在一个进程,靠 postMessage 传话(和登录篇第 1 步同一套 bridge 机制):

```ts
  streamChat(content: string | ContentPart[], model: string, effort: string, planMode: boolean, sessionId?: string) {
    return this.call<{ done: boolean }>(Methods.StreamChat, { content, model, effort, planMode, sessionId });
  }
```

→ 进入第 2 步。

### 第 2 步:宿主 —— 找到/新建会话,把消息递进引擎

文件:apps/vscode/src/bridge-handler.ts、apps/vscode/src/handlers/chat.handler.ts、apps/vscode/src/runtime/kimi-runtime.ts、packages/node-sdk/src/kimi-harness.ts、packages/node-sdk/src/sdk-rpc-client-v2.ts

2.1 扩展收到消息,`dispatch`(bridge-handler.ts:142-148)在 handlers 表里查到 streamChat 的处理函数 —— 和登录用的是同一张表:

```ts
  private async dispatch(method: RpcMethod, params: unknown, webviewId: string): Promise<unknown> {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    return handler(params, this.createContext(webviewId));
  }
```

2.2 `streamChat`(chat.handler.ts:74)先过两道预检:没开文件夹 → 直接报错并提示打开;开了自动保存 → 先保存所有脏文件(:84-91)。然后拿会话(:95):

```ts
    runtime = await ctx.getOrCreateSession(
      params.model,
      params.effort ?? (params.thinking === true ? "on" : "off"),
      params.sessionId,
    );
```

2.3 `getOrCreateSession` 的实现挂在 HandlerContext 里(bridge-handler.ts:168-179):调 runtime.openSession,再把会话登记给文件管理器:

```ts
      getOrCreateSession: async (model, effort, sessionId) => {
        const runtime = await this.runtime.openSession({
          webviewId,
          workDir: this.requireWorkDir(webviewId),
          model,
          effort,
          yoloMode: VSCodeSettings.yoloMode,
          ...(sessionId === undefined ? {} : { sessionId }),
        });
        this.fileManager.setSession(webviewId, baselineSession(runtime));
        return runtime;
      },
```

2.4 `openSession`(kimi-runtime.ts:89-91)按视图串行后进 `openSessionInner`(:93),分三种情况:

- 同一 webview 已经绑着同一个会话、同一个工作目录(:96-106)→ 应用设置后**直接复用**,不新建:

```ts
    if (
      current !== undefined &&
      requestedId === current.id &&
      areSameFsPath(current.session.workDir, options.workDir)
    ) {
      await applySessionSettings(current.session, options, current.legacyApprovalFlags);
      await current.announceStatus(options.webviewId);
      return current;
    }
```

- 会话 id 已存在(恢复/其他视图持有)→ 校验工作目录后把它**挂到当前视图**(:108-112);

- 全新 → 建会话(:114-124):

```ts
      const session =
        requestedId === undefined
          ? await this.harness.createSession({
              workDir: options.workDir,
              model: options.model || undefined,
              thinking: normalizeEffort(options.effort),
              permission: corePermissionForLegacyApproval(defaultApproval),
              metadata: legacyApprovalMetadata(defaultApproval),
            })
          : await this.harness.resumeSession({ id: requestedId, includeSubagents: true });
```

2.5 再往下两跳:kimi-harness.ts:128 `createSession` 剥掉几个宿主专用的选项后调 RPC 建会话、包成 Session 对象:

```ts
  async createSession(options: CreateSessionOptions): Promise<Session> {
    const { planMode, kaos, persistenceKaos, sessionStartedProperties, ...coreOptions } = options;
    const summary =
      kaos === undefined && persistenceKaos === undefined
        ? await this.rpc.createSession(coreOptions)
        : await this.rpc.createSessionWithKaos(...);
    const session = new Session({ id: summary.id, workDir: summary.workDir, summary, rpc: this.rpc, ... });
```

sdk-rpc-client-v2.ts:1255 是 RPC 侧实现(klient 进引擎;带显式 id 时按会话队列串行,防止并发建/关同一 id):

```ts
  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    // An explicit id takes the per-session queue so the check-then-create
    // below is atomic against another create/close of the same id; a random
    // id has no contenders and needs no serialization.
    if (input.id !== undefined) {
      return this.runSessionAccess(input.id, () => this.doCreateSession(input));
    }
    return this.doCreateSession(input);
```

`doCreateSession`(:1265-1303)真正建会话,按顺序做五件事:

```ts
    const workDir = normalizeRequiredWorkDir('createSession', input.workDir);
    if (input.id !== undefined) {
      const existing =
        this.liveSession(input.id) ??
        (await this.engineAccessor.get(ISessionIndex).get(input.id));
      if (existing !== undefined) {
        throw new KimiError(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${input.id}" already exists`,
        );
      }
    }
    const handle = await this.engineAccessor.get(ISessionManager).create({
      sessionId: input.id,
      workDir,
      additionalDirs: input.additionalDirs,
    });
    // Wired before the optional main-agent materialization so a profile-bind
    // warning (oversized AGENTS.md) reaches the listeners like v1's create.
    this.wireSession(handle);
```

- 校验 workDir 必填;带了显式 id 先查重(活会话表 + 会话索引),已存在直接抛 SESSION_ALREADY_EXISTS;

- 调引擎的 ISessionManager.create —— 在引擎里真正登记一个会话,拿到代表这个会话的对象(`ISessionScopeHandle`,同一个接口的 session 层变体);

- `wireSession(handle)`:把这个会话的事件流接到 SDK(第 6 步回流里 session.onEvent 能收到事件,接线就在这;注释说明它必须在主 agent 创建之前接好,否则 oversized AGENTS.md 的警告会丢);

接着,如果建会话时传了 model / thinking / permission(宿主 2.4 那次调用传了),立刻把主 agent 创建出来(`materializeMainAgent`:已存在就复用,再绑默认 profile 和 model/thinking)并设置权限模式 —— 也就是说**带这些参数建会话时,主 agent 不用等到第一次 prompt,在这里就出生了**(和 2.10 第一跳 agentScope 里的"惰性创建"是同一个函数 materializeMainAgent):

```ts
    if (
      input.model !== undefined ||
      input.thinking !== undefined ||
      input.permission !== undefined
    ) {
      const agent = await this.materializeMainAgent(handle, {
        model: input.model,
        thinking: input.thinking,
      });
      if (input.permission !== undefined) {
        agent.accessor.get(IAgentPermissionModeService).setMode(input.permission);
      }
    }
```

最后,传了 metadata 就写进会话,返回会话摘要。

2.6 回到 chat.handler,:107-124 把界面当前选的模型、思考档、计划模式**对齐**到会话上 —— 注释说明了原因:恢复的会话保留自己的设置,所以要在这里显式应用提交时选的值:

```ts
    const status = await runtime.session.getStatus();
    let model = status.model;
    if (params.model && model !== params.model) {
      await runtime.session.setModel(params.model);
      model = params.model;
    }
    ...
    runtime.announceSessionStart(model);
```

2.7 内容若以 `/` 开头走**宿主斜杠命令**分支(chat.handler.ts:126-135,处理在宿主完成的命令):

```ts
  const slash = parseHostSlashCommand(params.content);
  if (slash !== undefined) {
    try {
      return { done: await runHostSlashCommand(runtime, slash, ctx) };
    ...
```

否则拼上系统上下文后发提示(:137-141):

```ts
  const systemContext = await buildSystemContext(runtime.id, ctx);
    const result = await runtime.prompt(prependSystemContext(params.content, systemContext));
    return { done: result.status === "finished" };
```

2.8 `prompt`(session-runtime.ts:175-176)把输入转成 SDK 格式后交给会话:

```ts
  async prompt(input: string | LegacyContentPart[]): Promise<PromptResult> {
    return this.runTurnAction(input, () => this.session.prompt(toSdkPromptInput(input)));
  }
```

2.9 最后一跳在 SDK 里(sdk-rpc-client-v2.ts:1903-1910):拿到该会话的 agent 门面,发起 prompt —— **这个 RPC 到此就返回了** `{done:true}`,后面的一切都走事件广播:

```ts
  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.prompt({
      input: input.input,
      disabledTools: input.disabledTools,
      promptId: input.promptId,
    });
  }
```

→ 进入第 3 步(引擎内部)。

2.10 `agent.prompt` 到第 3 步之间还有六跳,补齐:

第一跳:`agentFacade(sessionId)`(sdk-rpc-client-v2.ts:1657-1660)返回的不是一个真的引擎对象 —— 调用处的类型注解是 `AgentHandle`,它 = AgentFacade + 一个 events 属性(订阅这个 agent 的事件用的对象),定义在 klient/src/core/klient.ts:34-36:

```ts
export interface AgentHandle extends AgentFacade {
  readonly events: KlientEvents<AgentEventPayloads>;
}
```

events 的类型 KlientEvents(core/events/hub.ts:20-25)统共两个方法:on(事件名, 回调)订阅某类事件(返回的对象调 dispose() 取消订阅)、onError(回调)接收校验失败和监听器抛错:

```ts
export interface KlientEvents<TPayloadMap extends object = KlientEventPayloads> {
  on<E extends keyof TPayloadMap & string>(
    event: E,
    listener: (payload: TPayloadMap[E]) => void,
  ): IDisposable;
  /** Validation failures and listener exceptions surface here. */
  onError(listener: (error: Error) => void): IDisposable;
}
```

能订阅哪些事件,由 `AgentEventPayloads`(contract/agent/events.ts:210-230)这张表定死,共 19 种:

```ts
export interface AgentEventPayloads {
  'turn.started': ...;
  'turn.ended': ...;
  'assistant.delta': ...;
  'thinking.delta': ...;
  'tool.call.started': ...;
  'tool.call.delta': ...;
  'tool.progress': ...;
  'tool.result': ...;
  'prompt.completed': ...;
  'prompt.aborted': ...;
  'compaction.started': ...;
  'compaction.blocked': ...;
  'compaction.cancelled': ...;
  'compaction.completed': ...;
  'permission.approval.requested': ...;
  'permission.approval.resolved': ...;
  error: ...;
  warning: ...;
  'agent.status.updated': ...;
}
```

按用途分:

- 回合起止(turn.started/ended);

- 回答和思考的逐段增量(assistant.delta / thinking.delta —— 界面上逐 token 打字的效果);

- 工具调用全程(tool.call.started / tool.call.delta / tool.progress / tool.result);

- 一次提交的完成与中止(prompt.completed / prompt.aborted);

- 上下文压缩四种;

- 审批请求与结果(permission.approval.requested / resolved —— 工具审批篇里那两个PermissionApprovalRequested/Resolved 事件就是它们);

- 错误与警告;

- 状态更新。

AgentHandle 上你能调的方法,全部定义在 `AgentFacade` 这个接口里 —— AgentHandle 继承 AgentFacade(就是前面贴的 `interface AgentHandle extends AgentFacade`),自己只加了一个属性:events。

AgentFacade 共 13 个方法(facade/agent.ts:49-81):prompt(发消息)、promptWithSkills(带技能激活一起发)、steer(中途转向)、activateSkill(激活技能)、cancel(取消回合)、runShellCommand / cancelShellCommand(跑/取消 shell 命令)、getModel / setModel(查/设模型)、getThinking / setThinking(查/设思考档)、setPermission(设权限模式)、getUsage(用量)。本文这条链只用到 prompt,下文展开它。

```ts
  private async agentFacade(sessionId: string): Promise<AgentHandle> {
    await this.agentScope(sessionId);
    return this.klient.session(sessionId).agent(this.interactiveAgentId);
  }
```

第一行 `await this.agentScope(sessionId)` 是前置动作(agentScope 的定义在同文件 sdk-rpc-client-v2.ts:1640-1651):

```ts
  private async agentScope(sessionId: string): Promise<IAgentScopeHandle> {
    const session = this.requireLiveSession(sessionId);
    const agentId = this.interactiveAgentId;
    if (agentId === MAIN_AGENT_ID) return this.materializeMainAgent(session);
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(agentId);
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" was not found`);
    }
    return agent;
  }
```

干三件事:

- `requireLiveSession`(:941-944):查会话还活着没有 —— 已关闭的会话直接抛 SESSION_NOT_FOUND。不提前查的话会怎样:你调 `agent.prompt(...)`(agent 就是 agentFacade 返回的那个实例)那一次请求照样会发出去,分发器按 sessionId 找不到活着的会话,只能抛一句绕远的 `session not found`(memory/dispatcher.ts:212-214):

```ts
    const session = root.accessor.get(ISessionManager).get(scope.sessionId) ?? getLiveSessionById(root.accessor, scope.sessionId);
    if (session === undefined) {
      throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
    }
```

- 目标是主 agent(常规情况)→ `materializeMainAgent`(:1607 起):主 agent 不存在就先建出来(`ensureMainAgent` —— 引擎的"惰性建主 agent"),等模型就绪后返回代表这个 agent 的对象(类型 `IAgentScopeHandle`,定义见下)—— 首次 prompt 时主 agent 就是在这一刻出生的;

- 目标是子 agent → 按生命周期服务查它的 `IAgentScopeHandle`,查不到抛 AGENT_NOT_FOUND。

`IAgentScopeHandle` 是什么(scope.ts:111-120):一个代表某个会话/agent 的对象,有 3 个属性和 1 个方法 —— `id`(是哪个)、`kind`(是哪一层:app/session/agent)、`accessor`(用它能取到这一层里的任何服务,比如 `accessor.get(IAgentLifecycleService)`)、`dispose()`(销毁):

```ts
export interface IScopeHandle<K extends ScopeKind = ScopeKind> {
  readonly id: string;
  readonly kind: K;
  readonly accessor: ServicesAccessor;
  dispose(): void | Promise<void>;
}

export type IAgentScopeHandle = IScopeHandle<'agent'>;
```

agentFacade 的第一行调用了 `agentScope(sessionId)`,但不接它的返回值 —— 代码里只有 `await this.agentScope(sessionId);`,没有 `const ... =`:要的是 agentScope 执行过程中干的上面三件事(校验会话、把主 agent 建出来),它返回的那个代表对象这里用不着,因为下一行拿 AgentHandle 走的是 klient 那条路。

AgentFacade 从哪来?按调用顺序拆开 `klient.session(sessionId).agent(agentId)` 这一句。

先说 klient 对象:它由 createKlientFromChannel 函数创建并返回(packages/klient/src/core/klient.ts:45,SDK 客户端建立时执行一次);`session` 方法直接写在这个函数返回的那个对象上(klient.ts:112),而 `agent` 方法写在 session() 返回的会话对象上(klient.ts:117)—— 两层,下一节按调用顺序展开。

`.session(sessionId)`:调的是对象上的 session 方法 —— 它创建并返回一个会话对象(SessionHandle),同时把 sessionId 存进 `ScopeRef`(`ScopeRef` = `{ sessionId, agentId }`,调用要送达的坐标,引擎靠它找"哪个会话里的哪个 agent"):

```ts
    session(sessionId: string): SessionHandle {
      const scope: ScopeRef = { sessionId };
      return {
        ...createSessionFacade(call, sessionId),
        events: makeHub<SessionEventPayloads>(scope, sessionEvents),
```

`.agent(agentId)`:调的是会话对象上的 agent 方法 —— 它把 sessionId 和 agentId 一起存进 `ScopeRef`,然后调 `createAgentFacade(call, agentScope)`,返回拼好的 AgentHandle:

```ts
        agent(agentId: string): AgentHandle {
          const agentScope: ScopeRef = { sessionId, agentId };
          return {
            ...createAgentFacade(call, agentScope),
            events: makeHub<AgentEventPayloads>(agentScope, agentEvents),
          };
        },
```

```ts
    session(sessionId: string): SessionHandle {
      const scope: ScopeRef = { sessionId };
      return {
        ...createSessionFacade(call, sessionId),
        events: makeHub<SessionEventPayloads>(scope, sessionEvents),
        agent(agentId: string): AgentHandle {
          const agentScope: ScopeRef = { sessionId, agentId };
          return {
            ...createAgentFacade(call, agentScope),
            events: makeHub<AgentEventPayloads>(agentScope, agentEvents),
          };
        },
      };
    },
```

也就是说,`agent(agentId)` 每次被调用,就现造一个 AgentHandle 返回 —— 就是上面代码里那个带两个成员的对象:`createAgentFacade(call, agentScope)` 拼出来的方法 + `events: makeHub(...)` 造出的事件订阅对象。

传给 createAgentFacade 的 `call` 是一个函数:收到(`ScopeRef`, 服务名, 方法名, 参数)后送进引擎并等结果回来 —— 它的具体实现和"进程内怎么送"在下面"传输层"一小段展开;先看 createAgentFacade 的代码:

```ts
export function createAgentFacade(call: ScopedCaller, scope: ScopeRef): AgentFacade {
  ...
  prompt: (input) =>
    call(scope, 'agentPromptService', 'submit', [input]) as Promise<PromptLaunchResult>,
```

AgentFacade(packages/klient/src/core/facade/agent.ts:107-111)里面没有任何引擎逻辑,每个方法只有一行 —— 把这次调用转成一个通用请求"带着哪个 `ScopeRef`,调哪个服务的哪个方法"。读作:"带着 session 的 `ScopeRef`,调引擎服务 `agentPromptService` 的 `submit` 方法,参数是 input"。

所以 `agent.prompt(...)` 不是方法名巧合 —— 它就是去调第二跳那个 promptService.submit。

"同一接口"的意思:AgentFacade 的 prompt 方法长什么样(参数、返回类型),是从引擎真服务的接口抄来的(`IAgentPromptService`,agent-core-v2/src/agent/prompt/prompt.ts:81)—— 写 SDK 代码时不管引擎在本地还是远端,类型都一样;区别只在 call 背后走哪条路。

"传输层"的意思:call 的实现(klient/src/core/klient.ts:51-62)把(`ScopeRef`, 服务名, 方法名, 参数)交给 channel:

```ts
  const call: ScopedCaller = async (scope, service, method, args, options) => {
    ...
    const data = await channel.call(scope, service, method, wireArgs, options);
```

channel(通道)是个接口,只有两种真实实现:memory(进程内)和 ipc(跨进程)—— "传输层"就是运送这套调用的管道,没有别的含义。VS Code 用 memory:进程内分发器(transports/memory/dispatcher.ts)拿着三元组找到活着的引擎会话、调真服务的真方法;它的文件头注释说明,每个参数和结果都过一遍 `wireClone`(JSON 往返),保证进程内调用和跨 socket 调用拿到的数据一字不差。

第二跳:引擎侧 promptService.submit(agent-core-v2/src/agent/prompt/promptService.ts:328-353):先把本次要禁用的工具写进策略,再把你的消息作为用户消息登记,等它"被发起成回合":

```ts
      const handle = await reservation.submit({
        role: 'user',
        content: [...payload.input],
        toolCalls: [],
        origin: { kind: 'user' },
      });
      if (handle.state === 'pending') return undefined;
      const turn = await handle.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
```

(state === 'pending' 表示引擎正忙 —— 消息入队但还没发起回合,submit 先返回;handle.launched 才等到 turn。)

第三跳:登记最终变成对 loop 的入队请求(promptService.ts:426):

```ts
      turn = (await this.loop.enqueue(request).assigned).turn;
```

第四跳:loopService.enqueue(loopService.ts:166-181)建一个"分配承诺"并进入准许(admit):

```ts
  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt {
    ...
    if (this.quiescenceDepth > 0) {
      this.heldAdmissions.push({ request, options });
    } else {
      this.admit(request, options);
    }
```

第五跳:admit 按准入类型分派(:183-187)—— 用户发新消息是 newTurn → 创建回合任务并 startTurn(:462):

```ts
    switch (request.admission) {
      case 'newTurn':
        this.createAndQueueTurn(request);
        break;
```

第六跳:startTurn(:465-483)广播 TurnStarted 事件(它就是 webview 那边"回合开始"的源头),然后启动回合主循环 runTurn —— 里面是 while (true) 的步进循环(:643),每步走 executeLoopStep,它第一件事就是第 3 步 3.0 的那行 llmRequester.start(:849):

```ts
    void this.runTurn(job.turn, job.ready).then(job.result.resolve, job.result.reject);
```

```ts
      while (true) {
        try {
          const begun = this.beginLoopStep(runtime);
          if ('result' in begun) return begun.result;
          runtime.current = begun.step;
          const result = await this.executeLoopStep(...
```

### 第 3 步:引擎 —— 解析"用哪个模型、怎么发"

文件:packages/agent-core-v2/src/agent/loop/loopService.ts、.../agent/llmRequester/llmRequesterService.ts、.../agent/profile/profileService.ts、.../kosong/model/catalogService.ts、.../kosong/model/modelAuth.ts、.../kosong/provider/providerService.ts

3.0 agent loop 每一步要一次模型请求,起点是 loopService.ts:849:

```ts
      const request = this.llmRequester.start(
        { source: { type: 'turn', turnId, step: currentStep } },
        streamParts.handle,
        signal,
      );
```

3.1 llmRequesterService 三层:`request()`(:212,便捷壳)→ `start()`(:220,造 trace)→ `requestWithTrace()`(:233)→ `runRequest(this.resolveRequest(overrides), ...)`(:242-248)。解析就发生在 `resolveRequest`(:639-656):

```ts
  private resolveRequest(overrides: AgentLLMRequestOverrides): ResolvedLLMRequest {
    const turnConfig = this.resolveTurnConfig(overrides.source);
    const resolved = turnConfig?.resolved ?? this.profile.resolveModelContext();
    const baseParams = turnConfig?.params ?? this.profile.resolveRequestParams();
    const budgetParams = completionBudgetParams({ ... });
    const requester = this.modelCatalog.getRequester(resolved.modelAlias);
```

3.2 `profile.resolveModelContext()`(profileService.ts:441-453)第一次进模型目录(:443):

```ts
  resolveModelContext(): ProfileModelContext {
    const modelAlias = this.model;
    const model = this.modelCatalog.get(modelAlias);
```

3.3 目录的入口 `get`(catalogService.ts:102-107)极薄,真正干活的是缓存条目 `entry`(:119,未命中才构建)和 `buildModel`(:255)。**同一个模型的整条解析链每模型只跑一次**,:443 和 3.1 的 `getRequester`(:656)复用同一个条目。

3.4 `buildModel`(:255-292)依次做四件事,每件都有代码:

**a. 取模型条目**(:256-263)—— 从引擎有效配置的 models 表取,查不到直接抛:

```ts
    const configuredModel = this.models.get(id);
    if (configuredModel === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" is not configured in config.toml.`,
```

**b. 解析 provider**(:268-269 → resolveProviderContext :374-408)—— providerId 三级取值、查 providers 表、解析 baseUrl:

```ts
    const providerId =
      model.providerId ?? model.provider ?? this.providers.getDefaultProvider();
    ...
      const providerConfig = this.providers.get(providerId);
      if (providerConfig === undefined) {
        throw new Error2(
          CONFIG_INVALID_ERROR_CODE,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
```

providers.get 落到 providerService.ts:40-41 的裸表查询:

```ts
  get(name: string): ProviderConfig | undefined {
    return this.providers[name];
  }
```

这张表是**磁盘 config.toml 与内存层合并后的有效视图** —— Okta 登录时通过 setMemoryConfig 注入的 token 就在这张表里生效(注入链见 [kimi-login-flow.md](kimi-login-flow.md) 第 4 步 4.4b 和第 5 步)。

baseUrl 的解析在 resolveEndpointBaseUrl(modelAuth.ts:185 起),三级:模型级 → provider 级 → 内置端点表兜底:

```ts
  const fromModel = nonEmpty(model.baseUrl);
  if (fromModel !== undefined) {
    return { baseUrl: fromModel, source: { kind: 'config', detail: 'model.baseUrl' } };
  }
  const fromProvider = nonEmpty(provider.baseUrl);
  if (fromProvider !== undefined) {
    return { baseUrl: fromProvider, ... };
  }
  const endpointType = provider.type ?? model.protocol;
  const endpoint = ...
```

**c. 解析协议**(:274 → resolveProtocol :431 → modelAuth.ts:150-177)—— 决定用哪个适配器,三级:模型级 protocol → provider.type 本身就是协议 → 厂商定义的 baseProtocol:

```ts
export function resolveModelProtocol(
  model: ModelRecord,
  provider: ProviderConfig | undefined,
): ModelProtocolResolution | undefined {
  if (model.protocol !== undefined) {
    return { protocol: model.protocol, source: { kind: 'config', detail: 'model.protocol' } };
  }
  const providerType = provider?.type;
  if (providerType !== undefined) {
    const asProtocol = ProtocolSchema.safeParse(providerType);
    if (asProtocol.success) { return { protocol: asProtocol.data, ... }; }
    const definition = getProviderDefinition(providerType);
    if (definition !== undefined) { return { protocol: definition.baseProtocol, ... }; }
  }
  return undefined;
}
```

解析不出来就抛 "must declare a wire protocol"(catalogService.ts:438-441)—— 配置错误的模型在这一步秒抛,根本走不到发请求。

**d. 解析凭据**(:290 → resolveModelAuthMaterial,modelAuth.ts:31-52)—— 优先级:模型级 apiKey → 模型级 oauth → provider 级 apiKey → provider 级 oauth:

```ts
  if (modelApiKey !== undefined) {
    trace?.record('resolved.auth', { kind: 'config', detail: 'model.apiKey' });
    return { apiKey: modelApiKey };
  }
  if (args.model.oauth !== undefined) { ... }
  ...
  const providerApiKey = nonEmpty(args.provider?.apiKey) ?? nonEmpty(providerEndpoint.apiKey);
  if (providerApiKey !== undefined && args.provider?.oauth !== undefined) {
    throw authConflictError('Provider', args.providerName);   // apiKey 和 oauth 同段 = 硬错误
  }
```

provider 级 apiKey 为空字符串时(nonEmpty 过滤)会落到内置端点表的 env/apiKey 说明 —— Okta 场景下磁盘写的是 `apiKey=""`,内存层把它覆盖成 token,所以这里拿到的是 token。

3.5 解析完回到 `runRequest`(:317):先把工具调用 id 归一、裁剪历史,按恢复/降级策略处理媒体,然后进入消费循环(:381):

```ts
    this.toolCallIdNormalizer.seedFrom(this.context.get());
    const shaped = this.toolSelect.shapeHistory(request.messages);
    ...
      try {
        for await (const event of request.requester.request(input, signal, {
          ...request.params,
          onTraceId: setTraceId,
        })) {
```

→ 进入第 4 步(真正发请求)。

### 第 4 步:适配器 —— 组装并发送 HTTP 请求

文件:packages/agent-core-v2/src/kosong/model/modelRequesterImpl.ts、.../kosong/provider/protocolAdapterRegistry.ts、packages/kosong/src/generate.ts、packages/kosong/src/providers/openai-responses.ts

4.1 `request`(modelRequesterImpl.ts:46)是个异步生成器,内部进 `runRequest`(:75),第一件事解析聊天适配器(:82 → resolveChatProvider :32-44)—— 拿着第 3 步解出的 protocol/providerType/baseUrl 去注册表换一个 provider 实例(有缓存,同配置只建一次):

```ts
  private resolveChatProvider(): ChatProvider {
    if (this.cachedChatProvider !== undefined) return this.cachedChatProvider;
    const model = this.model;
    this.cachedChatProvider = this.protocolRegistry.createChatProvider({
      protocol: model.protocol,
      providerType: model.providerType,
      baseUrl: model.baseUrl,
      modelName: model.name,
      ...
    });
    return this.cachedChatProvider;
  }
```

注册表这头(protocolAdapterRegistry.ts:101-114)按协议身份找基座、产出适配器(如 OpenAIResponsesChatProvider):

```ts
  createChatProvider(config: ProtocolAdapterConfig): ChatProvider {
    const identity = this.resolveAdapterIdentity(config.protocol, config.providerType);
    ...
    const base = getProtocolBase(identity.baseId);
    ...
    return base.createChatProvider({ config, traits });
  }
```

4.2 发请求带着凭据刷新兜底(modelRequesterImpl.ts:117-133)—— `runWithAuthRefresh` 先取一次凭据;遇 401 且凭据可刷新就强制刷新再试**一次**(定义在 :163-182):

```ts
  private async runWithAuthRefresh<T>(
    run: (auth: ProviderRequestAuth | undefined) => Promise<T>,
  ): Promise<T> {
    const auth = await this.authProvider.getAuth();
    try {
      return await run(auth);
    } catch (error) {
      if (!this.shouldForceRefresh(error)) throw error;
    }

    const refreshedAuth = await this.authProvider.getAuth({ force: true });
    try {
      return await run(refreshedAuth);
    ...
```

`getAuth` 的底层就是登录篇第 5 步那条链(OAuth provider → token 存放指引 → 凭据文件/内存层);401 强刷对应登录篇 5.3 的 refreshAccessToken。

4.3 `generate`(generate.ts:87,kosong 的通用流消费循环)负责把适配器的流式片段拼成完整的 assistant 消息、把每个片段经回调推给队列:

```ts
export async function generate(
  provider: ChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerateResult> {
```

4.4 以 openai_responses 协议为例,适配器的 `generate`(openai-responses.ts:1096)先建客户端(:1133):

```ts
      const client = this._createClient(options?.auth);
```

`_createClient`(:1205)→ `_buildClient`(:1214-1227)—— 凭据在这变成 OpenAI 客户端的 apiKey:

```ts
  private _buildClient(apiKey: string, auth?: ProviderRequestAuth): OpenAI {
    const clientOpts: Record<string, unknown> = {
      apiKey,
      baseURL: this._baseUrl,
    };
    const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, auth?.headers);
    if (defaultHeaders !== undefined) {
      clientOpts['defaultHeaders'] = defaultHeaders;
    }
    ...
    return new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
  }
```

注意两点:这里**没有传 maxRetries,也没有传 timeout** —— OpenAI SDK 用自己的默认值(超时 10 分钟、SDK 内自动重试 2 次);真正写出 `Authorization: Bearer <apiKey>` 头的是 openai 这个 npm 包(和登录篇 5.4 的结论一致)。默认头里会带上 token 存放指引渲染出的自定义头(如 `apiKey: {token}` 模板那套,登录篇 2.2/6.1)。

4.5 请求发出(:1166):

```ts
      ).create(createParams, options?.signal ? { signal: options.signal } : undefined);
      return new OpenAIResponsesStreamedMessage(response, this._stream);
```

实际 HTTP 是 `POST {baseURL}/responses`。kimi 协议(type='kimi')走 kosong/src/providers/kimi.ts 的同名结构 —— 登录篇 5.4 贴过它的 `_createClient`,token 同样作为 apiKey 进 OpenAI 客户端。

### 第 5 步:失败与重试

文件:packages/kosong/src/providers/openai-common.ts、packages/agent-core-v2/src/agent/stepRetry/stepRetryService.ts、packages/agent-core-v2/src/_base/utils/retry.ts

5.1 适配器抛出的 OpenAI 系错误先经 `convertOpenAIError`(openai-common.ts:121 起)归一化 —— 第一件事是中止守卫(用户取消绝不会被当成可重试失败):

```ts
export function convertOpenAIError(
  error: unknown,
  convertErrorHook?: (error: unknown) => ChatProviderError | undefined,
): ChatProviderError {
  // Abort guard FIRST: throws (never returns) the standard abort DOMException
  // for any abort shape, so that a user cancellation is never misclassified as a
  // retryable provider failure.
  throwIfAbortError(error);
```

超时映射成 APITimeoutError,HTTP 错误体里的文本原样保留(网关返回什么提示,用户就看到什么)。

5.2 引擎这一侧的兜底是 `recover`(stepRetryService.ts:110-145)—— 这就是日志里 `provider retry 3/10 in 1233.22ms` 的全部来源:

```ts
  private async recover(context: LoopErrorContext): Promise<boolean> {
    ...
    this.failedAttempts += 1;

    const maxAttempts = Math.max(
      this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      1,
    );
    if (this.failedAttempts >= maxAttempts) {
      this.resetAttempts();
      return false;
    }

    const error = unwrapErrorCause(context.error);
    const delayMs =
      readRetryAfterMs(error) ?? retryBackoffDelays(maxAttempts)[this.failedAttempts - 1] ?? 0;
    void this.dispatcher.dispatch(
      new TurnStepRetrying({
        ...
        failedAttempt: this.failedAttempts,
        nextAttempt: this.failedAttempts + 1,
        maxAttempts,
        delayMs,
        ...
      }),
    );
```

三个数字的出处:

- **10**(最多重试次数):retry.ts:3 `DEFAULT_MAX_RETRY_ATTEMPTS = 10`,可被 loopControl.maxAttemptsPerStep 覆盖;

- **1233.22ms**(等待时长):服务器响应头带 Retry-After 就用它;否则查退避表(retry.ts:16-18)—— `500ms × 2ⁿ`(封顶 32 秒)再乘一个 0~25% 的随机上浮,第 2 次(n=1)约 1000~1250ms,你看到的 1233 就落在这一档:

```ts
export function retryBackoffDelay(attemptIndex: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, attemptIndex), MAX_DELAY_MS);
  return base + Math.random() * JITTER_FACTOR * base;
}
```

- **3/10**(第几次/共几次):`failedAttempt / maxAttempts` 字段,随 TurnStepRetrying 事件广播出去(它也走第 6 步的回流,所以 webview 能显示重试提示)。

### 第 6 步:回流 —— 从引擎事件到逐 token 渲染

文件:apps/vscode/src/runtime/session-runtime.ts、apps/vscode/webview-ui/src/App.tsx、apps/vscode/webview-ui/src/stores/chat.store.ts

6.1 会话建立时就订阅了引擎事件(session-runtime.ts:107,在 SessionRuntime 的构造接线里):

```ts
    this.unsubscribe = this.session.onEvent((event) => this.onSdkEvent(event));
```

6.2 `onSdkEvent`(:440 起)把引擎事件投影成 UI 事件(附带处理压缩完成等挂起事项),流式片段最终汇入 `emitStreamEvent`(:582-585)—— 对**每个**挂在这个会话上的 webview 各广播一份:

```ts
  private emitStreamEvent(event: UIStreamEvent | { type: string; payload: unknown }): void {
    for (const webviewId of this.webviewIds) {
      this.broadcast(Events.StreamEvent, event, webviewId);
    }
  }
```

6.3 webview 侧的接入口在 App.tsx:23-31 —— 先按会话 id 过滤(多会话/旧会话的串音丢弃),再交给 store:

```ts
    return bridge.on(Events.StreamEvent, (event: UIStreamEvent) => {
      // 只有当前已有 session 时才过滤,确保 session_start 能正常处理
      if (sessionId && "_sessionId" in event && event._sessionId && event._sessionId !== sessionId) {
        console.log("Ignored stream event from another session:", event._sessionId);
        return;
      }
      processEvent(event);
```

6.4 `processEvent`(chat.store.ts:251)按事件类型更新消息列表 —— 每个 token 片段到达就追加渲染;第一个事件到达时握手标记置位(第 1 步 1.3 的 30 秒定时器由此解除)。至此,你按下回车的那条消息走完了从输入框到界面的整条环路。

---

## 与既有笔记(flow.md)的出入修正

本文按当前源码重核了 flow.md 的全部站点,以下几处与它不同,以本文为准:

| 项 | flow.md 写的 | 实测(本文) |
|---|---|---|
| webview sendMessage / 发送函数 | chat.store.ts:191 | store 的 sendMessage 在 :199,实际干活的 doSend 在 :143 |
| kosong generate 函数 | generate.ts:31 | :87(:31 在类型声明区) |
| openai-responses 关键行 | generate :1064 / _createClient :1176 / _buildClient :1185 | :1096 / :1205 / :1214(整体漂了约 20 行) |
| SDK 内重试 | `maxRetries: 0`,SDK 内重试关闭 | `_buildClient` 不传 maxRetries —— OpenAI SDK 默认自己重试 2 次,叠加引擎层 10 次 |
| 抖动 | ±25% | +0~25%(`base + rand × 0.25 × base`,只往上浮) |
| 漏掉的机制 | — | 30 秒握手超时(abortChat)、autosave 预检、宿主斜杠命令分支、emitStreamEvent 按多 webview 各发一份、App.tsx 的会话过滤 |

## 设计复盘

- **模型级字段永远第一优先,provider 段只是回退**(baseUrl 三级、protocol 三级、凭据四级)。反例是真实事故:某台机器 provider 段 baseUrl 运行时为空,解析链落到内置端点表的 `defaultBaseUrl = https://api.openai.com/v1`,于是带着 Okta token 去打 OpenAI 官方,表现为反复 "Request time out"。修复就是把 baseUrl 写到模型级(modelAuth.ts:190 直接命中)—— 和 protocol 是同一个教训:引擎解析链里,provider 段的缺失会被"好心地"兜到厂商默认地址。

- **RPC 立即返回,过程全走广播**(2.9):`{done:true}` 只表示"消息递进引擎了",token、错误、重试提示全是事件。反例:若 RPC 等整轮完成才返回,一次长回答会把 RPC 通道占死,也无法中途广播。

- **双层重试各管一段**(5.1/5.2 + 4.4):SDK 内 2 次管网络抖动(快速、无事件),引擎层 10 次管真正的失败(带退避、带 TurnStepRetrying 事件,界面可见)。runWithAuthRefresh 再单独管 401(强刷凭据重试一次)。

- **解析结果按模型缓存**(3.3):profileService:443 和 llmRequesterService:656 复用同一个 CatalogEntry,整条 provider/protocol/auth 解析链每模型只跑一次。反例:每步都重新解析,同一轮对话十次请求就解析十次。

- **30 秒握手定时器是最后一道保险**(1.3):引擎侧任何环节卡死,webview 也会在 30 秒后自动 abortChat 并报错,不会永远转圈。

## 下一步

- 登录与 token 的来路(凭据文件、内存层注入、每请求取 token)在 [kimi-login-flow.md](kimi-login-flow.md);
- 工具调用回合、审批(reverseRpc)如何嵌进这条链,值得单独一篇。
