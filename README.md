# 风电场检修隔离与作业许可协调平台

源提示词编号：9。覆盖风机、箱变和线路隔离点、锁定与验电步骤、作业许可状态流、跨班组冲突检测、实时提醒、断线重连、失败操作重试和审计记录。

## 并发与一致性模型

- **服务端唯一事实**：许可（锁定、步骤、状态）与审计只保存在服务端（`server/utils/state.ts`），浏览器不再各存一份；客户端通过 `GET /api/state` 拉取、`POST /api/operations` 批量提交。
- **乐观版本控制**：每条操作携带 `baseRevision`（看到的许可聚合版本 `rN`）和 `opId`（客户端生成的唯一操作号）。版本过期只驳回受影响许可的操作，同批其余操作正常成功，响应返回最新全量事实。
- **隔离点级联失效**：隔离点状态变更后，共享该点的其他许可立即递增版本、标记 `reviewRequired` 并写入失效原因，必须由值班负责人基于最新版本重新确认（`reconfirm`）后才能继续操作。
- **幂等与断线恢复**：服务端记录已处理的 `opId`，网络失败后客户端从最后确认项之后重发整个待提交队列（localStorage outbox），同一操作号回放首次结果，绝不重复写入状态或审计。
- **冲突后可继续处理**：冲突只针对单张许可，页面其余许可、其他班组的操作不受影响。

## 技术栈

Nuxt 3、Nuxt UI、Pinia、Nuxt Router、TanStack Query、ofetch、WebSocket 模拟、TypeScript。

## 运行

```bash
npm install
npm run dev
```

开发地址：http://localhost:62052

```bash
npm run build
```
