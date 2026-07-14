# Level 1 架构文档 - 一次性执行（One-shot Dispatch）

## 1. 功能验证总结

**已验证通过。** MOSS 通过 `exec_command` 调用 `claude -p` 和 `codex exec`，两个 AI 各自独立完成一次性编码任务，产出真实代码文件。

- Claude Code：`claude -p "prompt" --output-format text` -> 产出 `scratch/claude-output.js`
- Codex：`codex exec "prompt" -s workspace-write` -> 产出 `scratch/codex-output.js`
- 验证标准：文件存在 + 包含正确的 ESM export 语法
- Demo：`npm run demo:1`

---

## 2. 调度决策机制

### 2.1 核心理念

MOSS 的调度决策不是"在 Claude Code 和 Codex 之间选哪个"，而是**MOSS 是否清楚知道自己有哪些能力扩展，并在合适的场景主动调用**。

类比：Claude Code 知道自己有 Edit / Read / Bash 等工具，遇到需要编辑文件的场景就自动调用 Edit，不需要用户告诉它"用 Edit 工具"。MOSS 对 agent 的调度应该达到同样的自主程度--遇到编码任务时，MOSS 意识到"我有 Claude Code 这个强大的编程工具可以调度"，然后主动组装 prompt 并调用。

### 2.2 MOSS 现有 Agent 能力在 One-shot Dispatch 中的应用

MOSS 本身就是一个完整的 agent，拥有体系化的能力：Tool use（每轮动态加载工具子集、find_tool 按需加载）、Agent Skills（SKILL.md 包按场景加载）、MCP（消费 MCP server + 自身作为 MCP server）、Memory（search/recall/probe 三层）、Cognitive Loop（Think -> Execute -> Observe -> Judge）。

这些现有能力就是「调度决策能力」本身--不需要另建机制。在 Level 1 One-shot Dispatch 场景中，MOSS 的现有能力如何发挥作用：

| MOSS 现有能力 | 在 One-shot Dispatch 中的应用 |
|--------------|----------------------------|
| Tool use / exec_command | 调用 claude -p / codex exec，spawn 进程、管理 stdio、处理超时 |
| Cognitive Loop (Think) | 识别任务类型，判断是否适合 one-shot dispatch（vs 流式/MCP/后台） |
| Cognitive Loop (Execute) | 组装 prompt、选择 CLI 工具、设置参数（--output-format, -s 等） |
| Cognitive Loop (Observe) | 读取 CLI stdout/stderr、检查 exit code、验证产出文件 |
| Cognitive Loop (Judge) | 根据产出质量决定：接受结果 / 重试 / 升级到更细粒度调度 |
| Memory | 记住哪些任务曾用 one-shot 成功完成，积累调度经验 |
| Skills | 加载编码相关 SKILL.md 指令集，指导 prompt 组装和产出验证 |

类比：Claude Code 知道自己有 Edit/Read/Bash，遇到需要编辑文件的场景就自动调用。MOSS 知道自己有 exec_command 能调 claude -p，遇到简单编码任务就主动组装 prompt 并 dispatch。

### 2.3 何时选择 One-shot Dispatch

One-shot 是最粗粒度的调度方式。MOSS 应在以下场景选择它：

- **任务边界清晰**："创建一个 X 函数"、"生成一个 Y 配置文件"，一轮就能完成
- **不需要上下文延续**：任务独立，不依赖前序对话
- **不需要实时观察**：派出去等结果就行，不需要看 thinking / tool_use 过程
- **不需要 MOSS 的记忆/MCP 能力**：纯编码任务，不需要 agent 查询 MOSS 的上下文

**不该用 One-shot 的场景**：
- 需要多轮迭代（-> Level 2 流式多轮）
- 需要 agent 访问 MOSS 的记忆或能力（-> Level 3 MCP）
- 需要跨时间追踪进度（-> Level 4 后台持久化）
- 需要拦截/审查工具调用（-> Level 5 Hook + Agent）

### 2.4 当前 Demo 的局限

当前 demo-level1.js 中的调度是**硬编码的**--代码里写死了 `spawn claude` 和 `spawn codex`。这不是 MOSS 自主决策，而是脚本预设的流程。

**真正的调度决策发生在 MOSS 层（AI agent 本身），不在 demo 脚本里。** Demo 脚本验证的是"调度链路通不通"（技术可行性），MOSS 自主决策验证的是"MOSS 知不知道自己有这个能力、会不会主动用"（认知能力）。后者需要在 MOSS 的实际运行中验证，不在 demo 脚本范围内。

### 2.5 多工具适配

当前同时验证 Claude Code 和 Codex 是为了结构化抽象。生产环境中：
- **以 Claude Code 为主**：五层能力最完整，Level 1-5 全覆盖
- **Codex 为可选适配层**：当 Claude Code 不可用、或任务更适合 Codex 时切换
- MOSS 的 tool use 机制天然支持多工具--exec_command 是通用接口，调 claude -p 和调 codex exec 对 MOSS 来说是同一类操作，只是命令和参数不同

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
MOSS 识别任务 -> 组装 prompt -> spawn CLI 进程 -> CLI 执行（最长 90s）
    -> exit 0：读取产出文件 -> 验证格式 -> 报告成功
    -> exit ≠ 0 或超时：报告失败 -> （可选）重试或换工具
    -> 进程结束，无残留
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
- demo 退出码：两个 dispatch 都通过 -> exit 0，否则 exit 1

---

## 4. 架构演进建议

### 4.1 短期（当前 Level 可立即改进）

1. **并行 Dispatch**：当前两个任务串行执行（Claude Code 完了才跑 Codex）。对于独立任务应并行 dispatch，总耗时从 ~50s 降到 ~35s。实现方式：`Promise.all([dispatchClaude(), dispatchCodex()])`

2. **错误重试**：当前 dispatch 失败直接报告，无重试。应加一层：失败 -> 等待 3s -> 重试一次 -> 仍失败才报告。AI 响应有波动，单次失败不一定是真错误。

3. **成本控制**：Claude Code 支持 `--max-budget-usd` 参数限制单次花费。生产环境应默认设置预算上限。

### 4.2 中期（跨 Level 集成）

4. **调度经验记忆化**：MOSS 利用现有 Memory 系统，将每次 dispatch 的结果（任务类型、选用工具、耗时、成本、成功率）存为记忆。随着调用积累，MOSS 能基于历史经验优化调度选择--这不需要新建系统，Memory 的 search/recall 已经是现成的。

5. **调度级别自动升级**：当 one-shot dispatch 的产出不满足要求时（exit 0 但代码质量低、或 Judge 判断需要迭代），MOSS 应能自动升级到 Level 2 流式多轮或 Level 3 MCP。这是 Cognitive Loop 中 Judge 步骤的自然延伸--当前 demo 中 Judge 是人工的，生产环境应让 MOSS 自主判断。

### 4.3 长期（MOSS 系统级）

6. **Agent 池管理**：多个 agent 实例并发运行，MOSS 做负载均衡。类似数据库连接池--预热几个 agent session，任务来了直接派给空闲的。

7. **Agent 可用性检测**：MOSS 定期通过 exec_command 检查 agent CLI 的版本和可用性（claude --version / codex --version），将结果存入 Memory。当工具升级支持新参数时，MOSS 通过 Memory 更新自己的认知。这利用的是现有 exec_command + Memory 组合，不需要新机制。

8. **成本仪表盘**：跨所有 Level 的 agent 调用成本汇总，按任务类型、agent、时间段统计，帮助 MOSS 做成本最优的调度决策。

---

## 5. 与其他 Level 的关系

| 维度 | Level 1 (One-shot) | Level 2 (Streaming) | Level 3 (MCP) |
|------|-------------------|--------------------| ------------|
| 通信方向 | MOSS -> Agent（单向） | MOSS ↔ Agent（双向流式） | MOSS ↔ Agent（双向，通过 MCP 协议） |
| 上下文 | 无（每次独立） | 有（session 内多轮保持） | 有（MCP server 持久化） |
| 适用场景 | 简单、独立、单次任务 | 复杂、迭代、需要观察过程 | 需要 agent 访问 MOSS 能力 |
| 成本 | 最低 | 中等 | 取决于 MCP 调用频率 |
| 持久化 | 无 | session 内存 | MCP server 进程级 |

Level 1 是基础层--验证了 MOSS 能调通 agent CLI。后续 Level 在此基础上加深控制粒度，但调度链路本身（MOSS -> CLI -> 产出）是共通的。
