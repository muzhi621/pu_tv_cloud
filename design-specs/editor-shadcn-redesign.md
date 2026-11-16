# 云端配置编辑器 UI 重构设计规范（shadcn/ui 风格）

日期：2026-11-16
参考：https://github.com/shadcn-ui/ui （Theming / Component 规范）
目标：在不改变任何配置读写契约的前提下，重构 `editor/` 视觉语言与页面布局，
并为「开机公告」（启动弹窗）补齐可编辑内容字段。

---

## 1. 需求解析

| 字段 | 值 |
|------|-----|
| project_type | 工具 / 后台配置管理 |
| target_platform | Web（PC 浏览器为主，兼容平板） |
| user_persona | 自建 IPTV/TVBox 服务的个人运维者 |
| core_tasks | ①配置套餐下发 ②编辑启动/退出弹窗文案 ③管理 IPTV/TVBox 源与终端 |
| brand_tone | 克制、专业、清晰（shadcn 中性灰 + 单一强调色） |
| constraints | 纯原生 HTML/CSS/JS，无构建链；产物内联进 Edge Function；契约字段不可破坏 |

**现状问题（来自用户截图与代码核对）**

1. 「开机公告」卡片只有 `启用公告 / 允许关闭 / 显示频率` 三个控件，**没有可编辑内容**；
   而 `startup.notice.titleI18n` / `bodyI18n` 在 `cloud/schema.py`、`edge-functions/_lib/contract.js`
   与 Flutter 客户端（`RemoteConfigService.noticeTitle/noticeBody`）**已全线支持** —— 只是编辑器漏了入口。
2. 视觉语言老旧：蓝紫渐变 logo、`#f5f7fa` 页面底、10px 圆角、无 focus-visible、
   卡片权重混乱，与 shadcn 的中性、克制、语义化 token 体系不一致。
3. 顶部连接区信息密度高、层级不清；`main` 宽 1180px 在大屏上偏窄。

---

## 2. 设计令牌表（Design Tokens）

采用 shadcn neutral 主题的 oklch 语义 token，保留少量项目语义色。全部挂在 `:root`，
用 fallback 写法保证旧浏览器可用（先十六进制，后 oklch 覆盖）。

| Token | 值（oklch / fallback） | 用途 |
|-------|------------------------|------|
| `--background` | `#fafafa` / `oklch(0.985 0 0)` | 页面底色 |
| `--foreground` | `#18181b` / `oklch(0.145 0 0)` | 主文本 |
| `--card` | `#ffffff` / `oklch(1 0 0)` | 卡片表面 |
| `--card-foreground` | 同 foreground | 卡片内文本 |
| `--popover` / `--popover-foreground` | 白 / 近黑 | 浮层、toast |
| `--primary` | `#2563eb` / `oklch(0.55 0.19 260)` | 主按钮、选中态（保留品牌蓝） |
| `--primary-foreground` | `#ffffff` | 主按钮文本 |
| `--secondary` | `#f4f4f5` / `oklch(0.967 0 0)` | 次要按钮、tabs 底 |
| `--secondary-foreground` | `#18181b` | 次要文本 |
| `--muted` | `#f4f4f5` | 弱化表面 |
| `--muted-foreground` | `#71717a` / `oklch(0.556 0 0)` | 说明文字、meta |
| `--accent` | `#eff6ff` / `oklch(0.95 0.02 260)` | hover / 选中高亮 |
| `--accent-foreground` | `#1d4ed8` | 高亮文本 |
| `--destructive` | `#dc2626` / `oklch(0.577 0.245 27.3)` | 危险操作 |
| `--success` | `#15803d` | 成功 / 在线 |
| `--warning` | `#b45309` | 警告 |
| `--border` | `#e4e4e7` / `oklch(0.922 0 0)` | 边框、分隔线 |
| `--input` | `#e4e4e7` | 输入框边框 |
| `--ring` | `#2563eb` / `oklch(0.55 0.19 260)` | 焦点环 |
| `--radius` | `0.625rem` | 基准圆角 |

派生圆角：`--radius-sm = 0.6×`、`--radius-md = 0.8×`、`--radius-lg = 1×`、`--radius-xl = 1.4×`。
间距沿用 4px 基准（4/8/12/16/24/32/48）。字号：12/13/14/16/18px，字重 400/500/600/700。

**对比度**：muted-foreground `#71717a` on 白 = 4.83:1 ≥ 4.5:1（WCAG AA）；
primary `#2563eb` on 白 = 5.17:1；primary-foreground on primary ≈ 5.1:1。

---

## 3. 组件规格卡

| 组件 | 类 | 关键规格 |
|------|-----|---------|
| Button-Primary | `button.primary` | 高 36px，padding 0 16px，radius-md，font 13px/600；hover 提亮 + shadow-sm；focus-visible 2px ring offset 2px |
| Button-Outline | `button.ghost` | 同上，透明底 + border；hover 变 accent |
| Button-Tiny | `button.tiny` | 高 26px，font 12px，用于表格行内 |
| Input / Select / Textarea | `input/select/textarea` | 高 36px（textarea min 72px），padding 8px 11px，border-input，radius-md；focus: border-primary + ring 3px 10% |
| Switch | `input.switch` | `accent-color: var(--primary)`，16×16，触控区由 label 撑开 ≥ 24px |
| Card | `.panel` / `.extra` / `.df-block` | 白底 + 1px border + radius-lg + shadow-sm；`df-block` 内边距 16px |
| Tabs | `.tabs button` | 高 38px；active 用白底 + 底部 2px primary 指示条（不用整块凸起） |
| Badge | `.badge` | 圆角 999px，12px/600，padding 2px 10px；语义变体 ok/warn/off |
| Alert | `.message` | 左 3px 语义色条 + 淡背景，radius-md |
| Field | `.df-field` / `.field` | label 12px muted + 控件，gap 6px |

所有交互元素统一 `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }`。

---

## 4. 页面布局蓝图

```
┌ topbar (sticky) ────────────────────────────────────────────────┐
│ brand (logo + 标题)          │ conn (API/读令牌/写令牌/连接)      │
└──────────────────────────────────────────────────────────────────┘
┌ statusbar ───────────────────────────────────────────────────────┐
│ 状态文案 · 套餐版本 · 终端在线 chips        [刷新数据]            │
└──────────────────────────────────────────────────────────────────┘
┌ tabs ────────────────────────────────────────────────────────────┐
│ 套餐管理 | IPTV 源 | TVBox 源 | 终端管理                          │
└──────────────────────────────────────────────────────────────────┘
┌ panel ───────────────────────────────────────────────────────────┐
│ 页面标题 + hint                                                  │
│ ┌ df-grid：auto-fit minmax(340px, 1fr)，gap 16px ─────────────┐ │
│ │ Card 导航 │ Card 开机公告 │ Card 退出弹窗 │ Card 在线更新…   │ │
│ │ 开机公告卡：开关 + 频率 + 中英文标题/正文 + 实时预览          │ │
│ └───────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
┌ extra（抽屉式区块，仅在需要时出现）┐ ┌ message（操作反馈）┐
```

断点：≥1280px 主内容 max-width 1280 居中；768–1279px 两列；<720px 单列，conn 换行。
关键路径：连接 → 套餐管理 → 开机公告（编辑标题/正文）→ 下发配置。

---

## 5. 前端实现指引

- CSS 变量集中在 `style.css :root`，保留旧变量名（`--bg/--surface/--accent…`）作为别名，
  避免遗漏的样式失效；新代码统一用 shadcn 语义名。
- 类名沿用现状（`df-block/df-field/tabs/…`），只改视觉不改结构 → `app.js` 无需大规模改写。
- 开机公告新增字段路径（与既有契约一致，无需改 schema）：
  - `startup.notice.titleI18n.zh` / `.en`
  - `startup.notice.bodyI18n.zh` / `.en`
- 实时预览：读取 `state.doc.sections`，输入事件后局部更新预览 DOM，不整页重绘（避免抢焦点）。
- 无障碍：所有控件 `:focus-visible` 环；预览使用 `aria-live="polite"`；图标按钮补 `aria-label`。
- 移动端断点 720px 折叠连接区与表格操作列。

## 6. 校验清单

- [x] 设计令牌含 background/foreground/card/primary/secondary/muted/accent/destructive/border/input/ring/radius
- [x] 所有颜色组合满足 4.5:1 正文对比度
- [x] 组件卡覆盖 Button / Input / Switch / Card / Tabs / Badge / Alert
- [x] 布局蓝图标注断点与关键路径
- [x] 新增字段复用既有 schema 契约（无后端改动）
- [ ] 重构后运行 `python scripts/build_edgeone_assets.py --check`
- [ ] 运行 `npm test`
