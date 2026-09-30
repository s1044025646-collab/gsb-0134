# 本地纠删码条带编码与恢复后端

仅在 Windows 本机运行的 Reed–Solomon 擦除码（erasure coding）后端。使用 TypeScript +
Node.js 内置 `node:sqlite`，不实现网页、云存储或任何网络传输协议。对外提供：

- 本机 HTTP API（仅监听 `127.0.0.1`，端口由操作系统自动分配）
- 命令行（CLI）
- 可重复的合成二进制数据与故障夹具、端到端演示
- 自动化测试（逐字节一致性、失败路径、事务回滚、重启持久化）

所有数据、分片、临时文件、恢复产物和运行信息都保存在项目目录内。

## 依赖

- Node.js `>= 22.5`（开发环境使用 Node v25，使用内置实验模块 `node:sqlite`）
- 无第三方运行时依赖；开发依赖仅 `typescript`、`tsx`、`@types/node`

```powershell
node --version
npm install
```

## 数学定义（公开）

- 域：GF(2^8) = GF(256)
- 本原元素：α = 2（即 x）
- 本原多项式：`p(x) = x^8 + x^4 + x^3 + x^2 + 1`，9 位系数为 `0x11D`（低 8 位
  `0x1D`，与 AES/Rijndael 相同）。对数/指数表由该多项式在运行时推导，不硬编码。
- 系统码生成矩阵 `G`（n = k + m 行、k 列）：
  - 数据行 `0..k-1` 为 k×k 单位阵，因此第 i 个数据片就是第 i 个定长条带向量，
    而不是整文件副本。
  - 校验行采用 Cauchy 构造：`G[k+p][c] = 1 / (p XOR (m+k+c))`，要求 `m + 2k <= 256`。
  - Cauchy 矩阵任意 k 行线性无关，因此每条带只要存在任意 k 个**不同且有效**的分片
    即可恢复全部 k 个数据向量。
- 本系统只能识别并处理“已被检测到的擦除”（丢失或摘要不符），不宣称纠正未检测的
  任意错误。

分片容器为自描述二进制（魔数 `ECSD`），记录条带号、片号、data/parity 类型、载荷
长度、版本摘要，并在末尾附带覆盖整个文件的 SHA-256。任何位翻转都会在校验时被识别为
擦除。

## 数据布局

默认数据目录为 `./ec-data`（可用环境变量 `EC_DATA_DIR` 覆盖）：

- `erasure.db`：SQLite 数据库（方案、版本、分片、故障、恢复批次）
- `shards/<versionId>/s<stripe>_i<index>.shard`：分片文件
- `tmp/`：恢复临时文件（成功前绝不发布）
- `recovered/`：全部校验通过后原子重命名发布的恢复文件
- `run/server.pid`：服务进程 PID 与端口

尾条带统一补零到固定片长，数据库记录 `tail_original_length` 保存原始字节数；空文件
产生 0 条带的显式版本记录，恢复结果为 0 字节文件。

## 测试

```powershell
npm test
```

覆盖内容：

- GF(256) 域公理、乘法逆元、矩阵求逆与奇异矩阵检测
- 小参数 `(k,m)` 下穷举所有可恢复子集，逐字节一致
- 中文文件名、全零、随机内容、尾条带补零、空文件
- 不连续丢片、仅校验片缺失、数据片缺失、位翻转被识别为擦除
- 混入旧版本分片（版本摘要不符）、重复片号、有效片不足（超出容错）拒绝
- 幂等恢复（相同幂等键返回同一批次）、幂等键跨版本冲突
- 恢复先写临时文件，失败不留临时文件、不产生成功产物
- API 参数校验、错误码、游标分页
- 重启后重新打开数据库仍可恢复；迁移可重复执行

## 可重复的端到端演示

```powershell
npm run demo
```

演示使用固定的伪随机种子、固定 UUID 和固定时钟，结果可重复，包含成功与失败路径。
演示数据写入 `./demo-data`。

## 启动 / 停止 API 服务

```powershell
# 前台启动（仅绑定 127.0.0.1，自动端口；端口写入 ec-data/run/server.pid）
npm start          # 需先 npm run build
npm run dev        # 直接用 tsx 运行 TS 源码

# 在另一个终端停止（只终止本项目 pid 文件中记录的进程）
npm run stop
```

健康与数学说明：`GET /health`、`GET /api/spec`。

### API 摘要

- `POST /api/versions`：body `{ name, dataBase64, k, m, stripeSize }`
- `GET /api/versions?limit=&cursor=`：分页列出版本
- `GET /api/versions/:id`
- `GET /api/versions/:id/shards?limit=&cursor=`：分页列出分片
- `GET /api/versions/:id/inspect`：逐片检查，标记有效/擦除，给出是否可恢复
- `POST /api/versions/:id/faults`：`{ stripeIndex, shardIndex, fault: "lose"|"bitflip" }`
- `POST /api/versions/:id/recover`：可选 `{ selectedIndices:[...], idempotencyKey }`
- `GET /api/versions/:id/recoveries?limit=&cursor=`：恢复批次与错误码

错误使用稳定错误码：`VALIDATION_ERROR`、`NOT_FOUND`、`CONFLICT`、
`INSUFFICIENT_SHARDS`、`DUPLICATE_SHARD_INDEX`、`SHARD_INDEX_OUT_OF_RANGE`、
`SHARD_DIGEST_MISMATCH`、`STALE_VERSION`、`OVER_FAULT_TOLERANCE`、
`SINGULAR_MATRIX`、`RECOVERY_FAILED`、`IDEMPOTENCY_MISMATCH`。

## CLI

```powershell
npm run cli -- encode <file> --k 3 --m 2 --stripe-size 16
npm run cli -- inspect <versionId>
npm run cli -- fault <versionId> <stripe> <shard> <lose|bitflip>
npm run cli -- recover <versionId> [--indices 0,1,3] [--idempotency-key K]
npm run cli -- compare <original> <recovered>
npm run cli -- list
npm run cli -- list-recoveries <versionId>
```

编码、故障、恢复命令都会在输出中展示操作前后的关键状态。

## 清理

```powershell
npm run clean
```

仅删除本项目的 `ec-data/`、`demo-data/` 与临时调试目录，不会触碰项目之外的文件。
