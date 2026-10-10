# 资产拓扑升级 - README 补充说明

## 新功能：资产拓扑可视化面板 🗺️

### 功能概览

资产拓扑升级将原来的静态"资产清单"面板演进为**交互式拓扑图**，让渗透作业中的资产发现和验证过程更加直观。

```
原来的流程：  工作流 → 文本列表 → 手工关联
升级后：     工作流 → 可视化拓扑 → 自动布局 + 手工标注
```

### 核心特性

| 特性 | 说明 |
|------|------|
| **可视化布局** | 力导向算法自动分散节点，支持拖拽调整 |
| **阶段着色** | 5 种颜色区分发现阶段（情报→建模→分析→利用→后渗透） |
| **关系可视化** | 边的样式、颜色、方向表示资产间的依赖/信任/通信关系 |
| **交互标注** | 点击节点查看详情，右侧面板支持添加用户标注 |
| **位置持久化** | 用户拖拽的节点位置自动保存，下次打开恢复布局 |
| **过滤控制** | 支持按发现阶段和验证状态过滤节点 |

### 快速开始

#### 后端集成

1. **运行数据库迁移**
   ```bash
   npm run migrate
   # 或显式指定：
   npm run migrate -- --version 028
   ```

2. **检查数据库**
   ```sql
   -- 查看扩展后的 assets 表
   \d pentest.assets
   
   -- 查看新表 asset_relationships
   \d pentest.asset_relationships
   ```

#### 前端集成

1. **安装 Cytoscape 依赖**
   ```bash
   npm install cytoscape cytoscape-fcose
   ```

2. **导入面板组件**
   ```typescript
   // src/client/panels.ts
   import { AssetTopologyPanel } from './panels/AssetTopologyPanel';
   
   export const CONSOLE_PANELS: ConsolePanelDefinition[] = [
     // ... 其他面板 ...
     {
       id: 'asset-topology',
       name: '资产拓扑',
       icon: '🗺️',
       component: AssetTopologyPanel,
       order: 2,  // 在资产清单之前
     },
   ];
   ```

3. **添加样式**
   ```typescript
   // src/client/styles/panels.ts
   export const assetTopologyStyles = css`
     .pentest-asset-topology {
       display: flex;
       flex-direction: column;
       height: 100%;
     }
     
     .pentest-asset-topology__toolbar {
       padding: 12px;
       border-bottom: 1px solid #e0e0e0;
       display: flex;
       gap: 8px;
     }
     
     .pentest-asset-topology__container {
       flex: 1;
       overflow: hidden;
     }
     
     .pentest-asset-details-sidebar {
       position: absolute;
       right: 0;
       width: 320px;
       background: white;
       border-left: 1px solid #ddd;
       box-shadow: -2px 0 8px rgba(0,0,0,0.1);
     }
   `;
   ```

### 使用场景

#### 场景 1：情报收集后确认网络面
1. 打开"资产拓扑"面板
2. 看到绿色节点（情报收集阶段）
3. 用工具栏的"🔍 适应视图"查看全景
4. 确认覆盖的端口与目标目标是否一致

#### 场景 2：威胁建模阶段标注依赖关系
1. 切换到"威胁建模"阶段
2. 蓝色节点出现（新阶段资产）
3. 点击节点查看服务版本
4. 右侧面板添加标注：`"这个 MySQL 3.7 暴露在内网，可作为跳板"`
5. 标注自动保存，审计记录完整

#### 场景 3：跨阶段追踪利用路径
1. 查看完整拓扑（包含所有阶段）
2. 绿→蓝→橙→黄 节点链路显示整个渗透过程
3. 黄色节点表示已利用成功的资产
4. 点击黄色节点查看漏洞类型和验证证据

### API 参考

#### 获取拓扑数据

```bash
POST /api/pentest/getAssetTopology
Content-Type: application/json

{
  "engagementId": "engagement-uuid",
  "phases": ["intelligence-gathering", "threat-modeling"],
  "verification_statuses": ["verified-reachable", "exploited"]
}
```

响应：
```json
{
  "ok": true,
  "nodes": [
    {
      "id": "asset-uuid",
      "label": "172.29.0.2",
      "data": {
        "assetId": "asset-uuid",
        "canonicalTarget": "172.29.0.2:22/SSH,80/HTTP",
        "discovered_in_phase": "intelligence-gathering",
        "verification_status": "verified-reachable",
        "services": [
          {"port": 22, "protocol": "SSH"},
          {"port": 80, "protocol": "HTTP"}
        ],
        "user_annotations": [
          {"text": "VPN 入口", "created_at": "2026-10-09T...", "created_by": "user-id"}
        ],
        "position": {"x": 150, "y": 200}
      }
    }
  ],
  "edges": [
    {
      "id": "asset-1→asset-2:dependency",
      "source": "asset-1",
      "target": "asset-2",
      "data": {
        "relationship_type": "dependency",
        "protocol": "TCP",
        "port": 3306,
        "verified": true,
        "discovered_in_phase": "threat-modeling"
      }
    }
  ],
  "metadata": {
    "totalNodes": 42,
    "totalEdges": 128,
    "loadedAt": "2026-10-09T12:34:56Z"
  }
}
```

#### 更新拓扑元数据

```bash
POST /api/pentest/updateAssetTopologyMetadata
Content-Type: application/json

{
  "engagementId": "engagement-uuid",
  "updates": [
    {
      "assetId": "asset-uuid",
      "position": {"x": 300, "y": 450},
      "user_annotations": [
        {"text": "这个服务已验证漏洞 CVE-2024-1234"}
      ],
      "verification_status": "exploited"
    }
  ],
  "reason": "用户在拓扑面板标注"
}
```

响应：
```json
{
  "ok": true,
  "updated": 1,
  "audit_event_id": "audit-2026-10-09-..."
}
```

### 数据持久化

所有用户操作都被记录到数据库和审计账本：

| 操作 | 存储位置 | 审计记录 |
|------|---------|---------|
| 拖拽节点位置 | `assets.topology_metadata.position` | ✅ 记录 |
| 添加标注 | `assets.topology_metadata.user_annotations` | ✅ 记录 |
| 更新验证状态 | `assets.verification_status` | ✅ 记录 |

### 故障排除

**问题：拓扑图空白，没有节点**
- 检查：作业中是否有已发现的资产？
- 解决：先运行情报收集阶段获取资产

**问题：图布局混乱，节点重叠**
- 点击工具栏的"🔄 重新布局"重新应用力导向算法
- 或手工拖拽节点调整位置

**问题：标注保存失败**
- 检查网络连接
- 查看浏览器控制台是否有错误信息
- 确认用户对该作业有编辑权限

**问题：位置在刷新后没有保存**
- 确保点击"保存"（自动保存需要 500ms 后端同步）
- 检查数据库中 `topology_metadata` 列是否为 NULL

### 性能优化建议

- **大规模图**（> 200 节点）：
  - 使用过滤功能按阶段查看
  - 启用虚拟化渲染（计划 v0.2）

- **网络延迟**：
  - 标注保存有意延迟 500ms 批量提交
  - 位置变更在拖拽结束后保存

### 集成检查清单

- [ ] 迁移 028 已成功执行
- [ ] `asset_relationships` 表已创建
- [ ] Cytoscape.js 依赖已安装
- [ ] AssetTopologyPanel 组件已导入
- [ ] 控制台面板列表已更新
- [ ] 样式表已集成
- [ ] API 端点已注册
- [ ] 前端路由已配置
- [ ] 所有测试通过 ✅
- [ ] 本地测试正常工作

### 下一版本计划

**v0.2 (计划中)**
- 关系自动推导：从扫描结果推断资产依赖
- 攻击路径高亮：可视化利用链路
- 大图优化：> 500 节点的虚拟化渲染
- 图导出：PNG、SVG、PDF 格式

**v0.3+**
- 与报告系统集成
- 自定义节点样式
- 实时协作编辑（多用户标注同步）

---

## 相关文档

- [资产拓扑详细设计](./docs/asset-topology-design.md) - 完整的技术设计文档
- [实现状态报告](./docs/ASSET-TOPOLOGY-IMPLEMENTATION.md) - 交付物清单与集成指南
- [API 合约](./src/topology/types.ts) - TypeScript 类型定义

## 反馈与支持

如遇问题或有功能建议，请参考：
- 项目 GitHub Issues
- 内部文档 Wiki
- 社区讨论区
