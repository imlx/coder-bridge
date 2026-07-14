# Level 3 架构文档 - MCP 双向互操作（Bidirectional MCP Interop）

## 1. 功能验证总结

**已验证通过（3/3 PASS）。** MOSS 与 Claude Code 之间建立了完整的双向 MCP 互操作关系：方向 A（MOSS 作为 MCP server，Claude Code 消费）和方向 B（Claude Code 作为 MCP server，MOSS 消费）均验证通过。

- Demo 文件：`src/demo-level3.js`（587 行，3-Part 结构）
- 运行命令：`npm run demo:3`
- 总耗时：30.9s

| Part | 验证内容 | 方向 | 耗时 | 结果 |
|------|---------|------|------|------|
| Part 1 | 直接 JSON-RPC 协议测试 mcp-memory-server | MOSS ↔ mcp-memory-server | 0.6s | ✅ PASS |
| Part 2 | Claude Code 通过 --mcp-config 消费 MOSS MCP | Claude Code → MOSS | 27.7s | ✅ PASS |
| Part 3 | MOSS 消费 claude mcp serve | MOSS → Claude Code | 2.5s | ✅ PASS |

**重构说明：** 原 demo 含 4 个 Part（Part 3/4 为 Codex 相关）。因 Codex 注册 MCP server 后无法发现工具的已知问题，且本次验证聚焦 Claude Code，已移除 Codex 部分，新增 Part 3（MOSS 消费 claude mcp serve）补全双向关系。

## 2. 完整双向 MCP 关系

### 2.1 核心理念

MCP（Model Context Protocol）是 Agent 间能力交换的标准协议。Level 3 验证的不是"MOSS 能不能调 MCP"这一单向事实，而是**双向互操作**--MOSS 既能暴露自身能力供其他 Agent 消费，也能消费其他 Agent 暴露的能力。

这与 MOSS 的定位一致：MOSS 是主控大脑，Claude Code 是执行能力扩展。方向 A 让 Claude Code 获得 MOSS 的持久记忆和项目上下文；方向 B 让 MOSS 获得 Claude Code 的完整编码工具链。两者结合 = MOSS 决策 + Claude Code 执行的完整闭环。

### 2.2 方向 A：MOSS 暴露能力，Claude Code 消费

**Part 1 - 直接协议测试：**

MOSS 的 MCP server（`src/mcp-memory-server.js`）通过 stdio JSON-RPC 2.0 暴露 3 个工具：

| 工具 | 功能 |
|------|------|
| `search_memory` | 按关键词搜索 MOSS 记忆库 |
| `get_project_info` | 返回当前项目元信息 |
| `list_capabilities` | 列出 MOSS 可用能力 |

验证流程：`initialize` → `notifications/initialized` → `tools/list`（确认 3 个工具）→ `tools/call`（调用 `search_memory` 验证返回）。全链路 JSON-RPC 协议正确。

**Part 2 - Claude Code 实际消费：**

Claude Code 通过 `--mcp-config` 参数加载 MOSS MCP server 配置，在编码过程中自动调用 `search_memory` 获取项目上下文。验证 Claude Code 能发现并调用 MOSS 暴露的 MCP 工具，而非仅协议层面通。

```
claude -p "分析 scheduler.js，用 search_memory 查找相关记忆" \
  --mcp-config '{"mcpServers":{"moss-memory":{...}}}'
```

**意义：** Claude Code 不再是无上下文的编码工具--它可以通过 MOSS 的记忆系统获取项目历史、用户偏好、前序工作摘要，做出更精准的编码决策。

### 2.3 方向 B：Claude Code 暴露能力，MOSS 消费

**Part 3 - MOSS 消费 claude mcp serve：**

`claude mcp serve` 是 Claude Code CLI 的原生 MCP server 模式。MOSS 通过 stdio JSON-RPC 消费，验证流程：`initialize` → `notifications/initialized` → `tools/list` → `tools/call`。

- 协议版本：`protocolVersion: 2024-11-05`
- Server 信息：`claude/tengu v2.1.206`
- 暴露工具：**25 个**

| 类别 | 工具 |
|------|------|
| 文件操作 | Read, Write, Edit, NotebookEdit |
| 执行 | Bash |
| 网络 | WebFetch, WebSearch |
| 子 Agent | Agent, TaskOutput, TaskStop, ReportFindings |
| 任务追踪 | TaskCreate, TaskGet, TaskUpdate, TaskList |
| 工作树 | EnterWorktree, ExitWorktree |
| 定时/调度 | CronCreate, CronDelete, CronList, ScheduleWakeup |
| 技能/流程 | Skill, Workflow, SendMessage |
| 工具发现 | ToolSearch |

**意义：** MOSS 通过 MCP 获得 Claude Code 的完整编码能力链--读写文件、执行命令、搜索代码、派子 Agent、管理任务。这不是封装一个 wrapper 调用 `claude -p`，而是通过标准协议直接消费 Claude Code 的原生工具集，每个工具可独立调用、可组合编排。

### 2.4 双向关系全景

```
┌─────────────┐                    ┌──────────────┐
│    MOSS     │  ─── 方向 B ────>  │  Claude Code  │
│  (主控大脑)  │  claude mcp serve  │  (执行扩展)   │
│             │  25 个编码工具      │              │
│             │  <─── 方向 A ────  │              │
│             │  --mcp-config      │              │
│             │  3 个记忆/上下文工具 │              │
└─────────────┘                    └──────────────┘
```

- **方向 A（MOSS → Claude Code）：** MOSS 暴露记忆和项目上下文，Claude Code 消费后获得全局视野。
- **方向 B（Claude Code → MOSS）：** Claude Code 暴露编码工具，MOSS 消费后获得执行能力。
- **闭环：** MOSS 基于记忆和认知决策"做什么" → 通过方向 B 调用 Claude Code 工具"执行" → Claude Code 通过方向 A 获取 MOSS 记忆"理解上下文" → 产出反馈给 MOSS → MOSS 更新记忆。

## 3. MCP 服务生命周期

### 3.1 Demo 中的生命周期（临时性）

| 服务 | 启动方式 | 存活时长 | 销毁方式 |
|------|---------|---------|---------|
| mcp-memory-server.js | `child_process.spawn('node', [path])` | Part 1 + Part 2 期间 | demo 结束自动 kill |
| claude mcp serve | `child_process.spawn('claude', ['mcp', 'serve'])` | Part 3 期间 | demo 结束自动 kill |

Demo 中的 MCP 服务是临时子进程：按需启动、用完即杀。这适合验证协议正确性，但不适合生产环境--每次启动都要重新初始化，无法复用连接，无法跨任务保持状态。

### 3.2 McpClient 通信层

demo 中的 `McpClient` 类封装了 JSON-RPC 2.0 over stdio 通信：

| 方法 | 功能 |
|------|------|
| `initialize()` | 发送 initialize 请求，等待 serverInfo 和 capabilities |
| `notifyInitialized()` | 发送 notifications/initialized，完成握手 |
| `listTools()` | 调用 tools/list，返回工具列表 |
| `callTool(name, args)` | 调用 tools/call，返回工具执行结果 |
| `close()` | 关闭 stdin，杀进程 |

McpClient 是协议无关的--同一套代码消费 mcp-memory-server 和 claude mcp serve，证明 MCP 协议的标准化互操作性。

### 3.3 生产环境生命周期管理（演进方向）

当前 demo 的临时生命周期在生产环境需要升级为持久化管理：

**1. MOSS 作为常驻 MCP server：**
- mcp-memory-server 不应是每次 spawn 的子进程，而应是 MOSS 内置的常驻服务
- Claude Code（或其他 Agent）通过持久连接消费，而非每次任务重建连接
- 生命周期跟随 MOSS 主进程，而非跟随单个任务

**2. claude mcp serve 按需启动：**
- MOSS 需要编码能力时启动 `claude mcp serve`，任务完成后关闭
- 需要进程管理：启动确认、健康检查（心跳）、空闲超时关闭、异常重启
- 连接复用：同一 session 内多个工具调用复用同一 MCP 连接，避免反复握手

**3. 生命周期事件持久化：**
- MCP 服务的启动/停止/崩溃事件写入 MOSS Memory
- 后续任务可查询"上次 claude mcp serve 是否可用、崩溃过几次"，做智能决策
- 成本追踪：记录每次 MCP 调用的 token 消耗和时长

## 4. 架构演进建议

### 4.1 原生能力优先，减少自封装

**现状：** mcp-memory-server.js 是 MOSS 为 demo 专门封装的 MCP server，手动暴露 3 个工具。这是一种 wrapper 思路--为验证目的封装的临时能力。

**演进：** MOSS 应直接将自身已有能力（Memory search/recall/probe、tool use、Agent Skills）通过 MCP 协议暴露，无需额外封装。同理，消费侧应直接使用 `claude mcp serve` 的 25 个原生工具，而非封装 `claude -p` 为自定义工具。

**原则：** MCP 的价值在于标准化互操作。每多一层自封装，就多一层维护成本和协议失配风险。优先使用 Agent 的原生 MCP 能力。

### 4.2 MOSS 系统迭代计划

**短期（集成验证）：**
- 将 mcp-memory-server 的能力集成为 MOSS 内置 MCP 服务，不再 spawn 子进程
- claude mcp serve 的 McpClient 封装为 MOSS 的标准工具（通过 tool use 机制加载）
- 验证 MOSS 在实际编码任务中自动选择 MCP 方向（何时暴露记忆、何时消费编码工具）

**中期（多 Agent 编排）：**
- MOSS 同时消费多个 MCP server（Claude Code + 其他编码 Agent + 外部工具服务）
- MOSS 作为 MCP hub：上游暴露能力给多个 Agent，下游消费多个 Agent 的能力
- 工具路由：MOSS 根据任务特征选择调用哪个 Agent 的哪个 MCP 工具（如"读文件"用 Claude Code 的 Read，"搜索记忆"用自身 Memory）

**长期（系统级）：**
- MCP 服务注册与发现：MOSS 维护可用 MCP 服务目录，自动发现新服务、淘汰失效服务
- MCP 能力协商：连接时自动获取对方的 tools/list，动态更新 MOSS 的可用能力集
- 跨 Agent 协作编排：MOSS 通过 MCP 同时调度多个 Agent，如 Claude Code 写代码 + 另一个 Agent 做审查，MOSS 编排协作流程

### 4.3 验证标准复盘

本次 Level 3 验证满足双重标准：

1. **功能性验证：** 3/3 PASS，双向 MCP 关系完整（方向 A + 方向 B），协议全链路正确（initialize → tools/list → tools/call）。
2. **系统演进方向：** 本文档给出了 MCP 服务生命周期管理方案、原生能力优先原则、短/中/长期迭代计划。不停在"跑通了"。

### 4.4 已知限制

- **Codex MCP 互操作未验证：** 原 demo 含 Codex 消费 MCP 和 Codex 作为 MCP server 两个 Part，因 Codex 注册 MCP 后无法发现工具的已知问题已移除。如需验证 Codex 方向，需先解决 Codex 的 MCP 工具发现问题。
- **MCP 传输层仅 stdio：** 当前验证仅覆盖 stdio 传输。MCP 协议还支持 SSE（Server-Sent Events）传输，适用于远程 Agent 通信，未在本 demo 验证。
- **单向工具调用：** 当前验证的是"MOSS 调用 Claude Code 工具"和"Claude Code 调用 MOSS 工具"的单次调用。连续多轮工具编排（如 MOSS 依次调用 Read → Edit → Bash 完成一个编码任务）未在本 demo 验证，属于 Level 4/5 的编排能力范畴。
