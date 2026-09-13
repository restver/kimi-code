# 工具调用回合与审批(反向 RPC):模型要动手时发生了什么(白话版)

> 时效基线:2026-09-05,okta_login 分支(HEAD 3de05910c);文中行号当日逐文件核对。
> 实测基线:apps/vscode `npx vitest run` 373/376 通过(3 个失败为引擎集成测试既有超时,与本文链路无关)。

先一句话说清整件事:发消息的链路(见 [send-message-flow.md](send-message-flow.md))是"正向"的 —— 你推一下,引擎跑一步。但模型决定调用工具(改文件、跑命令)时,出现了一条**反向**通路:引擎中途停下来,把"我可以执行吗?"推回给界面,挂着等你点按钮;你的回答再沿原路返回,把挂着的 Promise 唤醒,引擎才继续。这条反向通路就是本文;工具调用本身也在这里 —— 因为审批就发生在"工具即将执行"的那一瞬间。

## 全景图

```
【引擎·回合循环】loopService.ts:978 模型响应带 toolCalls
   └→ toolExecutor.execute(:978);每个调用先记 'tool.call'(:995),执行完记 'tool.result'(:1002)
        └→ finishReason='tool_calls'(:1006)→ 回到下一次模型请求(send-message-flow 第 3 步)
【引擎·权限闸门】permissionGateService.ts:30 监听 toolExecutor 的 onBeforeExecuteTool
   └→ :44 adjudicate:policyService.evaluate → 结果分四种
        ├→ 'approve' → event.pass(:54)放行
        ├→ 'deny'/'result' → veto(:58 resolvePermissionResolution)
        └→ 'ask' ★ → event.waitUntil(requestToolApproval)(:52)
【引擎·审批挂起】toolApprovalService.ts:103 requestToolApproval
   └→ :141-143 await approvalService.request(...)   ← 引擎在这里停下等待
        └→ session/approval/approvalService.ts:25 requestSessionInteraction
             └→ interactionService.ts:220 request:把 Promise 挂进 pending 表
【SDK 桥·推拉转换】v2/session-wiring.ts:119 监听"pending 变化"
   └→ :195 bridgeApproval:调 sink.requestApproval(即 rpc.ts:1151)
        └→ rpc.ts:1153 查 approvalHandlers.get(sessionId) ← 宿主注册的 handler
【宿主】session-runtime.ts:105 setApprovalHandler(构造时注册)
   └→ reverse-rpc.ts:22 requestApproval:再挂一个 Promise,广播 ApprovalRequest 事件
        └→ session-runtime.ts:582 emitStreamEvent → Events.StreamEvent 广播给 webview
【webview】event-handlers.ts:507 ApprovalRequest → approval.store.ts:26 入队
   └→ ApprovalDialog.tsx:8 渲染对话框(Yes / Yes, for this session / No)
        └→ 你点按钮 → bridge.ts:218 respondApproval(正向 RPC,Methods.RespondApproval)
【宿主·回程】chat.handler.ts:156 respondApproval → session-runtime.ts:388
   └→ reverse-rpc.ts:51 respondApproval:按回答 resolve 那个 Promise
        └→ 引擎侧同理逐层 decide/respond 唤醒(interactionService.ts:230 respond)
             └→ 工具执行/拒绝 → 结果回模型 → 回合继续
```

---

### 第 1 步:引擎的回合循环 —— 工具调用夹在两次模型请求之间

文件:packages/agent-core-v2/src/agent/loop/loopService.ts

1.1 发消息链路(send-message-flow 第 3 步)拿到模型响应后,如果里面带着工具调用,进入工具执行(loopService.ts:971-1006)。没有工具调用就直接结束本轮:

```ts
    if (response.message.toolCalls.length === 0) {
      return finishReason === 'tool_calls' ? 'other' : finishReason;
    }
```

1.2 有工具调用就逐个执行(:978 `this.toolExecutor.execute(...)`),每个调用先记一条 `tool.call` 事件(连同参数),执行完记 `tool.result`:

```ts
    for await (const toolResult of this.toolExecutor.execute(response.message.toolCalls, {
      signal, turnId, trace,
      onToolCall: ({ toolCallId, name, args }) => {
        ...
        this.context.appendLoopEvent({
          type: 'tool.call',
          ...
          toolCallId, name, args, extras,
        });
      },
    })) {
      const { result } = toolResult;
      this.context.appendLoopEvent({
        type: 'tool.result',
        ...
        result: { output: result.output, isError: result.isError, note: result.note },
      });
```

1.3 执行完把 finishReason 置回 `tool_calls`(:1006),循环回到下一次模型请求 —— **回合的本质:模型请求 → 工具执行 → 再请求,直到模型不再要工具**:

```ts
    finishReason = stopTurn ? 'completed' : 'tool_calls';
    return finishReason;
```

工具执行前的一瞬间,权限闸门介入 → 第 2 步。

### 第 2 步:权限闸门 —— 每个工具执行前先问"让不让"

文件:packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts

2.1 闸门在构造时挂上工具执行器的前置钩子(:30):

```ts
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.adjudicate(event)));
```

2.2 `adjudicate`(:39-62)拿策略评估结果分四种处置 —— 这就是"要不要弹审批框"的决策点:

```ts
  private async adjudicate(event: BeforeToolExecuteEvent): Promise<void> {
    const evaluation = await this.policyService.evaluate(event);
    if (evaluation === undefined) return;
    ...
    const { result, policyName } = evaluation;
    if (result.kind === 'ask') {
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, result, policyName));
      return;
    }
    if (result.kind === 'approve') {
      event.pass(result.executionMetadata);
      return;
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(result, event, policyName);
    if (resolved?.veto !== undefined) {
      event.veto(resolved.veto);
    }
  }
```

- `approve`:直接放行(比如 yolo 模式下大部分工具);

- `deny`:直接否决,工具不执行,模型会收到"被权限策略拒绝"的结果(toolApprovalService.ts:92);

- `ask`:**挂起工具执行**,进入第 3 步的审批;

- `result`:策略直接给出一个工具结果(不执行)。

权限模式从哪来:宿主建会话时传的(kimi-runtime.ts:114-124 的 `permission: corePermissionForLegacyApproval(defaultApproval)`),映射规则在 legacy-approval.ts:56-60 —— afk → `'auto'`,yolo → `'yolo'`,否则 `'manual'`:

```ts
export function corePermissionForLegacyApproval(flags: LegacyApprovalFlags): PermissionMode {
  if (flags.afk) return "auto";
  return flags.yolo ? "yolo" : "manual";
}
```

所以 TUI 里切 /yolo、/auto 本质上是换模式,让策略评估大多落在 `approve`,审批框就不再出现。

### 第 3 步:引擎侧挂起 —— 审批是一个停在半路的 Promise

文件:packages/agent-core-v2/src/agent/toolApproval/toolApprovalService.ts、.../session/approval/approvalService.ts、.../features/interaction/interactionService.ts

3.1 `requestToolApproval`(:103 起)拼出审批请求(id、会话/agent/turn、工具名、动作、展示块),广播 `PermissionApprovalRequested` 事件,然后**await 一个不会自己醒来的 Promise**(:141-143)—— 引擎的这一步工具就停在这里:

```ts
    let response: ApprovalResponse;
    const approvalService = this.tryApprovalService();
    if (approvalService === undefined) {
      response = { decision: 'approved' };
    } else {
      void this.dispatcher.dispatch(new PermissionApprovalRequested(approvalContext));
      try {
        response = await abortable(
          approvalService.request(approvalRequest),
          context.signal,
        );
        context.signal.throwIfAborted();
```

(没有审批服务时自动批准 —— 引擎可以无界面运行。)

3.2 `approvalService.request`(session/approval/approvalService.ts:25-30)把请求递进会话交互内核:

```ts
  request(req: ApprovalRequest): Promise<ApprovalResponse> {
    return requestSessionInteraction<ApprovalRequest, ApprovalResponse>(this.agents, {
      id: requestId(req),
      kind: 'approval',
      payload: req,
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
  }
```

3.3 内核的 `request`(interactionService.ts:220-224)就是"挂起"的实现 —— 建一个 Promise,把 resolve 存进 pending 表,等别人来回调:

```ts
  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      this.park(req, resolve as (response: unknown) => void);
    });
  }
```

挂进表的瞬间,`onDidChangePending` 通知同步发出 —— 谁在听?SDK 的桥 → 第 4 步。

### 第 4 步:SDK 桥 —— 把"pull 内核"翻译回"push 回调"

文件:packages/node-sdk/src/v2/session-wiring.ts、packages/node-sdk/src/rpc.ts

4.1 v1 时代的引擎是"推":直接调客户端回调。v2 内核是"拉":挂起等响应。桥负责翻译 —— 监听 pending 变化,把每个新挂起的审批喂给老通道(session-wiring.ts:119-124):

```ts
      onSessionInteractionDidChangePending(manager, () => {
        this.bridgeNewPendingInteractions();
      }),
```

4.2 `bridgeApproval`(:195-218)调 `sink.requestApproval`(sink 就是 SDK 客户端自己),拿到回答后写回内核:

```ts
  private async bridgeApproval(interaction: Interaction): Promise<void> {
    const payload = interaction.payload as ApprovalInteractionPayload;
    try {
      const response = await this.sink.requestApproval({
        turnId: payload.turnId,
        toolCallId: payload.toolCallId ?? interaction.id,
        toolName: payload.toolName,
        action: payload.action,
        display: payload.display,
        sessionId: this.session.id,
        agentId: payload.agentId ?? interaction.origin.agentId ?? MAIN_AGENT_ID,
      });
      this.session.accessor.get(ISessionApprovalService).decide(interaction.id, response);
```

4.3 `sink.requestApproval` 落到 rpc.ts:1151-1161:查宿主注册的 handler —— 没注册就返回 `cancelled`(会话没界面时不会卡死):

```ts
  async requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    const handler = this.approvalHandlers.get(request.sessionId);
    if (handler === undefined) {
      return {
        decision: 'cancelled',
```

handler 是宿主在会话建立时注册的(session.setApprovalHandler,session.ts:131-133 → rpc.ts:1133 注册进表)→ 第 5 步。

### 第 5 步:宿主 —— ReverseRpcController,第二次挂起

文件:apps/vscode/src/runtime/session-runtime.ts、apps/vscode/src/runtime/reverse-rpc.ts

5.1 SessionRuntime 构造时做两件事(:99-106):造 ReverseRpcController(emit 直通 emitStreamEvent),把它的两个方法注册成 SDK 的审批/提问 handler:

```ts
    this.reverseRpc = new ReverseRpcController((event) => this.emitStreamEvent(event));
    ...
    this.session.setApprovalHandler((request) => this.reverseRpc.requestApproval(request));
    this.session.setQuestionHandler((request) => this.reverseRpc.requestQuestion(request));
```

5.2 `requestApproval`(reverse-rpc.ts:22-29)是第二次挂起:引擎挂着的 Promise 之上,这里再挂一个,把请求广播出去:

```ts
  requestApproval(request: ApprovalRequest): Promise<CoreApprovalResponse> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.approvals.set(id, resolve);
      this.emit({ type: "ApprovalRequest", payload: approvalPayload(id, request) });
    });
  }
```

`approvalPayload`(reverse-rpc.ts:89-97)把请求转成界面要的形状:

```ts
function approvalPayload(id: string, request: ApprovalRequest) {
  return {
    id,
    tool_call_id: request.toolCallId,
    sender: request.toolName,
    action: request.action,
    description: describeToolDisplay(request.display),
    display: toLegacyDisplay(request.display),
  };
}
```

5.3 emit 直通 emitStreamEvent(发送篇第 6 步贴过,session-runtime.ts:582-585)—— 审批请求和 token 流走**同一条广播通道**,对每个挂着的 webview 各发一份。

5.4 中止时全部作废(:336,cancel 路径):挂着的审批按 cancelled 结算、提问返回 null —— 你点"停止"不会让某个 Promise 永远悬着:

```ts
    this.reverseRpc.cancelAll("Turn cancelled");
```

(cancelAll 的实现,reverse-rpc.ts:77-86:)

```ts
  cancelAll(reason: string): void {
    for (const resolve of this.approvals.values()) {
      resolve({ decision: 'cancelled', feedback: reason });
    }
    for (const resolve of this.questions.values()) {
      resolve(null);
    }
    this.approvals.clear();
    this.questions.clear();
  }
```

### 第 6 步:webview —— 对话框与三个按钮

文件:apps/vscode/webview-ui/src/stores/event-handlers.ts、.../stores/approval.store.ts、.../components/ApprovalDialog.tsx、.../services/bridge.ts

6.1 广播事件到达,`ApprovalRequest` 处理器(event-handlers.ts:507-516)把它塞进审批队列:

```ts
  ApprovalRequest: (_, payload: ApprovalRequestPayload) => {
    useApprovalStore.getState().addRequest({
      id: payload.id,
      tool_call_id: payload.tool_call_id,
      sender: payload.sender,
      action: payload.action,
      description: payload.description,
      display: payload.display ?? [],
    });
  },
```

(提问 `QuestionRequest` 类似,:518-520,存进 draft.pendingQuestion。)

6.2 队列(approval.store.ts:26-34)就四个操作:入队、出队、回应、清空 —— 回应是发一条正向 RPC 然后出队:

```ts
  respondToRequest: async (id, response) => {
    await bridge.respondApproval(id, response);
    get().removeRequest(id);
  },
```

6.3 `ApprovalDialog`(ApprovalDialog.tsx:8-37)渲染队首请求;有 diff 块自动展开;三个按钮:

```ts
  const options = [
    { key: "approve", label: "Yes", index: 1 },
    { key: "approve_for_session", label: "Yes, for this session", index: 2 },
    { key: "reject", label: "No", index: 3 },
  ] as const;
```

6.4 `bridge.respondApproval`(bridge.ts:218-220)是一条普通正向 RPC(和 streamChat 同一张 handlers 表,消息名 `respondApproval`):

```ts
  respondApproval(requestId: string, response: ApprovalResponse) {
    return this.call<{ ok: boolean }>(Methods.RespondApproval, { requestId, response });
  }
```

### 第 7 步:回程 —— 两层 Promise 逐个醒来

文件:apps/vscode/src/handlers/chat.handler.ts、apps/vscode/src/runtime/session-runtime.ts、apps/vscode/src/runtime/reverse-rpc.ts、packages/agent-core-v2/src/features/interaction/interactionService.ts

7.1 宿主 handler(chat.handler.ts:156-158,登记在 :190)按 webview 找到会话,转交:

```ts
const respondApproval: Handler<RespondApprovalParams, { ok: boolean }> = async (params, ctx) => {
  return { ok: ctx.getSession()?.respondApproval(params.requestId, params.response) ?? false };
};
```

7.2 SessionRuntime(session-runtime.ts:388-390)直通 reverseRpc;`respondApproval`(reverse-rpc.ts:51-63)按你的按钮翻译成引擎的回答并 resolve **第二层** Promise:

```ts
  respondApproval(id: string, response: ApprovalResponse): boolean {
    const resolve = this.approvals.get(id);
    if (!resolve) return false;
    this.approvals.delete(id);
    if (response === "approve_for_session") {
      resolve({ decision: "approved", scope: "session" });
    } else if (response === "approve") {
      resolve({ decision: "approved" });
    } else {
      resolve({ decision: "rejected" });
    }
    return true;
  }
```

(id 查不到返回 false —— 迟到的回答安全作废。)

7.3 这个 resolve 的返回值沿 SDK 桥回到内核(第 4 步 4.2 的 `decide`),内核 `respond`(interactionService.ts:230-242)唤醒**第一层** Promise:

```ts
  respond(id: string, response: unknown): boolean {
    const entry = this.effects.pending.get(id);
    if (entry === undefined) return false;
    this.effects.pending.delete(id);
    rememberResolved(this.effects, id);
    entry.resolve(response);
    ...
```

7.4 引擎的第 3 步 await 醒来:批准 → 工具执行(回到第 1 步的 toolExecutor,结果记 `tool.result`,回合继续);拒绝 → 模型收到拒绝结果。选了 "Yes, for this session" 的额外动作(toolApprovalService.ts:175-182):把这条批准记成会话级规则,本会话内同类调用不再问:

```ts
    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;
    ...
    this.rulesService.recordApprovalResult({
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
```

---

## 设计复盘

- **审批 = 两层挂起的 Promise,复用两条既有通道**:引擎层挂在交互内核(拉),宿主层挂在 ReverseRpcController(推);中间由 SDK 桥做推拉翻译;事件走广播、回答走正向 RPC —— 没有为审批新建任何传输机制。反例:若引擎直连 UI,无界面运行(测试、kap-server)就得 mock 整条 UI 链。

- **迟到的回答天然安全**:两层 respond 都对未知 id 返回 false / no-op(7.2、session-wiring.ts 注释明说 "the kernel's respond no-ops on an id that is no longer pending"),加上中止时 cancelAll 兜底(5.4)—— 你点了"停止"之后才点的按钮不会唤醒任何东西。

- **"本会话不再问"是一条规则,不是缓存标志**(7.4):recordApprovalResult 把会话级批准写进规则服务,下次权限评估(第 2 步)直接落 `approve`,不走审批。反例:如果是"记住已批准的工具名"式缓存,同类不同参数的调用(比如改了别的文件)也会被放行。

- **权限模式决定弹不弹框**(2.2 的映射):yolo/auto 让评估大多放行,manual 多数落 `ask` —— 界面上的 /yolo、/auto 开关本质上只是换模式,策略评估这一层照走。两处兜底要分清:引擎里没有审批服务时自动批准(3.1,无界面运行);宿主没注册 handler 时 rpc 层返回 cancelled 而非默认放行(4.3)。

- **工具回合是循环不是分支**(1.3):finishReason='tool_calls' 让 loop 回到下一次模型请求 —— 模型的"多步干活"就是这个循环的多次运转,每一步的权限闸门都独立生效。

## 下一步

- 发消息的正向链路见 [send-message-flow.md](send-message-flow.md);登录与 token 见 [kimi-login-flow.md](kimi-login-flow.md);
- 提问(ask-user 工具)与审批同构(第 5 步 5.1 的另一行注册),差别只在 webview 存放位置(pendingQuestion)与回答回调,本文不重复展开。
