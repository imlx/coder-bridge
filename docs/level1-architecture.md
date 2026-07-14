# Level 1 架构文档 - 一次性执行（One-shot Dispatch）

## 1. 功能验证总结

**已验证通过。** MOSS 通过 `exec_command` 调用 `claude -p` 和 `codex exec`，两个 AI 各自独立完成一次性编码任务，产出真实代码文件。

- Claude Code：`claude -p "prompt" --output-format text` → 产出 `scratch/claude-output.js`
- Codex：`codex exec "prompt" -s workspace-write` → 产出 `scratch/codex-output.js`
- 验证标准：文件存在 + 包含正确的 ESM export 语法
- Demo：`npm run demo:1`

---

## 2. 调度决策机制

### 2.1 核心理念

MOSS 的调度决策不是"在 Claude Code 和 Codex 之间选哪个"，而是**MOSS 是否清楚知道自己有哪些能力扩展，并在合适的场景主动调用**。

类比：Claude Code 知道自己有 Edit / Read / Bash 等工具，遇到需要编辑文件的场景就自动调用 Edit，不需要用户告诉它"用 Edit 工具"。MOSS 对 agent 的调度应该达到同样的自主程度--遇到编码任务时，MOSS 意识到"我有 Claude Code 这个强大的编程工具可以调度"，然后主动组装 prompt 并调用。

### 2.2 MOSS 能力注册表（Level 1 范围）

MOSS 应维护一个能力注册表，Level 1 对应的条目：

| 能力 | 触发场景 | 调用方式 | 预期产出 |
|------|---------|---------|---------|
| 一次性编码（Claude Code） | 单文件创建、简单函数实现、格式化脚本生成 | `claude -p "prompt" --output-format text` | 代码文件 |
| 一次性编码（Codex） | 同上，作为多工具适配层 | `codex exec "prompt" -s workspace-write` | 代码文件 |

### 2.3 何时选择 One-shot Dispatch

One-shot 是最粗粒度的调度方式。MOSS 应在以下场景选择它：

- **任务边界清晰**："创建一个 X 函数"、"生成一个 Y 配置文件"，一轮就能完成
- **不需要上下文延续**：任务独立，不依赖前序对话
- **不需要实时观察**：派出去等结果就行，不需要看 thinking / tool_use 过程
- **不需要 MOSS 的记忆/MCP 能力**：纯编码任务，不需要 agent 查询 MOSS 的上下文

**不该用 One-shot 的场景**：
- 需要多轮迭代（→ Level 2 流式多轮）
- 需要 agent 访问 MOSS 的记忆或能力（→ Level 3 MCP）
- 需要跨时间追踪进度（→ Level 4 后台持久化）
- 需要拦截/审查工具调用（→ Level 5 Hook + Agent）

### 2.4 当前 Demo 的局限

当前 demo-level1.js 中的调度是**硬编码的**--代码里写死了 `spawn claude` 和 `spawn codex`。这不是 MOSS 自主决策，而是脚本预设的流程。

**真正的调度决策发生在 MOSS 层（AI agent 本身），不在 demo 脚本里。** Demo 脚本验证的是"调度链路通不通"（技术可行性），MOSS 自主决策验证的是"MOSS 知不知道自己有这个能力、会不会主动用"（认知能力）。后者需要在 MOSS 的实际运行中验证，不在 demo 脚本范围内。

### 2.5 多工具适配

当前同时验证 Claude Code 和 Codex 是为了结构化抽象。生产环境中：
- **以 Claude Code 为主**：五层能力最完整，Level 1-5 全覆盖
- **Codex 为可选适配层**：当 Claude Code 不可用、或任务更适合 Codex 时切换
- MOSS 的能力注册表应支持运行时动态注册多个同类工具，按可用性和适配度选择

---

## 3. 服务生命周期

### 3.1 CLI 安装与配置

```
# 前置：Node.js 22 (nvm)
nvm install 22 && nvm use 22

# Claude Code
npm install -g @anthropic-ai/claude-code
claude --version  # 验证

# Codex CLI
npm install -g @openai/codex
codex --version  # 验证
```

**PATH 问题**：在 BaiLongma sandbox 环境中，node/npx/claude/codex 不在默认 PATH。所有命令前需加：
```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null 2>&1
```

demo 脚本通过 `NVM_INIT` 常量统一处理。

### 3.2 单次 Dispatch 生命周期

```
MOSS 识别任务 → 组装 prompt → spawn CLI 进程 → CLI 执行（最长 90s）
    → exit 0：读取产出文件 → 验证格式 → 报告成功
    → exit ≠ 0 或超时：报告失败 → （可选）重试或换工具
    → 进程结束，无残留
```

**关键特征**：
- 每次 dispatch 是独立进程，结束即销毁
- 无 session 持久化、无上下文延续
- 90 秒超时（`DISPATCH_TIMEOUT`），超时自动 kill

### 3.3 Scratch 目录管理

- 位置：`/Volumes/T7/coder-bridge/scratch/`
- 创建：demo 启动时自动创建
- 清理：每次 demo 运行前自动清理上次的产出（`rmSync` 递归删除）
- 保留：demo 运行后保留，供人工检查，下次运行时自动清理
- **不需要手动管理** - demo 脚本全自动化

### 3.4 进程管理

- dispatch 使用 `child_process.spawn`，stdio 为 `['ignore', 'pipe', 'pipe']`
- stdin 设为 ignore，避免 codex exec 卡在等待输入
- 超时通过 `setTimeout` + `SIGTERM` 实现
- demo 退出码：两个 dispatch 都通过 → exit 0，否则 exit 1

---

## 4. 架构演进建议

### 4.1 短期（当前 Level 可立即改进）

1. **并行 Dispatch**：当前两个任务串行执行（Claude Code 完了才跑 Codex）。对于独立任务应并行 dispatch，总耗时从 ~50s 降到 ~35s。实现方式：`Promise.all([dispatchClaude(), dispatchCodex()])`

2. **错误重试**：当前 dispatch 失败直接报告，无重试。应加一层：失败 → 等待 3s → 重试一次 → 仍失败才报告。AI 响应有波动，单次失败不一定是真错误。

3. **成本控制**：Claude Code 支持 `--max-budget-usd` 参数限制单次花费。生产环境应默认设置预算上限。

### 4.2 中期（跨 Level 集成）

4. **能力注册表实例化**：将 2.2 节的注册表从文档概念变为 MOSS 运行时的数据结构。MOSS 启动时扫描可用的 agent CLI，动态构建能力注册表。能力注册表应包含：
   - 工具名称和版本
   - 支持的调度级别（one-shot / streaming / mcp / background / hook）
   - 当前可用性（CLI 是否安装、是否可达）
   - 历史调用统计（成功率、平均耗时、平均成本）

5. **调度决策引擎**：MOSS 收到任务时，查询能力注册表，根据任务特征（复杂度、是否需要上下文、是否需要记忆）自动选择调度级别和工具。这个决策对用户透明--用户只说"帮我写个函数"，MOSS 自己决定用 one-shot 还是 streaming。

### 4.3 长期（MOSS 系统级）

6. **Agent 池管理**：多个 agent 实例并发运行，MOSS 做负载均衡。类似数据库连接池--预热几个 agent session，任务来了直接派给空闲的。

7. **能力自省**：MOSS 定期检查 agent 的能力变化（新版本支持新参数、新工具），自动更新能力注册表。类似 Claude Code 启动时自动发现可用的 MCP server。

8. **成本仪表盘**：跨所有 Level 的 agent 调用成本汇总，按任务类型、agent、时间段统计，帮助 MOSS 做成本最优的调度决策。

---

## 5. 与其他 Level 的关系

| 维度 | Level 1 (One-shot) | Level 2 (Streaming) | Level 3 (MCP) |
|------|-------------------|--------------------| ------------|
| 通信方向 | MOSS → Agent（单向） | MOSS ↔ Agent（双向流式） | MOSS ↔ Agent（双向，通过 MCP 协议） |
| 上下文 | 无（每次独立） | 有（session 内多轮保持） | 有（MCP server 持久化） |
| 适用场景 | 简单、独立、单次任务 | 复杂、迭代、需要观察过程 | 需要 agent 访问 MOSS 能力 |
| 成本 | 最低 | 中等 | 取决于 MCP 调用频率 |
| 持久化 | 无 | session 内存 | MCP server 进程级 |

Level 1 是基础层--验证了 MOSS 能调通 agent CLI。后续 Level 在此基础上加深控制粒度，但调度链路本身（MOSS → CLI → 产出）是共通的。
