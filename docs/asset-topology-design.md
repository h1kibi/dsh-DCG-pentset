# 资产拓扑升级设计文档

## 1. 概述

将控制台的"资产清单"面板升级为交互式**资产拓扑图**，展示发现、验证和利用各阶段的资产依赖关系与通信链路。

### 目标
- 单一视图呈现全阶段融合的资产发现与关系
- 支持用户手工标注补充发现的依赖
- 按阶段和验证状态着色，快速识别攻击面

### 技术选型
- **图表库**：Cytoscape.js（API 简洁、力导向布局、交互丰富）
- **数据来源**：assets + asset_relationships（通过 memory_search 推导）
- **存储**：assets.topology_metadata (jsonb)

---

## 2. 数据模型

### 2.1 数据库扩展

**assets 表新增列**：
```sql
-- 拓扑相关元数据
topology_metadata JSONB DEFAULT '{}'
  -- {
  --   "position": { "x": 100, "y": 200 },  // 用户拖拽的坐标
  --   "user_annotations": [...],           // 用户添加的标注（如"这两个有 VPN"）
  --   "discovered_in_phase": "intelligence-gathering" | "threat-modeling" | ... | "post-exploitation",
  --   "verification_status": "unknown" | "verified-reachable" | "verified-unreachable" | "exploited",
  --   "last_annotation_at": "2026-10-09T...",
  --   "last_annotation_by": "user-id"
  -- }

-- 首次发现的阶段（冗余字段，用于快速查询和着色）
discovered_in_phase TEXT DEFAULT 'unknown'
  -- CHECK (discovered_in_phase IN ('unknown', 'intelligence-gathering', 'threat-modeling', 'vulnerability-analysis', 'exploitation', 'post-exploitation'))

-- 最后验证状态（冗余字段，用于快速着色）
verification_status TEXT DEFAULT 'unknown'
  -- CHECK (verification_status IN ('unknown', 'verified-reachable', 'verified-unreachable', 'exploited', 'candidate-path'))
```

**新建 asset_relationships 表**：
```sql
CREATE TABLE pentest.asset_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id UUID NOT NULL REFERENCES pentest.engagements(id),
  from_asset_id UUID NOT NULL REFERENCES pentest.assets(id),
  to_asset_id UUID NOT NULL REFERENCES pentest.assets(id),
  relationship_type TEXT NOT NULL
    -- CHECK (relationship_type IN ('dependency', 'communication-path', 'trust-relation', 'data-flow')),
  discovered_in_phase TEXT DEFAULT 'unknown',
  metadata JSONB DEFAULT '{}'
    -- { "protocol": "TCP", "port": 22, "verified": true, "note": "..." }
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (engagement_id, from_asset_id, to_asset_id, relationship_type)
);

-- 索引加速查询
CREATE INDEX idx_asset_relationships_engagement ON pentest.asset_relationships(engagement_id);
CREATE INDEX idx_asset_relationships_from_to ON pentest.asset_relationships(from_asset_id, to_asset_id);
```

### 2.2 节点（Node）结构

```typescript
interface AssetNode {
  id: string;           // asset.id
  label: string;        // IP 或主机名
  data: {
    assetId: string;
    canonicalTarget: string;    // 完整资产描述
    discovered_in_phase: string; // 着色: green/blue/yellow/red
    verification_status: string; // verified-reachable/unreachable/exploited
    services: { port: number; protocol: string }[];
    user_annotations: string[];
    position: { x: number; y: number } | null; // 用户拖拽的位置
  };
}
```

### 2.3 边（Edge）结构

```typescript
interface AssetEdge {
  id: string;           // "${from_id}→${to_id}:${type}"
  source: string;       // from_asset_id
  target: string;       // to_asset_id
  data: {
    relationship_type: 'dependency' | 'communication-path' | 'trust-relation';
    // 视觉效果由此决定:
    // - 'dependency' → 有向箭头
    // - 'communication-path' → 无向线
    // - 'trust-relation' → 虚线
    protocol?: string;
    port?: number;
    verified: boolean;   // 是否已验证可达
    user_note?: string;  // 用户标注（如"VPN"）
    discovered_in_phase?: string;
  };
}
```

---

## 3. 后端 API

### 3.1 `GET /api/pentest/getAssetTopology`

**请求**：
```json
{
  "engagementId": "...",
  "phases": ["intelligence-gathering", "threat-modeling"],  // 可选: 过滤阶段
  "verification_statuses": ["verified-reachable", "exploited"]  // 可选: 过滤状态
}
```

**响应**：
```json
{
  "ok": true,
  "nodes": [
    {
      "id": "asset-1",
      "label": "172.29.0.2",
      "data": {
        "assetId": "...",
        "canonicalTarget": "172.29.0.2:22/SSH",
        "discovered_in_phase": "intelligence-gathering",
        "verification_status": "verified-reachable",
        "services": [
          { "port": 22, "protocol": "SSH" },
          { "port": 80, "protocol": "HTTP" }
        ],
        "user_annotations": [],
        "position": null
      }
    },
    ...
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
    },
    ...
  ]
}
```

### 3.2 `POST /api/pentest/updateAssetTopologyMetadata`

**请求**：
```json
{
  "engagementId": "...",
  "updates": [
    {
      "assetId": "...",
      "position": { "x": 250, "y": 150 },
      "user_annotations": [
        { "text": "这个是 VPN 入口", "created_at": "2026-10-09T..." }
      ],
      "verification_status": "verified-reachable"
    }
  ]
}
```

**响应**：
```json
{
  "ok": true,
  "updated": 1,
  "audit_event_id": "..."
}
```

---

## 4. 前端组件

### 4.1 AssetTopologyPanel.tsx

主容器组件，负责：
- Cytoscape 图的初始化和样式配置
- 布局算法切换（力导向 ↔ 树形）
- 图的导出（PNG / SVG）

```typescript
export function AssetTopologyPanel(props: {
  controller: ConsoleController;
  snapshot: ConsoleSnapshot;
}): ReactNode {
  const { graph, nodes, edges, isLoading, error } = useAssetTopology(
    props.snapshot.selectedEngagementId,
  );

  return (
    <div className="pentest-asset-topology">
      <div className="pentest-asset-topology__toolbar">
        {/* 布局切换、导出、筛选 */}
      </div>
      <div
        ref={cytoContainerRef}
        className="pentest-asset-topology__container"
        style={{ flex: 1, minHeight: '500px' }}
      />
      <AssetDetailsSidebar
        selectedNode={selectedNode}
        onAnnotate={handleAnnotate}
      />
    </div>
  );
}
```

### 4.2 useAssetTopology() Hook

```typescript
interface UseAssetTopologyReturn {
  graph: cytoscape.Core | null;
  nodes: AssetNode[];
  edges: AssetEdge[];
  isLoading: boolean;
  error: Error | null;
  selectedNode: AssetNode | null;
  setSelectedNode: (node: AssetNode | null) => void;
  addAnnotation: (assetId: string, text: string) => Promise<void>;
  updatePosition: (assetId: string, x: number, y: number) => Promise<void>;
}

export function useAssetTopology(engagementId: string): UseAssetTopologyReturn {
  // 1. 获取拓扑数据
  // 2. 初始化 Cytoscape 实例
  // 3. 管理选中状态
  // 4. 处理拖拽和标注同步到后端
}
```

### 4.3 节点着色规则

```typescript
const nodeColorMap = {
  'intelligence-gathering': '#4CAF50',    // 绿
  'threat-modeling': '#2196F3',           // 蓝
  'vulnerability-analysis': '#FF9800',    // 橙
  'exploitation': '#FFC107',              // 黄
  'post-exploitation': '#F44336',         // 红
};

const verificationStatusIcon = {
  'verified-reachable': '✓',
  'verified-unreachable': '✗',
  'exploited': '⚡',
  'unknown': '?',
};
```

### 4.4 边的样式

```typescript
const edgeStyleFor = (edge: AssetEdge) => {
  const baseStyle = {
    'line-color': edge.data.verified ? '#4CAF50' : '#FFC107',
  };

  switch (edge.data.relationship_type) {
    case 'dependency':
      return { ...baseStyle, 'target-arrow-shape': 'triangle', 'curve-style': 'straight' };
    case 'communication-path':
      return { ...baseStyle, 'curve-style': 'straight' };
    case 'trust-relation':
      return { ...baseStyle, 'line-style': 'dashed' };
  }
};
```

---

## 5. 用户交互流程

### 5.1 查看拓扑

1. 用户打开控制台→选择"资产拓扑"面板
2. 系统加载该作业所有资产及其关系
3. Cytoscape 自动布局（力导向）
4. 节点按发现阶段着色

### 5.2 检查细节

1. 用户点击一个节点
2. 右侧弹窗展示：
   - 资产基本信息（IP、主机名、服务清单）
   - 发现历史（哪个阶段发现、什么时候）
   - 已验证状态
   - 用户标注列表
   - 关联漏洞数量

### 5.3 添加手工标注

1. 用户在弹窗里点击"添加标注"
2. 输入框弹出，输入标注内容（如"这两个之间有内部 VPN"）
3. 点击保存，标注存到数据库，图立即更新

### 5.4 调整布局

1. 用户拖拽节点到新位置
2. 位置实时保存到 `topology_metadata.position`
3. 下次打开图时自动恢复用户的布局

---

## 6. 实现步骤

### 阶段 1：准备（今天）
- [x] 需求确认（本文档）
- [ ] Figma mockup（UI/UX 视觉确认）
- [ ] 数据库迁移脚本

### 阶段 2：后端（明天）
- [ ] 执行数据库迁移
- [ ] 实现两个 API 端点
- [ ] 单元测试

### 阶段 3：前端（后天-第 5 天）
- [ ] AssetTopologyPanel 组件
- [ ] useAssetTopology hook
- [ ] 交互反馈和标注功能
- [ ] 端到端测试

### 阶段 4：集成验证
- [ ] 替换 AssetList 面板
- [ ] 导航菜单更新
- [ ] 文档更新
- [ ] 冷启动 + 用户场景测试

---

## 7. 验收标准

- [ ] 拓扑图正确显示所有资产和关系
- [ ] 节点着色按发现阶段正确显示
- [ ] 拖拽节点能保存位置并在刷新后恢复
- [ ] 用户标注能实时保存到数据库
- [ ] 性能：<100 个节点的图在 300ms 内完成渲染
- [ ] 访问控制：只显示该作业的资产
- [ ] 审计：所有标注操作记录到 human_decisions 表

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Cytoscape 布局算法在大图上性能差 | 200+ 节点时卡顿 | 虚拟化节点渲染（Cytoscape 1.3+）、后端分页 |
| 用户拖拽位置多次改变导致数据库膨胀 | 审计账本爆炸 | 只在用户显式保存时才写入，不要每拖拽都同步 |
| 数据库关系推导不准确 | 用户看到错误的依赖 | 优先显示"已验证"的边，未验证边用浅色/虚线 |
