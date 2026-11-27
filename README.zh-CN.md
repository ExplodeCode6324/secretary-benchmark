# Secretary Benchmark

单配置评测入口为 `npm run benchmark -- evaluate --config examples/secretary-smoke.json`。该命令启动隔离 Secretary、投递案例、评分并输出报告。真实 DeepSeek 配置、独立 Hermes 评分、仅凭归档轨迹重新评分及离线重建报告的命令见[操作手册](docs/operator.md)。

独立的 Secretary benchmark 仓库，负责隔离测试环境、评分记录、固定输入回放与报告。Secretary 是固定提交的只读测试依赖，存放在 `sut/secretary`；具体提交由 `sut.lock.json` 绑定。

交付范围是 **benchmark 可运行、证据可追溯、报告可复现、测量限制明确**。结果为 ADVISORY / NOT_HUMAN_QUALIFIED；本仓库不宣布 Secretary 性能达标，也不设置验收阈值。

安装 Node.js 22.19+、Python 3、Git 和 PostgreSQL 18 服务端工具后，递归克隆仓库，运行 `npm ci` 与 `npm run verify`。测试不需要 API 凭据，也不调用真实模型；PG 集群由测试自行隔离创建。详见 [英文快速开始](README.md) 和 [操作说明](test_case/online/benchmark/README.md)。

代码、当前验证结果与本地私有材料属于本仓库；`.local/` 不提交。禁止使用部署实例或敏捷实例的数据/凭据。SUT 提交、递归子模块与清洁状态必须通过检查。

当前评分口径为 Opus 5.5 Extra，保留原 Fable v3 历史。公开静态控制题属于开发可见的合成样例，不是隐藏校准集。LongMemEval 适配路径不等于官方评分。

[证据索引](evidence/README.md) 区分历史交付摘要与首次独立仓库 correctness 验证。安全网络恢复后已核验历史归档并补齐首次 pilot 的可公开投影与实际 SUT 身份：初始执行快照31行、资源审计50行/563次请求预留、最终Opus选择30条轨迹/28条可评分。三个快照分开呈现，不用新仓库固定提交填补历史来源。完整私有输入保留在私有归档；当前归档状态见工作回执。

归档需要显式配置忽略文件 `.local/archive.json`，字段为绝对路径 `mount` 和 `destination`，权限 0600。缺失配置、未挂载或不安全目标均拒绝执行。不得用同名本地目录代替外部卷。

本仓库尚未选择或授予额外软件许可；公开可见不代表开放源代码许可。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

若操作系统账号数据库无法解析当前用户（例如容器 UID 没有对应记录），受保护目录检查会拒绝运行；运行前需提供正常账号记录。
