# pt-download

自研 PT 自动下载编排系统：基于 qBittorrent Web API，通过官方 RSS 抓取种子，按规则自动筛选并下发下载，并管理做种/分享率。

- 决策：自研编排层 + qBittorrent 内核 + 官方 RSS/API + 本地 Mac 部署
- 存储：MySQL

## 架构

```
PT 站点 RSS (带 passkey) --> Poller/Scheduler --> Parser --> Normalizer --> Dedup --> Rule Engine --> qBittorrent (Web API v2)
                                                (后端 Fastify 服务)                        |
                                                              MySQL <-- Seeding Manager <---+--> Web UI (后续)
```

## 定时轮询

服务启动后会自动开启后台调度器（`POLL_ENABLED=true`，检查间隔 `POLL_TICK_SEC=60`）：
每个周期检查各站 `poll_interval_sec` 是否到期，到期则执行「抓取 → 入库 → 评估规则 → 下发」。
进度状态保存在内存中，**重启后首轮会把所有启用站点视为到期并补跑一次**；重复下载由 `rss_items` 与 `matched_items` 的唯一键兜底。

```bash
curl -s http://127.0.0.1:3000/api/scheduler                    # 查看调度器与各站状态
curl -s -X POST "http://127.0.0.1:3000/api/scheduler/tick"     # 立即跑一轮（强制）
curl -s -X POST "http://127.0.0.1:3000/api/scheduler/tick?force=0"  # 按到期判断跑
```

关闭：`.env` 设 `POLL_ENABLED=false`。调整某站频率：更新 `sites.poll_interval_sec`。

## 做种 / 分享率 / 免费种管理（P4）

调度器每轮会向 qB 同步一次权威状态（写入 `downloads` 的 ratio / uploaded / downloaded / progress / tracker / seeding_time / state 等），
并清掉库中已不存在的任务。基于同步数据提供三项能力：

- **分享率告警**：按站点聚合 `上传/下载`，低于策略 `warn_ratio` 时仅在 `/api/seed/status` 的 `alerts` 中暴露告警，**不做任何自动动作**。
- **做种时长 / H&R 保护**：`min_seeding_hours`（默认 **72h**）作为最短做种时长，未达标不会进入清理候选。
- **清理候选**：达到「分享率 ≥ `target_ratio` 且 做种时长 ≥ `min_seeding_hours`」且未被标记保护（`is_protected=0`）的种子才作为候选；
  **仅出列表，必须人工确认后再调用 `POST /api/seed/apply`**（apply 时会二次校验候选资格，`force=1` 可跳过）。

策略按 `site_id` 覆盖：`site_id=0` 为全局默认，其余为站点覆盖；查不到时回退内置默认（ratio 1.0 / 72h）。

```bash
curl -s http://127.0.0.1:3000/api/seed/status          # 各站分享率 + 告警
curl -s http://127.0.0.1:3000/api/seed/candidates      # 清理候选（无副作用）
curl -s -X POST http://127.0.0.1:3000/api/seed/apply \
  -H 'Content-Type: application/json' -d '{"hashes":["<infohash>"],"deleteFiles":false}'
curl -s -X POST http://127.0.0.1:3000/api/policies \
  -H 'Content-Type: application/json' -d '{"siteId":0,"targetRatio":1.0,"minSeedingHours":72,"warnRatio":1.0}'
```

## 环境要求

- Node.js >= 22
- MySQL 5.7 / 8.0（可远程）
- qBittorrent（本机），已启用 Web UI

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 MySQL 与 qBittorrent 配置
npm run db:migrate     # 幂等建表
npm run dev            # 启动服务（默认 http://127.0.0.1:3000）
```

健康检查：

```bash
curl -s http://127.0.0.1:3000/health
```

## 前置配置

### 1. MySQL

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS pt_download DEFAULT CHARSET utf8mb4;"
```

### 2. qBittorrent（本机 8080 已被其他项目占用，改用 8081）

> Homebrew 的 `qbittorrent` cask 已被官方禁用（未通过 Gatekeeper 校验，2026-09-01 起）。
> 需从 SourceForge 手动下载 macOS 版 DMG（官方 macOS 版本止于 v5.0.5，支持有限）：
> https://sourceforge.net/projects/qbittorrent/files/qbittorrent-mac/

启动后在 `设置 > Web UI` 中：
- 勾选「Web 用户界面」，端口设为 **8081**
- 设置用户名/密码
- 建议在 `设置 > Web UI > API 密钥` 生成 API Key，填入 `.env` 的 `QB_API_KEY`

### 3. qB WebUI 上的「搜索服务」入口

在 qB 工具栏「配置」按钮右侧注入一枚入口，点击后新标签页打开本项目的 `/discover` 页面：

```bash
npm run qb:webui-entry            # 构建/更新镜像并启用（幂等，可重复执行）
npm run qb:webui-entry -- --refresh   # 强制按当前 qB 版本重新拉官方 WebUI 源码
npm run qb:webui-entry -- --disable   # 还原为 qB 内置 WebUI
```

原理与约束：

- qB 内置 WebUI 被打包进二进制（Qt QRC），磁盘上无 html/js 可改，因此改用官方**「替代 WebUI」**机制：
  镜像一份与当前 qB 同版本的官方 WebUI 到 `~/Library/Application Support/qBittorrent/webui-custom`，
  修改 `private/index.html` 后再通过 `POST /api/v2/app/setPreferences` 写入
  `alternative_webui_enabled` / `alternative_webui_path`。**改设置即生效，无需重启 qB。**
- 脚本会做启用后校验：全量路径可服务（全部 200）+ 入口按钮生效 + 静态资源引用闭包完整；
  任一不通过会自动回退到内置 WebUI。
- **替换是整包替换**：选中「替代 WebUI」后，qB 只从该目录取文件，缺失文件不会回退到内置资源（直接 500）。因此镜像必须是完整的。
- **qB 升级后需重建**：镜像会停留在旧版本，升级 qB 后重新执行 `npm run qb:webui-entry -- --refresh`。
- **WebUI 语言**：镜像不含 `translations/webui_*.qm`，若把 WebUI 语言改为中文，界面会退回英文。
- 回退：qB 设置 → Web UI → 取消勾选「使用替代 WebUI」（立即生效）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 检查 DB 与 qBittorrent 连通性 |
| GET | `/api/torrents` | 列出 qB 当前任务 |
| POST | `/api/torrents` | 手动添加种子 |
| GET/POST | `/api/sites` | 站点列表 / 新增（按 name 幂等 upsert） |
| POST | `/api/sites/:id/poll` | 抓取该站 RSS → 解析 → 入库去重 → **立即评估规则并下发**（`?dryRun=1` 只预览） |
| GET/POST | `/api/rules` | 规则列表 / 新增（按 name 幂等 upsert） |
| GET/PUT/DELETE | `/api/rules/:id` | 规则详情 / 更新 / 删除 |
| POST | `/api/rules/:id/test` | 用单条 rss item 试跑规则（`{ rssItemId }`） |
| POST | `/api/engine/run` | 手动触发规则评估（`{ dryRun, limit, siteId, sinceId }`） |
| GET | `/api/scheduler` | 调度器状态（开关、间隔、各站上次轮询与结果） |
| POST | `/api/scheduler/tick` | 立即跑一轮（默认 `force=1` 强制；`?force=0` 按到期判断） |
| GET | `/api/matched` | 命中记录（可按 `status` / `ruleId` 过滤） |
| GET | `/api/candidates` | 候选 rss 条目（调试用） |
| GET | `/api/downloads` | 本地下载/做种记录（可按 `siteId` / `state` / `limit` 过滤） |
| POST | `/api/downloads/sync` | 立即从 qB 同步一次做种状态 |
| GET | `/api/seed/status` | 各站分享率聚合 + 告警（仅告警） |
| GET | `/api/seed/candidates` | 清理候选列表（无副作用，需人工确认） |
| POST | `/api/seed/apply` | 人工确认后清理（`{ hashes, deleteFiles, force }`） |
| GET | `/api/policies` | 做种策略列表 |
| GET | `/api/policies/effective` | 某站生效策略（`?siteId=0` 全局） |
| POST | `/api/policies` | upsert 策略（`{ siteId, targetRatio, minSeedingHours, warnRatio }`） |
| DELETE | `/api/policies/:siteId` | 删除策略 |

手动添加示例：

```bash
curl -s -X POST http://127.0.0.1:3000/api/torrents \
  -H 'Content-Type: application/json' \
  -d '{"urls":"magnet:?xt=urn:btih:...","category":"pt","tags":"test"}'
```

规则示例（4K 且体积 ≤ 60GiB，下发到 qB 的 `pt-4k` 分类）：

```bash
curl -s -X POST http://127.0.0.1:3000/api/rules \
  -H 'Content-Type: application/json' \
  -d '{"name":"M-Team 4K 适中体积","priority":10,
       "match":{"op":"and","conditions":[
         {"field":"resolution","op":"eq","value":"2160p"},
         {"field":"sizeGiB","op":"lte","value":60}]},
       "action":{"category":"pt-4k","tags":["m-team"],"paused":true}}'
```

`dryRun` 只记录命中、不下发，便于在未装 qBittorrent 时验证规则：

```bash
curl -s -X POST http://127.0.0.1:3000/api/engine/run \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'
```

规则字段（`buildContext` 提供的可引用字段）：
`resolution` / `source` / `codec` / `audio` / `group` / `year` / `season` / `episode` / `hdr`（数组）/ `markers`（数组）/
`sizeGiB` / `sizeBytes` / `freeType` / `isFree` / `category` / `siteId` / `siteName` / `infohash` /
`title` / `cleanTitle` / `titleCn` / `titleOriginal` / `aliases` / `languages` / `regions` / `genres` / `imdb` / `douban` / `tmdb`。

算子：`eq` `ne` `in` `nin` `regex` `gt` `gte` `lt` `lte` `hasAny` `hasAll` `contains` `exists` `notExists`；
分组节点：`{ op: 'and' | 'or' | 'not', conditions: [ ... ] }`。

## 本地自测

```bash
npm run test:parse    # RSS 解析（内置 fixture）
npm run test:match    # 规则匹配（优先读 /tmp/mteam-sample.xml，回退 fixture）
```

## 已知约束（NexusPHP / M-Team 实测）

- **下载链接带时间签名**：RSS 里 `<enclosure>` 的 `dlv2` 链接会在短时间内失效（过期后返回 JSON 报错，而非种子文件）。
  因此必须**抓取后尽快下发**——poll 已内置「抓取 → 评估 → 下发」一步到位；下发前还会重抓一次 RSS 换取最新签名。
  若条目已从 `pageSize` 窗口滚出，则无法刷新，该条会记为 `failed`（RSS-only 方案的固有限制）。
- **qB 5.x 兼容**：登录成功返回 `204` 且会话 cookie 名为 `QBT_SID_<port>`；add 的 `paused` 参数已改名 `stopped`（代码同时传两者以兼容 4.x/5.x）。
- **添加结果校验**：qB 对「URL 抓取失败」也会返回 `Ok.`，故下发后按「前后 hash 差集」确认是否真正入队，并用回传的真实 infohash 落库。

## 路线图

- **P1** ✅ 后端骨架 + qB 客户端 + 手动添加种子
- **P2** ✅ RSS 轮询 + 标题解析 + 去重
- **P3** ✅ 规则引擎 + 自动下发（规则 CRUD / 匹配 / 命中去重 / 真实下发已端到端验证）
- **P3.5** ✅ 定时轮询（后台调度器：按站 `poll_interval_sec` 到期自动「抓取 → 评估 → 下发」）
- **P4** ✅ 做种/分享率/免费种管理器（qB 状态同步 + 分享率告警 + H&R 时长保护 + 人工确认清理 + 按站策略）
- **P4.5** ✅ 影片发现与搜索（mdo 榜单 → M-Team 按 IMDb 反查 → `/discover` 预览 + 一键下载到 qB）
- **P5** Web UI（规则 CRUD、任务列表、历史、实时进度）
- **P6** 通知（飞书）+ 磁盘守卫

## 数据表

`sites` / `rss_items` / `rules` / `matched_items` / `downloads` / `seed_policies` / `history` / `settings`
