/**
 * 外壳与基础组件：控制台这台"仪器"的面板、模块、仪表、按钮、表格与状态轨道。
 *
 * 约定（与 `panels.ts` / `chat.ts` 共享）：
 *   - 只引用 `var(--pt-*)`，不出现任何字面颜色（由测试断言）；
 *   - 紧凑写法 `选择器{属性:值}`，与仓库既有风格一致；
 *   - 辉光只给**活动**元素；静息态是平的；
 *   - 每个模块（`.pentest-card`）自带角标与标题栏，标题栏右侧用发丝线补满。
 */

export const SHELL_CSS = `
/* ───────────── 控制台根：暗底 + 扫描线 + 顶部渐晕 ───────────── */
.pentest-console{position:relative;background-color:var(--pt-bg-void);background-image:var(--pt-scanlines),var(--pt-vignette);color:var(--pt-fg);padding:12px 14px 56px;scroll-padding-bottom:56px}
.pentest-console--busy{opacity:.86}
/*
 * 主面板：宿主的中央列是 display:flex，我们的外框是它的 flex 子项。
 * 显式写 flex:1 1 auto + min-width:0 让面板占满中央列：
 *   - 不写 flex-grow 时宽度由内容决定，而我们的内容里有一张宽表——它可以把自己撑得
 *     极宽再被压缩，也可能像实测那样被压到只剩一条滚动条（那次真正的原因是基座层
 *     的滚动条规则漏到了根元素上，见 styles/base.ts 顶部；这里两条都写清楚，免得下次
 *     换个原因又踩同一处）；
 *   - min-width:0 是让收缩真正生效的前提（flex 子项的默认 min-width:auto 会拒绝收缩）。
 * 内边距由外框的 inline style 给（含为常驻状态条预留的 96px），这里不重复设。
 */
.pentest-mainpanel{flex:1 1 auto;min-width:0;height:100%;overflow:auto;background-color:var(--pt-bg-void);background-image:var(--pt-scanlines),var(--pt-vignette);color:var(--pt-fg);padding:0;scroll-padding-bottom:56px}

.pentest-panelbody{display:flex;flex-direction:column;gap:1px;animation:pt-boot var(--pt-dur-base) var(--pt-ease) both}
.pentest-panelbody>*+*{margin-top:0}

/* ───────────── 模块（卡片） ───────────── */
.pentest-card{position:relative;background:var(--pt-bg-module);border:1px solid var(--pt-line);border-radius:var(--pt-radius-sharp);padding:12px 14px 14px;margin:0 0 10px;animation:pt-boot var(--pt-dur-slow) var(--pt-ease) both}
.pentest-card::before,.pentest-card::after{content:"";position:absolute;width:9px;height:9px;border:1px solid var(--pt-accent-line);pointer-events:none}
.pentest-card::before{top:-1px;left:-1px;border-right:0;border-bottom:0}
.pentest-card::after{right:-1px;bottom:-1px;border-top:0;border-left:0}
.pentest-card__title{display:flex;align-items:center;gap:8px;margin:0 0 10px;font:600 10.5px/1.2 var(--pt-font-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--pt-fg-dim)}
.pentest-card__title::before{content:"▚";color:var(--pt-accent);font-size:10px;letter-spacing:0}
.pentest-card__title::after{content:"";flex:1;height:1px;background:var(--pt-line);min-width:12px}

/* ───────────── 面板切换 ───────────── */
.pentest-console__tabs{display:flex;flex-wrap:wrap;align-items:stretch;gap:0;margin:0 0 12px;border-bottom:1px solid var(--pt-line);position:sticky;top:0;z-index:3;background:var(--pt-bg-void)}
.pentest-console__tab{appearance:none;background:transparent;border:0;border-bottom:1px solid transparent;color:var(--pt-fg-faint);font:500 10.5px/1 var(--pt-font-mono);letter-spacing:.14em;text-transform:uppercase;padding:9px 12px 8px;cursor:pointer;transition:color var(--pt-dur-fast) var(--pt-ease),background var(--pt-dur-fast) var(--pt-ease)}
.pentest-console__tab:hover{color:var(--pt-fg);background:var(--pt-hover)}
.pentest-console__tab.is-active{color:var(--pt-accent);border-bottom-color:var(--pt-accent);text-shadow:var(--pt-glow-text)}
.pentest-console__tab:disabled,.pentest-console__tab[aria-disabled="true"]{color:var(--pt-fg-faint);opacity:.42;cursor:not-allowed;background:transparent;border-bottom-color:transparent;text-shadow:none}
/* 锁定的 tab 不再画逐字标记：七个都锁时那排「锁」字比信息还吵。原因在 tooltip
   与面板区的说明卡里各说一次（人hover 得到原因，不 hover 也不会误以为坏了）。 */

/* ───────────── 仪表（键值） ───────────── */
.pentest-runheader{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:1px;background:var(--pt-line);border:1px solid var(--pt-line)}
.pentest-stat{display:flex;flex-direction:column;gap:3px;background:var(--pt-bg-module);padding:8px 10px;min-width:0}
.pentest-stat__label{font:500 10px/1.2 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--pt-fg-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pentest-stat__value{font:400 13px/1.35 var(--pt-font-mono);color:var(--pt-fg);overflow-wrap:anywhere}
.pentest-stat--active .pentest-stat__value{color:var(--pt-accent);text-shadow:var(--pt-glow-text)}
.pentest-stat--done .pentest-stat__value{color:var(--pt-accent-dim)}
.pentest-stat--attention .pentest-stat__value{color:var(--pt-wait)}
.pentest-stat--danger .pentest-stat__value{color:var(--pt-danger)}
.pentest-stat--neutral .pentest-stat__value{color:var(--pt-fg-dim)}
.pentest-runheader__footnote{margin:10px 0 0;font:400 11px/1.5 var(--pt-font-mono);color:var(--pt-fg-faint);display:flex;gap:8px;align-items:center;flex-wrap:wrap}

/* ───────────── 状态胶囊（LED + 标签） ───────────── */
.pentest-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--pt-line);border-radius:var(--pt-radius-pill);padding:2px 8px;font:500 10px/1.5 var(--pt-font-mono);letter-spacing:.08em;color:var(--pt-fg-dim);white-space:nowrap}
.pentest-badge::before{content:"";width:5px;height:5px;background:currentColor;flex:0 0 5px}
.pentest-badge--neutral{color:var(--pt-fg-faint)}
.pentest-badge--active{color:var(--pt-accent);border-color:var(--pt-accent-line);box-shadow:var(--pt-glow-accent)}
.pentest-badge--done{color:var(--pt-accent-dim);border-color:var(--pt-line)}
.pentest-badge--attention{color:var(--pt-wait);border-color:var(--pt-wait-line);animation:pt-wait 2.4s var(--pt-ease) infinite}
.pentest-badge--danger{color:var(--pt-danger);border-color:var(--pt-danger-line);box-shadow:var(--pt-glow-danger)}

/* ───────────── 按钮 ───────────── */
.pentest-button{appearance:none;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--pt-line);border-radius:var(--pt-radius-sharp);background:transparent;color:var(--pt-fg-dim);font:500 10.5px/1 var(--pt-font-mono);letter-spacing:.1em;text-transform:uppercase;padding:7px 11px;cursor:pointer;white-space:nowrap;transition:color var(--pt-dur-fast) var(--pt-ease),border-color var(--pt-dur-fast) var(--pt-ease),background var(--pt-dur-fast) var(--pt-ease),box-shadow var(--pt-dur-fast) var(--pt-ease)}
.pentest-button:hover:not(.is-disabled){color:var(--pt-fg);border-color:var(--pt-accent-line);background:var(--pt-hover)}
.pentest-button:active:not(.is-disabled){background:var(--pt-press)}
.pentest-button--primary{color:var(--pt-accent);border-color:var(--pt-accent-line);background:var(--pt-accent-wash)}
.pentest-button--primary:hover:not(.is-disabled){color:var(--pt-bg-void);background:var(--pt-accent);border-color:var(--pt-accent);box-shadow:var(--pt-glow-accent)}
.pentest-button--secondary{color:var(--pt-fg-dim)}
.pentest-button.is-disabled,.pentest-button:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}

/* ───────────── 表单 ───────────── */
.pentest-field{display:flex;flex-direction:column;gap:4px;margin:0 0 9px;min-width:0}
.pentest-field__label{font:500 10.5px/1.3 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--pt-fg-faint)}
.pentest-field__hint{font-size:11px;line-height:1.5;color:var(--pt-fg-faint)}
.pentest-fieldgroup{display:flex;flex-direction:column;gap:6px;margin:0 0 9px}
.pentest-fieldgroup__options{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pentest-input,.pentest-textarea,.pentest-select{width:100%;background:var(--pt-bg-well);border:1px solid var(--pt-line);border-radius:var(--pt-radius-sharp);color:var(--pt-fg);padding:7px 9px;font:400 12.5px/1.5 var(--pt-font-sans);box-shadow:var(--pt-well-shadow);transition:border-color var(--pt-dur-fast) var(--pt-ease),box-shadow var(--pt-dur-fast) var(--pt-ease)}
.pentest-input::placeholder,.pentest-textarea::placeholder{color:var(--pt-fg-faint)}
.pentest-input:hover,.pentest-textarea:hover,.pentest-select:hover{border-color:var(--pt-accent-dim)}
.pentest-input:focus,.pentest-textarea:focus,.pentest-select:focus{outline:0;border-color:var(--pt-accent);box-shadow:var(--pt-glow-line)}
.pentest-textarea{resize:vertical;min-height:72px;font-family:var(--pt-font-sans)}
.pentest-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--pt-fg-dim)}
.pentest-check input,.pentest-fieldgroup input[type="checkbox"]{accent-color:var(--pt-accent);width:13px;height:13px}

/* ───────────── 表格与列表 ───────────── */
.pentest-table-wrap{overflow-x:auto;border:1px solid var(--pt-line);background:var(--pt-bg-module)}
.pentest-table{width:100%;border-collapse:collapse;font-size:12px}
.pentest-table th{position:sticky;top:0;background:var(--pt-bg-well);color:var(--pt-fg-faint);font:500 10px/1.4 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase;text-align:left;padding:7px 9px;border-bottom:1px solid var(--pt-line);white-space:nowrap}
.pentest-table td{padding:7px 9px;border-bottom:1px solid var(--pt-line-soft);vertical-align:top;color:var(--pt-fg-dim)}
.pentest-table tbody tr:hover td{background:var(--pt-hover);color:var(--pt-fg)}
/* 表格通用：**末列吸附在右侧**。
   实测问题：放行表格在 658px 的中央列里宽 1293px（命令与目标是长标识，不能折行），
   横向滚动时「操作」列会跑出视野——而那正是人类要做决定的地方。
   吸附后滚动只影响读取区，放行/拒绝/撤销始终可见。 */
.pentest-table th:last-child,.pentest-table td:last-child{position:sticky;right:0;background:var(--pt-bg-module);box-shadow:-1px 0 0 var(--pt-line)}
.pentest-table tbody tr:hover td:last-child{background:var(--pt-hover)}
.pentest-table tbody tr:last-child td{border-bottom:0}
.pentest-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:1px;background:var(--pt-line-soft)}
.pentest-list__item{background:var(--pt-bg-module);padding:9px 11px}

/* ───────────── 空态与错误 ───────────── */
.pentest-empty{display:flex;flex-direction:column;gap:6px;align-items:flex-start;border:1px dashed var(--pt-line);background:var(--pt-bg-well);padding:16px 18px}
.pentest-empty::before{content:"∅";font:400 16px/1 var(--pt-font-mono);color:var(--pt-accent-dim)}
.pentest-empty__title{font:500 12.5px/1.5 var(--pt-font-sans);color:var(--pt-fg-dim)}
.pentest-empty__reason{font-size:11.5px;line-height:1.6;color:var(--pt-fg-faint);max-width:68ch}
.pentest-error{display:flex;align-items:baseline;gap:9px;border:1px solid var(--pt-danger-line);border-left-width:3px;background:var(--pt-danger-wash);padding:8px 10px;margin:0 0 10px}
.pentest-error__code{font:500 10.5px/1.5 var(--pt-font-mono);letter-spacing:.08em;color:var(--pt-danger);white-space:nowrap}
.pentest-error__message{font-size:12px;color:var(--pt-fg-dim)}
/* tone 变体：ErrorBar 的第二参是运行时值，五种都要有规则（静态闸门
   npm run verify:styles 会逐个核对）。默认的 danger 也显式写出来——
   靠基类兜底会让「显式 --danger 没有规则」这件事在闸门里看不见。 */
.pentest-error--danger{border-color:var(--pt-danger-line);background:var(--pt-danger-wash)}
.pentest-error--danger .pentest-error__code{color:var(--pt-danger)}
.pentest-error--attention{border-color:var(--pt-wait-line);background:var(--pt-wait-wash)}
.pentest-error--attention .pentest-error__code{color:var(--pt-wait)}
.pentest-error--neutral{border-color:var(--pt-line);background:var(--pt-bg-well)}
.pentest-error--neutral .pentest-error__code{color:var(--pt-fg-dim)}
.pentest-error--active{border-color:var(--pt-accent-line);background:var(--pt-accent-wash)}
.pentest-error--active .pentest-error__code{color:var(--pt-accent)}
.pentest-error--done{border-color:var(--pt-accent-dim);background:var(--pt-accent-wash)}
.pentest-error--done .pentest-error__code{color:var(--pt-accent-dim)}

/* ───────────── 阶段轨道（状态机的空间表达） ───────────── */
.pentest-track{display:flex;align-items:stretch;overflow-x:auto;padding:4px 2px 12px;scrollbar-width:thin}
.pentest-track__node{flex:0 0 168px;display:flex;flex-direction:column;gap:6px;background:var(--pt-bg-module);border:1px solid var(--pt-line);border-radius:var(--pt-radius-sharp);padding:10px;position:relative;min-width:0}
.pentest-track__node::before{content:"";position:absolute;top:-1px;left:-1px;right:-1px;height:1px;background:var(--pt-line)}
.pentest-track__node--neutral{border-color:var(--pt-line)}
.pentest-track__node--done{border-color:var(--pt-accent-dim)}
.pentest-track__node--done::before{background:var(--pt-accent-dim)}
.pentest-track__node--current,.pentest-track__node--active{border-color:var(--pt-accent-line);box-shadow:var(--pt-glow-accent);animation:pt-boot var(--pt-dur-slow) var(--pt-ease) both}
.pentest-track__node--current::before,.pentest-track__node--active::before{background:var(--pt-accent)}
.pentest-track__node--attention{border-color:var(--pt-wait-line);animation:pt-wait 2.6s var(--pt-ease) infinite}
.pentest-track__node--danger{border-color:var(--pt-danger-line);animation:pt-alarm 2.2s var(--pt-ease) infinite}
.pentest-track__edge{flex:0 0 34px;display:flex;align-items:center;justify-content:center;position:relative;min-width:34px}
.pentest-track__edge::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px dashed var(--pt-fg-faint)}
.pentest-track__edge::after{content:"▸";position:absolute;right:-2px;top:50%;transform:translateY(-52%);font-size:9px;color:var(--pt-fg-faint);background:var(--pt-bg-void)}
.pentest-track__edge--pending::before{border-top:1px dotted var(--pt-line)}
.pentest-track__edge--neutral::before{border-top:1px dashed var(--pt-fg-faint)}
.pentest-track__edge--neutral::after{color:var(--pt-fg-faint)}
.pentest-track__edge--danger::before{border-top-style:solid;border-top-color:var(--pt-danger)}
.pentest-track__edge--danger::after{color:var(--pt-danger)}
.pentest-track__edge--active::before{border-top-style:solid;border-top-color:var(--pt-accent);box-shadow:var(--pt-glow-line)}
.pentest-track__edge--active::after{color:var(--pt-accent)}
.pentest-track__edge--handoff::before,.pentest-track__edge--retry::before{border-top-style:solid;border-top-color:var(--pt-info)}
.pentest-track__edge--handoff::after,.pentest-track__edge--retry::after{color:var(--pt-info)}
.pentest-track__loop{border:1px dashed var(--pt-info);border-radius:50% 50% 0 0/120% 120% 0 0;border-bottom:0;height:14px;margin:0 6px;align-self:flex-end;flex:0 0 44px}

/* ───────────── 会话内阶段条 ───────────── */
.pentest-phase-strip{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-family:var(--pt-font-mono);font-size:10.5px;letter-spacing:.08em;color:var(--pt-fg-faint)}
.pentest-phase-strip__step{border:1px solid var(--pt-line);padding:2px 7px;color:var(--pt-fg-faint)}
.pentest-phase-strip__step--done{color:var(--pt-accent-dim);border-color:var(--pt-line)}
.pentest-phase-strip__step--current{color:var(--pt-accent);border-color:var(--pt-accent-line);box-shadow:var(--pt-glow-accent)}
.pentest-phase-strip__step--pending{color:var(--pt-fg-faint);border-style:dotted}

/* ───────────── 会话时间轴 ───────────── */
.pentest-timeline{display:flex;flex-direction:column;gap:1px;background:var(--pt-line-soft);border:1px solid var(--pt-line)}
.pentest-timeline__row{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;background:var(--pt-bg-module);padding:9px 11px;border-left:2px solid transparent;transition:background var(--pt-dur-fast) var(--pt-ease),border-color var(--pt-dur-fast) var(--pt-ease)}
.pentest-timeline__row:hover{background:var(--pt-hover)}
.pentest-timeline__row.is-highlighted{border-left-color:var(--pt-accent);background:var(--pt-accent-wash)}
.pentest-timeline__row--orphan{border-left-color:var(--pt-wait);border-left-style:dashed}
.pentest-timeline__row--filtered{opacity:.5}
.pentest-timeline__time,.pentest-timeline__note-source{font:400 10.5px/1.4 var(--pt-font-mono);color:var(--pt-fg-faint)}
.pentest-timeline__note{font-size:11.5px;color:var(--pt-fg-dim)}
.pentest-minimap{display:flex;align-items:center;gap:8px}
.pentest-minimap__blocks{display:flex;gap:2px;align-items:flex-end;height:14px}
.pentest-minimap__block{width:6px;height:8px;background:var(--pt-line);border:1px solid var(--pt-line)}
.pentest-minimap__block--done{background:var(--pt-accent-dim);border-color:var(--pt-accent-dim)}
.pentest-minimap__block--attention{background:var(--pt-wait);border-color:var(--pt-wait)}
.pentest-minimap__alert{color:var(--pt-wait);font:500 10px/1 var(--pt-font-mono);letter-spacing:.08em}

/* ───────────── 运行控制 ───────────── */
.pentest-runcontrols{display:flex;flex-direction:column;gap:10px}
.pentest-runcontrols__mode{border:1px solid var(--pt-line);padding:10px;display:flex;flex-direction:column;gap:8px}
.pentest-runcontrols__mode-current{margin:0;font:400 11.5px/1.5 var(--pt-font-mono);color:var(--pt-fg-dim)}
.pentest-phasechoice{display:flex;flex-wrap:wrap;gap:6px}
.pentest-phasechoice__item{appearance:none;background:var(--pt-bg-well);border:1px solid var(--pt-line);color:var(--pt-fg-dim);font:500 10.5px/1 var(--pt-font-mono);letter-spacing:.1em;text-transform:uppercase;padding:8px 10px;cursor:pointer;transition:all var(--pt-dur-fast) var(--pt-ease)}
.pentest-phasechoice__item:hover{border-color:var(--pt-accent-line);color:var(--pt-fg)}
.pentest-phasechoice__item.is-active{color:var(--pt-accent);border-color:var(--pt-accent);background:var(--pt-accent-wash);box-shadow:var(--pt-glow-accent)}
.pentest-runcontrols__notice{border:1px solid var(--pt-wait-line);background:var(--pt-wait-wash);color:var(--pt-wait);padding:7px 10px;font-size:11.5px}
.pentest-runcontrols__failure{border:1px solid var(--pt-danger-line);background:var(--pt-danger-wash);color:var(--pt-danger);padding:7px 10px;font-size:11.5px}

/* ───────────── 阶段轨道：节点内部 ───────────── */
.pentest-track__node:disabled{color:inherit;opacity:1;cursor:default}
.pentest-track__node:not(:disabled){cursor:pointer}
.pentest-track__node:not(:disabled):hover{border-color:var(--pt-accent-line);background:var(--pt-hover)}
.pentest-track__node-label{font:600 11px/1.3 var(--pt-font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--pt-fg);display:block}
.pentest-track__node-meta{display:flex;flex-wrap:wrap;gap:4px}
.pentest-track__node-note{display:block;font-size:11px;line-height:1.5;color:var(--pt-fg-faint)}
.pentest-track__node-note-source,.pentest-track__node-note-time{font:400 10px/1.4 var(--pt-font-mono);color:var(--pt-fg-faint);font-style:normal;margin-left:4px}
.pentest-track__node-live{font:500 10px/1 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--pt-accent);display:inline-flex;align-items:center;gap:5px}
.pentest-track__node-live::before{content:"";width:6px;height:6px;background:var(--pt-accent);animation:pt-blink 1.4s steps(1,end) infinite}
.pentest-track__edge-label{position:absolute;top:calc(50% + 4px);left:50%;transform:translateX(-50%);background:var(--pt-bg-void);padding:0 4px;font:400 9.5px/1 var(--pt-font-mono);letter-spacing:.06em;color:var(--pt-fg-faint);white-space:nowrap}
.pentest-track__edge--active .pentest-track__edge-label{color:var(--pt-accent)}
.pentest-track__edge--attention .pentest-track__edge-label{color:var(--pt-wait)}
.pentest-track__edge--done .pentest-track__edge-label{color:var(--pt-accent-dim)}
.pentest-track__loop{align-items:flex-end;justify-content:center;display:flex;padding-bottom:2px}
.pentest-track__loop-label{font:400 10px/1.2 var(--pt-font-mono);letter-spacing:.05em;color:var(--pt-info);background:var(--pt-bg-void);padding:0 6px;white-space:nowrap}

/* ───────────── 会话时间轴：工具条与行 ───────────── */
.pentest-timeline__controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 9px}
.pentest-timeline__controls .pentest-input{flex:1 1 220px;width:auto}
.pentest-timeline__follow{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--pt-fg-dim);white-space:nowrap}
.pentest-timeline__filtered{font:400 10.5px/1.4 var(--pt-font-mono);color:var(--pt-wait)}
.pentest-timeline__axis{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--pt-line);padding:0 2px 3px;margin:0 0 9px}
.pentest-timeline__tick{font:400 10px/1 var(--pt-font-mono);color:var(--pt-fg-faint)}
.pentest-timeline__card{display:flex;flex-direction:column;gap:5px;width:100%;text-align:left;background:transparent;border:0;border-left:2px solid var(--pt-line);padding:8px 10px;color:inherit;font-family:inherit;cursor:pointer;transition:background var(--pt-dur-fast) var(--pt-ease),border-color var(--pt-dur-fast) var(--pt-ease)}
.pentest-timeline__card:disabled{cursor:default;opacity:1;color:inherit}
.pentest-timeline__card:not(:disabled):hover{background:var(--pt-hover)}
.pentest-timeline__card--neutral{border-left-color:var(--pt-line)}
.pentest-timeline__card--active{border-left-color:var(--pt-accent);box-shadow:inset 2px 0 0 var(--pt-accent-line)}
.pentest-timeline__card--done{border-left-color:var(--pt-accent-dim)}
.pentest-timeline__card--attention{border-left-color:var(--pt-wait)}
.pentest-timeline__card--danger{border-left-color:var(--pt-danger)}
.pentest-timeline__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pentest-timeline__status{font:500 10.5px/1 var(--pt-font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--pt-fg-dim)}
.pentest-timeline__time{font:400 10.5px/1 var(--pt-font-mono);color:var(--pt-fg-faint)}
.pentest-timeline__note{font-size:11.5px;line-height:1.55;color:var(--pt-fg-dim)}
.pentest-timeline__note-source{font:400 10px/1.4 var(--pt-font-mono);color:var(--pt-fg-faint);font-style:normal}
.pentest-timeline__orphan{font:400 10.5px/1.5 var(--pt-font-mono);color:var(--pt-wait)}
.pentest-timeline__orphan--attention{color:var(--pt-wait)}
.pentest-timeline__orphan--neutral{color:var(--pt-fg-faint)}
.pentest-timeline__origin{font:400 10px/1.4 var(--pt-font-mono);color:var(--pt-info)}
.pentest-timeline__foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font:400 10px/1.4 var(--pt-font-mono);color:var(--pt-fg-faint)}
.pentest-timeline__id{font:500 10px/1.4 var(--pt-font-mono);color:var(--pt-fg-dim);letter-spacing:.06em}
.pentest-timeline__range{font:400 10px/1.4 var(--pt-font-mono);color:var(--pt-fg-faint)}

/* ───────────── 迷你地图 ───────────── */
.pentest-minimap{display:flex;flex-wrap:wrap;gap:14px;align-items:center;border:1px solid var(--pt-line);background:var(--pt-bg-well);padding:8px 10px;margin:0 0 10px}
.pentest-minimap__group{display:flex;align-items:center;gap:7px}
.pentest-minimap__label{display:inline-flex;align-items:center;gap:6px;font:400 10px/1 var(--pt-font-mono);color:var(--pt-fg-faint)}
.pentest-minimap__alert{font:500 9.5px/1 var(--pt-font-mono);color:var(--pt-wait);font-style:normal;letter-spacing:.06em}
.pentest-minimap__block{appearance:none;width:7px;height:9px;padding:0;border:1px solid var(--pt-line);background:var(--pt-line);cursor:pointer;transition:transform var(--pt-dur-fast) var(--pt-ease),border-color var(--pt-dur-fast) var(--pt-ease)}
.pentest-minimap__block:hover{transform:scaleY(1.4);border-color:var(--pt-accent);background:var(--pt-accent)}
.pentest-minimap__block--active{background:var(--pt-accent);border-color:var(--pt-accent);box-shadow:var(--pt-glow-accent)}
.pentest-minimap__block--done{background:var(--pt-accent-dim);border-color:var(--pt-accent-dim)}
.pentest-minimap__block--attention{background:var(--pt-wait);border-color:var(--pt-wait)}
.pentest-minimap__block--danger{background:var(--pt-danger);border-color:var(--pt-danger)}
.pentest-minimap__block--neutral{background:var(--pt-line)}

/* ───────────── 运行控制：分段 ───────────── */
.pentest-runcontrols__status{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pentest-runcontrols__start{display:flex;flex-direction:column;gap:9px;border:1px solid var(--pt-line);background:var(--pt-bg-well);padding:10px}
.pentest-runcontrols__budget{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px}
/* 动作区：按生命周期分区（运行期 / 阶段 / 危险 / 预算）。此前 __actions 没有任何样式，
   于是按钮与预算格挤成一段文字流——2026-10-08 人类截图报障的正是这个。 */
.pentest-runcontrols__actions{display:flex;flex-direction:column;gap:10px}
.pentest-runcontrols__row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
/* 行内元素**不伸缩**：否则按钮被拉成等宽条，一行里只剩几个空荡的长方块。 */
.pentest-runcontrols__row>*{flex:0 0 auto}
.pentest-runcontrols__zone--run{border-color:var(--pt-line-strong)}
.pentest-runcontrols__zone{display:flex;flex-direction:column;gap:6px;border:1px solid var(--pt-line);padding:9px 10px}
.pentest-runcontrols__zone-title{margin:0;font:500 10.5px/1 var(--pt-font-mono);letter-spacing:.09em;text-transform:uppercase;color:var(--pt-fg-dim)}
.pentest-runcontrols__zone--danger{border-color:var(--pt-danger-line);background:var(--pt-danger-wash)}
.pentest-runcontrols__zone--danger .pentest-runcontrols__zone-title{color:var(--pt-danger)}
.pentest-runcontrols__zone--budget .pentest-runcontrols__budget{grid-template-columns:repeat(auto-fit,minmax(128px,1fr)) auto;align-items:end}
.pentest-runcontrols__meta{margin:0;font:400 11px/1.6 var(--pt-font-mono);color:var(--pt-fg-dim)}
.pentest-runcontrols__gates{list-style:none;display:flex;flex-direction:column;gap:4px;padding:0;margin:0;font-size:11.5px;color:var(--pt-fg-faint)}
.pentest-runcontrols__gates li::before{content:"›";color:var(--pt-accent-dim);margin-right:6px}
.pentest-runcontrols__actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px solid var(--pt-line);padding-top:10px}
.pentest-runcontrols__hint{font-size:11px;line-height:1.55;color:var(--pt-fg-faint);max-width:72ch}

/* ───────────── 常驻状态条（宿主 overlay） ───────────── */
.pentest-statusbar{display:inline-flex;align-items:center;gap:10px;background:var(--pt-bg-module);border:1px solid var(--pt-line);border-radius:var(--pt-radius-pill);padding:6px 14px;color:var(--pt-fg-dim);box-shadow:var(--pt-veil) 0 6px 18px;cursor:pointer;font-family:var(--pt-font-mono);font-size:11px;letter-spacing:.04em;transition:border-color var(--pt-dur-fast) var(--pt-ease),color var(--pt-dur-fast) var(--pt-ease)}
.pentest-statusbar:hover{border-color:var(--pt-accent-line);color:var(--pt-fg)}
.pentest-statusbar__title{color:var(--pt-fg);font-weight:500;letter-spacing:.06em}
.pentest-statusbar__hint{color:var(--pt-fg-faint);white-space:nowrap}
.pentest-statusbar__mode{border:1px solid var(--pt-line);background:transparent;color:var(--pt-info);font:500 11px/1.5 var(--pt-font-mono);padding:1px 6px;cursor:pointer;white-space:nowrap}
.pentest-statusbar__mode:hover{border-color:var(--pt-info)}
.pentest-statusbar__mode:disabled{opacity:.55;cursor:progress}
.pentest-statusbar__mode-error{color:var(--pt-danger);font:400 11px/1.5 var(--pt-font-mono)}
/* tone 修饰词是**运行时拼出来**的（toneClass('pentest-statusbar', tone)），静态扫描
   看不见它——运行期的样式覆盖自检抓到过一次缺失，这条就是补的那一格。 */
.pentest-statusbar--neutral{border-color:var(--pt-line)}
.pentest-statusbar--done{border-color:var(--pt-accent-dim)}
.pentest-statusbar--active{border-color:var(--pt-accent-line);box-shadow:var(--pt-glow-accent)}
.pentest-statusbar--active::before{content:"";width:6px;height:6px;background:var(--pt-accent);box-shadow:var(--pt-glow-text);animation:pt-blink 1.6s steps(1,end) infinite}
.pentest-statusbar--attention{border-color:var(--pt-wait-line);box-shadow:var(--pt-glow-wait);animation:pt-wait 2.6s var(--pt-ease) infinite}
.pentest-statusbar--attention .pentest-statusbar__title{color:var(--pt-wait)}
.pentest-statusbar--danger{border-color:var(--pt-danger-line);box-shadow:var(--pt-glow-danger);animation:pt-alarm 2.2s var(--pt-ease) infinite}
.pentest-statusbar--danger .pentest-statusbar__title{color:var(--pt-danger)}
`;
