# Forge Memory Layer — Implementation Plan

## 目标

让 AI 在大型项目（FortiNAC 2000+ files）中不丢失逻辑，通过模块化记忆提供精准的上下文。

## 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                     Forge Memory Layer                       │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │ Module Registry │  │ Interface Map  │  │ Knowledge     │  │
│  │ 模块边界+文件   │  │ 模块间接口关系 │  │ 经验/约束/决策│  │
│  │                │  │                │  │               │  │
│  │ .forge/memory/ │  │ 自动生成+人工  │  │ remember/     │  │
│  │ modules/*.yaml │  │ 修正           │  │ recall        │  │
│  └───────┬────────┘  └───────┬────────┘  └──────┬────────┘  │
│          │                   │                   │           │
│          └──────────┬────────┘───────────────────┘           │
│                     │                                        │
│          ┌──────────▼─────────┐                              │
│          │   Code Graph (AST) │  文件级调用链                 │
│          │   Worker Thread    │  增量更新                     │
│          └────────────────────┘                              │
│                                                              │
│  Storage: <project>/.forge/memory/ (纯文本 JSON/YAML)        │
│  API: Forge MCP tools (search_code, get_module, remember...) │
│  UI: Project Detail → Memory tab                             │
└──────────────────────────────────────────────────────────────┘
```

## 存储结构

```
<project>/.forge/memory/
├── modules/                    # Module Registry
│   ├── _index.yaml             # 模块列表 + 多维度分类
│   ├── web-server--user.yaml   # 模块定义
│   ├── web-server--host.yaml
│   ├── web-server--system.yaml
│   ├── masterloader.yaml
│   └── _unassigned.yaml        # 未分配到任何模块的文件
│
├── interfaces/                 # Interface Map（自动生成）
│   ├── web-server--user.json   # user 模块的接口
│   └── ...
│
├── knowledge.json              # Knowledge Store（现有）
├── graph.json                  # Code Graph（现有，AST 缓存）
└── meta.json                   # 扫描元数据
```

## 一、Module Registry

### 1.1 模块索引 (_index.yaml)

```yaml
# .forge/memory/modules/_index.yaml
version: 1
project: FortiNAC
updated_at: 2026-04-07

# 多维度分类 — 同一个模块可以出现在多个维度
dimensions:
  by-service:
    - name: web-server
      children: [user, host, system, vlan, network, portal]
    - name: masterloader
      children: [bootstrap, schema, migration]
    - name: agent-server
      children: [radius, dhcp, snmp]
    - name: database
      children: [dao, schema]

  by-function:
    - name: authentication
      modules: [web-server/user, agent-server/radius, web-server/portal]
    - name: network-enforcement
      modules: [web-server/vlan, agent-server/snmp, web-server/network]
    - name: device-management
      modules: [web-server/host, agent-server/dhcp]

  by-layer:
    - name: api-layer
      modules: [web-server/user, web-server/host, web-server/system]
    - name: service-layer
      modules: [masterloader, agent-server]
    - name: data-layer
      modules: [database]
```

### 1.2 模块定义 (per-module YAML)

```yaml
# .forge/memory/modules/web-server--user.yaml
name: web-server/user
description: "用户管理模块 — CRUD、认证、权限、角色"
updated_at: 2026-04-07

# 文件归属 — 支持目录和具体文件
paths:
  - src/main/java/com/fortinet/nac/server/user/
  - src/main/java/com/fortinet/nac/model/User.java
  - src/main/java/com/fortinet/nac/model/UserRole.java
  - src/main/resources/mapper/UserMapper.xml

# 排除（在 paths 范围内但不属于此模块）
exclude:
  - src/main/java/com/fortinet/nac/server/user/legacy/

# 入口点 — 模块的主要入口
entry_points:
  - UserController.java
  - UserService.java

# 标签 — 用于搜索和关联
tags: [user, auth, rbac, login, session]
```

### 1.3 未分配文件 (_unassigned.yaml)

```yaml
# 自动生成：所有不属于任何模块的文件
# 用户逐步从这里分配到具体模块
files:
  - src/main/java/com/fortinet/nac/util/StringHelper.java
  - src/main/java/com/fortinet/nac/common/Constants.java
  - ...
count: 847
last_updated: 2026-04-07
```

## 二、Interface Map

### 2.1 自动生成逻辑

```
扫描模块内所有 Java 文件：
1. public class → 记录类名
2. public method → 记录方法签名
3. @RestController/@GetMapping/@PostMapping → 记录 REST API
4. @Autowired/@Inject 的其他模块类 → 记录依赖

输出: interfaces/<module>.json
```

### 2.2 接口文件格式

```json
// .forge/memory/interfaces/web-server--user.json
{
  "module": "web-server/user",
  "generated_at": "2026-04-07",
  "verified": false,

  "exposes": {
    "rest": [
      { "method": "GET", "path": "/api/user", "handler": "UserController.getUser", "line": 45 },
      { "method": "POST", "path": "/api/user", "handler": "UserController.createUser", "line": 62 },
      { "method": "DELETE", "path": "/api/user/{id}", "handler": "UserController.deleteUser", "line": 78 }
    ],
    "java": [
      { "class": "UserService", "method": "getUser(Long id)", "visibility": "public", "line": 30 },
      { "class": "UserService", "method": "createUser(UserDTO dto)", "visibility": "public", "line": 55 },
      { "class": "UserService", "method": "authenticate(String username, String password)", "visibility": "public", "line": 80 }
    ]
  },

  "depends_on": [
    { "module": "web-server/system", "class": "AuthService", "method": "authenticate", "usage": "UserController 鉴权" },
    { "module": "web-server/host", "class": "HostResolver", "method": "resolve", "usage": "关联用户和主机" },
    { "module": "database", "class": "UserDAO", "method": "findById", "usage": "数据访问" }
  ],

  "depended_by": [
    { "module": "web-server/host", "class": "HostController", "method": "getHostUsers", "usage": "查询主机关联用户" },
    { "module": "masterloader", "class": "MasterLoader", "method": "initServices", "usage": "启动时加载" }
  ]
}
```

## 三、MCP 工具设计

### 3.1 模块管理

```
define_module(name, paths, description?, tags?, exclude?)
  → 创建/更新模块定义 YAML
  → 触发接口扫描
  → 从 _unassigned 移除已分配文件

remove_module(name)
  → 删除模块定义
  → 文件回到 _unassigned

list_modules(dimension?)
  → 列出所有模块（可按维度过滤）
  → 返回名称 + 描述 + 文件数 + 接口数
```

### 3.2 模块查询

```
get_module(name)
  → 返回完整模块上下文：
    - 文件列表
    - 对外接口（REST + Java）
    - 依赖关系（depends_on + depended_by）
    - 关联知识（knowledge entries for this module）
    - 入口点
  → 这是 smith 开始工作前调用的主要工具

get_module_interfaces(name)
  → 只返回接口部分（轻量）

get_module_deps(name)
  → 只返回依赖关系
  → 包含双向：我依赖谁 + 谁依赖我
```

### 3.3 现有工具保留

```
search_code(query)       — 代码关系图搜索（AST）
get_file_context(file)   — 单文件上下文
remember(title, content, type, module?, file?)  — 知识存储（新增 module 参数）
recall(query?, module?, type?)  — 知识检索（新增 module 过滤）
forget(id)               — 删除知识
rescan_code(force?)      — 增量更新代码图谱
```

### 3.4 自动化工具

```
scan_module_interfaces(name)
  → 重新扫描模块接口（AST 分析 public 方法 + 注解）
  → 更新 interfaces/<module>.json
  → 在 worker thread 中执行

refresh_unassigned()
  → 重新扫描项目，找出不属于任何模块的文件
  → 更新 _unassigned.yaml

validate_modules()
  → 检查模块定义是否有问题：
    - 文件路径是否存在
    - 是否有文件被多个模块声明
    - 接口是否过期（源文件修改时间 > 接口扫描时间）
```

## 四、工作流程

### 4.1 初始化（首次使用）

```
Step 1: 人工定义模块列表
  → 在 UI Memory tab 或 MCP 工具创建模块
  → define_module("web-server/user", ["src/.../user/"])
  → define_module("web-server/host", ["src/.../host/"])
  → ...
  → 不确定的不用定义，自动归 _unassigned

Step 2: 自动扫描接口
  → 每个模块创建后自动 scan_module_interfaces
  → 生成 interfaces/<module>.json
  → 人工查看、修正

Step 3: 人工补充知识
  → remember("UserDAO 不能绕过 Service 层", type: constraint, module: "web-server/user")
  → remember("2024 改了缓存策略导致脏读", type: experience, module: "web-server/user")
```

### 4.2 日常重构工作

```
用户说："重构 web-server/user 模块"

Smith 自动执行：
  1. get_module("web-server/user")
     → 拿到文件列表 + 接口 + 依赖 + 知识
  
  2. 根据文件列表 Read 关键文件
     → 只读 user 模块的代码，不读别的
  
  3. 改代码
     → 知道改了 UserService.getUser() 签名
     → 依赖关系告诉它 HostController 调了这个方法
     → 不需要 grep 全局搜索
  
  4. 改完后
     → rescan_code() 增量更新图谱
     → scan_module_interfaces("web-server/user") 更新接口
     → remember("重构了 getUser，改为分页返回", type: decision, module: "web-server/user")
```

### 4.3 变更触发更新

```
当 user 模块的文件被修改：
  → git diff 检测到变更
  → 自动标记 user 模块的接口为 "待验证"
  → 下次 get_module 时提示 "接口可能过期，建议 rescan"

当新增文件：
  → rescan 检测 untracked files
  → 如果在已定义模块的 paths 内 → 自动归入
  → 如果不在 → 加入 _unassigned
```

## 五、实现步骤

### Phase 1: Module Registry（核心）
```
1. 实现 modules/ 目录的 YAML 读写
2. MCP 工具: define_module, list_modules, get_module, remove_module
3. _unassigned.yaml 自动生成
4. UI: Memory tab 加模块列表 + 定义界面
预计: 2-3 天
```

### Phase 2: Interface Map（自动化）
```
1. Java AST 接口扫描（public methods + REST annotations）
   → 当前 TypeScript compiler 不支持 Java
   → 选项 A: 用 regex 提取（快但不精确）
   → 选项 B: 加 tree-sitter-java（精确但需要编译）
   → 选项 C: 让 Claude 分析文件生成接口描述（灵活但费 token）
2. MCP 工具: scan_module_interfaces, get_module_interfaces, get_module_deps
3. 依赖关系自动推断（import 分析）
预计: 3-5 天
```

### Phase 3: 联动优化
```
1. get_module 返回完整上下文（文件+接口+依赖+知识）
2. 变更触发更新（git hook or rescan 时检查）
3. validate_modules 一致性检查
4. remember 自动关联到模块
5. UI: 模块详情页（接口列表、依赖图、知识条目）
预计: 2-3 天
```

### Phase 4: 跨模块分析
```
1. 影响分析: "如果改了 UserService.getUser()，哪些模块受影响"
   → 从 Interface Map 的 depended_by 自动推断
2. 模块健康度: 哪些模块知识完整、哪些缺失
3. 重构建议: 基于模块依赖图建议重构顺序
预计: 1-2 天
```

## 六、关键决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 存储格式 | YAML (modules) + JSON (interfaces, knowledge) | 人工编辑用 YAML，自动生成用 JSON |
| 模块边界 | 人工定义 + 逐步细化 | 自动推断不准，人工最可靠 |
| 接口提取 | 自动为主 + 人工修正 | 减少手工量 |
| 更新策略 | 变更触发 + 增量更新 | 性能优先 |
| 多维度分类 | _index.yaml 的 dimensions | 同一模块可属于多个分类 |
| 未分配文件 | _unassigned.yaml 自动追踪 | 逐步消化，不强制一次分完 |
| Java 解析 | Phase 2 再决定（regex / tree-sitter / Claude） | 先用模块定义跑通流程 |

## 七、文件清单

### 新增文件
```
lib/memory/module-registry.ts    — Module Registry CRUD + _unassigned 管理
lib/memory/interface-scanner.ts  — 接口扫描（Phase 2）
```

### 修改文件
```
lib/forge-mcp-server.ts          — 新增 MCP 工具
lib/memory/memory-mcp-server.ts  — 独立模式也支持模块
components/ProjectDetail.tsx     — Memory tab 加模块管理 UI
app/api/memory/route.ts          — 模块 API 端点
```

### 存储文件（运行时生成）
```
<project>/.forge/memory/modules/_index.yaml
<project>/.forge/memory/modules/<name>.yaml
<project>/.forge/memory/interfaces/<name>.json
```
