/**
 * 面板域样式（放行队列 / 结论审阅 / 报告导出 / 交接 / skill 库 / 范围 / 记忆 / 向导 / 作业列表）。
 *
 * 规则见 `shell.ts` 顶部：只引用 `var(--pt-*)`，不出现字面颜色；紧凑写法 `选择器{属性:值}`。
 * 本文件由面板域负责，外壳与聊天域分别在 `shell.ts` / `chat.ts`。
 *
 * ── 这一域的三条排版纪律 ──
 *
 * 1. **闸门要看得见**：`__ack` / `__gate` / `__gates` / `__vote` 是人类必须做决定的地方，
 *    一律给实底色 + 3px 左侧状态条（天蓝＝确认、琥珀＝等待、红＝危险），
 *    与「普通说明文字」在静息态就能区分。
 * 2. **长标识不撑破布局**：命令用 `white-space:pre` + 横向滚动（命令不能断行——
 *    断在参数中间会让人核对错东西）；目标、哈希、引用标识、证据 id 用
 *    `overflow-wrap:anywhere`（无空格的长 token 必须能断）；正文块 `overflow-wrap:anywhere`。
 * 3. **键值读数成组**：`__summary` / `__stats` / `__meta` / `__counts` 全部用
 *    「1px 发丝线做格线」的网格（与外壳 `.pentest-runheader` 同一套读法）。
 */

export const PANELS_CSS = `
/* ═════════════════ 面板根容器（都只是若干 Card 的纵向堆叠） ═════════════════ */
.pentest-report-panel,.pentest-report-review,.pentest-scope,.pentest-memory-explorer,.pentest-skill-library{display:flex;flex-direction:column;gap:10px;min-width:0}
.pentest-report-panel>.pentest-card,.pentest-report-review>.pentest-card,.pentest-scope>.pentest-card,.pentest-memory-explorer>.pentest-card,.pentest-skill-library>.pentest-card{margin:0}

/* 读数网格：格线由容器底色（= 发丝线色）从 1px 间隙里透出来 */
.pentest-report-review__summary,.pentest-finding__meta,.pentest-report-export__summary,.pentest-handoff__stats,.pentest-scope__summary,.pentest-scope__counts,.pentest-memory-hit__meta,.pentest-skill-library__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(124px,1fr));gap:1px;background:var(--pt-line);border:1px solid var(--pt-line);min-width:0}

/* 端点缺口：读不到端点与读到了空集合是两件事，用等待色单独说 */
.pentest-approval__gap,.pentest-scope__gap,.pentest-report-review__gap,.pentest-report-export__gap,.pentest-memory-explorer__gap{margin:0;padding:7px 10px;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash);color:var(--pt-wait);font:400 11px/1.65 var(--pt-font-mono);overflow-wrap:anywhere}

/* 说明性正文（规则、提示、备注）：一律无衬线，等宽只留给标识与数字 */
.pentest-memory-explorer__hint,.pentest-skill-library__note,.pentest-skill-library__hint,.pentest-handoff__hint,.pentest-report-review__note{margin:0;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere;max-width:88ch}
.pentest-memory-explorer__hint,.pentest-skill-library__hint,.pentest-handoff__hint{color:var(--pt-fg-faint)}

/* ═════════════════ 放行队列（§10.3.1：批准的是那条即将执行的命令） ═════════════════ */
.pentest-approval__rule{margin:0 0 10px;padding:8px 10px 8px 12px;border-left:2px solid var(--pt-accent-dim);background:var(--pt-bg-well);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-approval__rule strong{color:var(--pt-fg)}

/* 会话内的放行条目（与队列共用同一套闸门与文案） */
.pentest-approval__row{display:flex;flex-direction:column;gap:8px;min-width:0;margin:0 0 10px;padding:10px 11px;border:1px solid var(--pt-line);border-left:3px solid var(--pt-wait-line);background:var(--pt-bg-module)}
.pentest-approval__row>.pentest-field{margin-bottom:0}
.pentest-approval__head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}

/* 目标：可能是一个长 URL / 长域名，必须能断 */
.pentest-approval__target{display:inline-block;max-width:100%;padding:2px 7px;border:1px solid var(--pt-hairline);background:var(--pt-bg-well);color:var(--pt-info);font:400 12px/1.5 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-approval__command-block{display:flex;flex-direction:column;gap:5px;min-width:0}


/* 命令展开/折叠控制：默认显示摘要，点击展开完整 */
.pentest-approval__command-details{cursor:pointer;width:100%;margin:0;padding:0;border:none;background:none}
.pentest-approval__command-details>summary{padding:2px 5px;border:1px solid var(--pt-hairline);background:var(--pt-bg-well);color:var(--pt-info);font:400 12px/1.5 var(--pt-font-mono);list-style-position:inside;user-select:none}
.pentest-approval__command-details>summary:hover{background:var(--pt-line);color:var(--pt-accent)}
.pentest-approval__command-details[open]>summary{border:1px solid var(--pt-line);background:var(--pt-accent-wash)}
.pentest-approval__command-details[open]>pre{margin-top:5px}
/* 命令：**完整折行显示**（人类要逐字核对这条命令，横向滚动等于让他漏读尾部）。
   折行会破坏"原样"的视觉，但比"看不全"安全；等宽字体与 pre-wrap 保证字符不被改写。 */
.pentest-approval__command{margin:0;max-width:100%;padding:9px 10px;border:1px solid var(--pt-line);background:var(--pt-bg-well);color:var(--pt-fg);font:400 12.5px/1.55 var(--pt-font-mono);white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:visible;box-shadow:var(--pt-well-shadow)}
.pentest-approval__limits{color:var(--pt-fg-faint);font:400 10.5px/1.5 var(--pt-font-mono);letter-spacing:.04em}
.pentest-approval__class{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
.pentest-approval__risk-tier{color:var(--pt-wait);font:600 10px/1.4 var(--pt-font-mono);letter-spacing:.14em;text-transform:uppercase}
.pentest-approval__impact{max-width:62ch;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.55;overflow-wrap:anywhere}

/* 凭证绑定：会话 / 目的 / 范围版本 / 申请时间——缺一项就说不清「批的是哪个范围的判断」 */
.pentest-approval__binding{display:flex;flex-direction:column;gap:3px;min-width:0;color:var(--pt-fg-dim);font-size:11.5px}
.pentest-approval__binding code{color:var(--pt-fg);font-family:var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-approval__purpose{line-height:1.5;overflow-wrap:anywhere}
.pentest-approval__scope-version{color:var(--pt-info);font:400 10.5px/1.5 var(--pt-font-mono);letter-spacing:.03em;overflow-wrap:anywhere}
.pentest-approval__asked{color:var(--pt-fg-faint);font:400 10.5px/1.5 var(--pt-font-mono)}
.pentest-approval__expiry{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;color:var(--pt-fg-dim);font-size:11.5px}
.pentest-approval__state-note{line-height:1.55;overflow-wrap:anywhere}
.pentest-approval__guidance{padding:5px 8px;border-left:2px solid var(--pt-wait-line);background:var(--pt-wait-wash);color:var(--pt-wait);line-height:1.55;overflow-wrap:anywhere}

/* 动作区：理由输入独占一行，三个决定按钮并排（不靠 display:block 一根根竖着排） */
.pentest-approval__actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;min-width:104px}
/* 表格里的三列都是标识/动作，不能被压成竖排单字：
   - 目标：标识符，不折行；
   - 命令：等宽 pre，完整折行显示（不再截到 40ch——那会让人核对不到命令尾部）；
   - 动作：三个按钮的容器给下限（按钮本身 nowrap，见 shell.ts）。 */
.pentest-approval__target{white-space:nowrap}
.pentest-approval__command{max-width:100%}
.pentest-table td:has(> .pentest-approval__actions){min-width:120px}
.pentest-approval__actions>.pentest-field{flex:1 1 100%;min-width:0}
.pentest-approval__actions>.pentest-approval__revision{flex:1 1 100%;min-width:0}
.pentest-approval__revision{padding:8px 10px;border:1px solid var(--pt-line);background:var(--pt-bg-well);color:var(--pt-fg-dim)}
.pentest-approval__revision>summary{cursor:pointer;color:var(--pt-fg-dim);font:500 10.5px/1.5 var(--pt-font-mono);letter-spacing:.1em;text-transform:uppercase}
.pentest-approval__revision>summary:hover{color:var(--pt-accent)}
.pentest-approval__revision[open]>summary{margin-bottom:8px;color:var(--pt-accent)}
.pentest-approval__revision-preview{margin:8px 0 0;padding:8px 10px;border:1px solid var(--pt-line-soft);background:var(--pt-bg-module);color:var(--pt-fg-dim);font:400 11px/1.6 var(--pt-font-mono);white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:auto}

/* ═════════════════ 结论审阅（§8.9 逐条处置） ═════════════════ */
.pentest-report-review__block{margin:0;padding:8px 10px;border:1px solid var(--pt-danger-line);border-left-width:3px;background:var(--pt-danger-wash);color:var(--pt-danger);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-report-review__superseded{margin:0;padding-left:9px;border-left:2px solid var(--pt-line);color:var(--pt-fg-faint);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-report-review__note{color:var(--pt-fg-dim)}
.pentest-report-review__agent-report{margin-top:9px;padding:8px 10px;border:1px solid var(--pt-line);background:var(--pt-bg-well);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-report-review__agent-report-head{margin:0 0 6px;color:var(--pt-fg-dim);font:400 11px/1.5 var(--pt-font-mono)}

.pentest-finding{display:flex;flex-direction:column;gap:8px;min-width:0}
.pentest-finding>.pentest-field{margin-bottom:0}
.pentest-finding__head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.pentest-finding__title{flex:1 1 220px;min-width:0;color:var(--pt-fg);font-size:13px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
.pentest-finding__asset,.pentest-finding__evidence{display:inline-block;max-width:100%;padding:1px 7px;border:1px solid var(--pt-hairline);background:var(--pt-bg-well);font:400 11px/1.7 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-finding__asset{color:var(--pt-info)}
.pentest-finding__evidence{color:var(--pt-fg-dim)}
.pentest-finding__missing{color:var(--pt-wait);font-size:11.5px;line-height:1.5}
.pentest-finding__steps{display:flex;flex-direction:column;gap:5px;margin:0;padding-left:20px;color:var(--pt-fg-dim);font-size:12.5px;line-height:1.6}
.pentest-finding__steps>li{padding-left:2px;overflow-wrap:anywhere}
.pentest-finding__steps>li::marker{color:var(--pt-accent-dim);font-family:var(--pt-font-mono)}
.pentest-finding__text{display:block;max-width:82ch;color:var(--pt-fg-dim);font-size:12.5px;line-height:1.65;overflow-wrap:anywhere}

/* 处置区：三选一决定的落点，必须自带底色与边界 */
.pentest-finding__dispose{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border:1px solid var(--pt-line);border-left:3px solid var(--pt-accent-line);background:var(--pt-bg-well)}
.pentest-finding__dispose>.pentest-field{margin-bottom:0}
.pentest-finding__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}

/* ═════════════════ 报告签字与导出（§8.9） ═════════════════ */
.pentest-report-export__signed{margin:0;padding:8px 10px;border:1px solid var(--pt-accent-line);background:var(--pt-accent-wash);color:var(--pt-accent);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.pentest-report-export__limitation{color:var(--pt-fg-dim);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.pentest-report-export__hint{max-width:88ch;margin:0;color:var(--pt-fg-faint);font-size:11px;line-height:1.6;overflow-wrap:anywhere}

.pentest-report-export__gates{display:flex;flex-direction:column;gap:8px;min-width:0}
/* 闸门清单（共享族，见 client/views/GateList.tsx）：人类决策点——实底 + 3px 左侧琥珀条。
   此前三组样式（report-export / handoff / engagement-list）各写一遍，视觉已经漂移。 */
.pentest-gate{display:flex;flex-direction:column;gap:5px;min-width:0;padding:9px 11px;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash)}
.pentest-gate__label{color:var(--pt-wait);font:600 10px/1.4 var(--pt-font-mono);letter-spacing:.14em;text-transform:uppercase}
.pentest-gate__items{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.pentest-gate__item{position:relative;padding-left:13px;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-gate__item::before{content:"▸";position:absolute;left:0;color:var(--pt-wait);font-size:10px}
.pentest-report-export__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}

/* 导出回执：与签字哈希比对用的读数 */
.pentest-report-export__result{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border:1px solid var(--pt-accent-line);background:var(--pt-accent-wash)}
.pentest-report-export__result>.pentest-report-export__hint{color:var(--pt-fg-dim)}

/* ═════════════════ 交接编辑（草稿 → 人工编辑 → 确认） ═════════════════ */
.pentest-handoff__notice{margin:0;padding:7px 10px;border-left:2px solid var(--pt-info);background:var(--pt-info-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-handoff__hash{margin:0;color:var(--pt-fg-faint);font:400 11px/1.6 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-handoff__hash code{color:var(--pt-info);overflow-wrap:anywhere}
.pentest-handoff__failure{margin:0;padding:7px 10px;border:1px solid var(--pt-danger-line);border-left-width:3px;background:var(--pt-danger-wash);color:var(--pt-danger);font:400 11px/1.6 var(--pt-font-mono);overflow-wrap:anywhere}

/* 块：交接编辑的六个部分各自成块，标题用等宽小节标签 */
.pentest-handoff__block{display:flex;flex-direction:column;gap:6px;min-width:0;margin:0 0 10px;padding:11px 12px;border:1px solid var(--pt-line);background:var(--pt-bg-panel)}
.pentest-handoff__block>.pentest-field{margin-bottom:0}
.pentest-handoff__block-title{margin:0;color:var(--pt-fg-dim);font:600 10.5px/1.3 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase}
.pentest-handoff__phases{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.pentest-handoff__text{margin:0;max-width:100%;padding:9px 11px;border:1px solid var(--pt-line);background:var(--pt-bg-well);color:var(--pt-fg);font:400 11.5px/1.65 var(--pt-font-mono);white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:auto}
.pentest-handoff__tags{display:flex;flex-wrap:wrap;align-items:center;gap:5px;color:var(--pt-fg-faint);font-size:11px}
.pentest-handoff__checks{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:2px}
.pentest-handoff__check{display:inline-flex;align-items:center;gap:5px;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.5;cursor:pointer;transition:color var(--pt-dur-fast) var(--pt-ease)}
.pentest-handoff__check:hover{color:var(--pt-fg)}
.pentest-handoff__check input{accent-color:var(--pt-accent);flex:0 0 auto}
.pentest-handoff__action{color:var(--pt-fg-dim);font-size:11.5px;line-height:1.5}
.pentest-handoff__action--neutral{color:var(--pt-fg-dim)}
.pentest-handoff__action--attention{color:var(--pt-wait)}
/* tone 由调用点的变量给出，五种都要有规则（闸门 npm run verify:styles 逐个核对）：
   交接动作按语义分色——active=正在做、done=已完成、danger=被拒/危险。 */
.pentest-handoff__action--active{color:var(--pt-accent)}
.pentest-handoff__action--done{color:var(--pt-accent-dim)}
.pentest-handoff__action--danger{color:var(--pt-danger)}

/* 「表决为空」：可空键的显式表决——不是普通勾选，给实底 */
.pentest-handoff__vote{display:flex;align-items:flex-start;gap:8px;min-width:0;padding:8px 10px;border:1px solid var(--pt-accent-line);background:var(--pt-accent-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.6;cursor:pointer;transition:border-color var(--pt-dur-fast) var(--pt-ease)}
.pentest-handoff__vote:hover{border-color:var(--pt-accent)}
.pentest-handoff__vote input{accent-color:var(--pt-accent);flex:0 0 auto;margin-top:2px}
.pentest-handoff__vote>span{min-width:0;overflow-wrap:anywhere}
.pentest-handoff__tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.pentest-handoff__tool{display:inline-flex;align-items:center;gap:4px;padding:2px 5px 2px 8px;border:1px solid var(--pt-line);background:var(--pt-bg-well);color:var(--pt-fg-dim)}
.pentest-handoff__ref{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.pentest-handoff__ref code{color:var(--pt-info);font:400 11px/1.5 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-handoff__ref>span{min-width:0;color:var(--pt-fg-dim);font-size:11.5px;overflow-wrap:anywhere}
.pentest-handoff__ref-detail{flex:1 0 100%;margin:0;padding:3px 0 3px 8px;border-left:2px solid var(--pt-line);color:var(--pt-fg-dim);font:400 11px/1.5 var(--pt-font-mono);overflow-wrap:anywhere;white-space:pre-wrap}
.pentest-handoff__ref-form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:6px;min-width:0}
.pentest-handoff__ref-form>*{flex:1 1 180px;min-width:0}
.pentest-handoff__ref-form>.pentest-button{flex:0 0 auto}

/* 差异表：草稿 vs 当前内容——变更过的那一侧才是要看的 */
.pentest-handoff__before{color:var(--pt-fg-faint);font-size:11.5px;line-height:1.55;overflow-wrap:anywhere}
.pentest-handoff__after{color:var(--pt-fg);font-size:11.5px;line-height:1.55;font-weight:500;overflow-wrap:anywhere}

/* 强制跳转：跨出推荐路径是高风险动作 */
.pentest-handoff__block--forced{border-color:var(--pt-danger-line);background:var(--pt-danger-wash)}
.pentest-handoff__block--forced .pentest-handoff__block-title{color:var(--pt-danger)}
.pentest-handoff__block--forced .pentest-handoff__vote{border-color:var(--pt-danger-line);background:transparent}
.pentest-handoff__block--forced .pentest-handoff__vote:hover{border-color:var(--pt-danger)}
.pentest-handoff__forced-summary{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border:1px dashed var(--pt-wait-line);background:var(--pt-bg-well)}

/* 闸门：单条闸门说明（琥珀）与危险闸门（红） */
.pentest-handoff__gate{margin:0;padding:7px 10px;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash);color:var(--pt-wait);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-handoff__gate--danger{border-color:var(--pt-danger-line);border-left-color:var(--pt-danger);background:var(--pt-danger-wash);color:var(--pt-danger)}

.pentest-handoff__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}

/* ═════════════════ 范围管理（§5.5 回环修订 + 历史版本） ═════════════════ */
.pentest-scope__rule{margin:0 0 10px;padding:8px 10px 8px 12px;border-left:2px solid var(--pt-accent-dim);background:var(--pt-bg-well);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-scope__rule strong{color:var(--pt-fg)}
.pentest-scope__target{display:inline-block;max-width:100%;padding:1px 7px;border:1px solid var(--pt-hairline);background:var(--pt-bg-well);color:var(--pt-fg);font:400 12px/1.7 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-scope__asset{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0}
.pentest-scope__asset code{min-width:0;color:var(--pt-fg);font:400 11.5px/1.5 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-scope__kind{padding:1px 5px;border:1px solid var(--pt-line);color:var(--pt-fg-faint);font:500 10px/1.5 var(--pt-font-mono);letter-spacing:.1em;text-transform:uppercase}
.pentest-scope__origin{display:flex;flex-direction:column;gap:2px;min-width:0}
.pentest-scope__origin>span{color:var(--pt-fg-dim);font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}
.pentest-scope__session{color:var(--pt-fg-faint);font:400 10.5px/1.5 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-scope__choices{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.pentest-scope__effect{display:block;min-width:0;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.55;overflow-wrap:anywhere}
.pentest-scope__consequence{margin:0;padding:8px 10px;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-scope__consequence strong{color:var(--pt-wait);font-family:var(--pt-font-mono)}
.pentest-scope__blockers{display:flex;flex-direction:column;gap:5px;margin:0;padding:9px 11px;list-style:none;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash)}
.pentest-scope__blockers>li{position:relative;padding-left:13px;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-scope__blockers>li::before{content:"▸";position:absolute;left:0;color:var(--pt-wait);font-size:10px}

/* ═════════════════ 记忆检索与命中（§8.6/§8.7） ═════════════════ */
.pentest-memory-explorer__times{display:flex;flex-wrap:wrap;gap:10px;min-width:0}
.pentest-memory-explorer__times>.pentest-field{flex:0 1 170px;margin-bottom:0;min-width:0}
.pentest-memory-explorer__watermark{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--pt-line);border:1px solid var(--pt-line);min-width:0}
.pentest-memory-explorer__watermark>.pentest-memory-explorer__lag{grid-column:1/-1}
.pentest-memory-explorer__lag{margin:0;padding:7px 10px;background:var(--pt-wait-wash);color:var(--pt-wait);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-memory-explorer__ledger{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
.pentest-memory-explorer__ledger-result{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--pt-line);border:1px solid var(--pt-line);min-width:0;width:100%}
.pentest-memory-explorer__ledger-problems{grid-column:1/-1;display:flex;flex-direction:column;gap:5px;margin:0;padding:9px 11px;list-style:none;border-top:1px solid var(--pt-danger-line);background:var(--pt-danger-wash)}
.pentest-memory-explorer__ledger-problems>li{position:relative;padding-left:13px;color:var(--pt-danger);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-memory-explorer__ledger-problems>li::before{content:"▸";position:absolute;left:0;font-size:10px}
.pentest-memory-explorer__ledger-head{grid-column:1/-1;padding:7px 10px;background:var(--pt-bg-well);font-family:var(--pt-font-mono)}

/* ═════════════════ 运行诊断（§15.5） ═════════════════ */
.pentest-diagnostics__actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
.pentest-diagnostics__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--pt-line);border:1px solid var(--pt-line);min-width:0}
.pentest-diagnostics__note{margin:0;color:var(--pt-fg-faint);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere;max-width:88ch}

/* 命中行：列表本身提供行底色与格线，这里只排内部结构 + 行 hover */
.pentest-memory-hit{display:flex;flex-direction:column;gap:7px;min-width:0}
.pentest-list__item:has(>.pentest-memory-hit){transition:background var(--pt-dur-fast) var(--pt-ease)}
.pentest-list__item:has(>.pentest-memory-hit):hover{background:var(--pt-hover)}
.pentest-memory-hit__head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.pentest-memory-hit__head>.pentest-stat{margin-left:auto;align-items:flex-end;text-align:right}
.pentest-memory-hit__reasoning{margin:0;padding:6px 9px;border-left:2px solid var(--pt-wait-line);background:var(--pt-wait-wash);color:var(--pt-wait);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-memory-hit__excerpt{max-width:92ch;margin:0;color:var(--pt-fg-dim);font-size:12px;line-height:1.65;overflow-wrap:anywhere}
.pentest-memory-hit__routes{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:0}
.pentest-memory-hit__citation{display:inline-block;max-width:100%;padding:2px 7px;border:1px solid var(--pt-hairline);background:var(--pt-bg-well);color:var(--pt-info);font:400 11px/1.6 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-memory-hit__detail{max-height:360px;margin:0;padding:9px 11px;border:1px solid var(--pt-line);background:var(--pt-bg-well);color:var(--pt-fg-dim);font:400 11.5px/1.65 var(--pt-font-mono);white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}

/* ═════════════════ 公共记忆（注入每一次新建会话） ═════════════════ */
.pentest-publicmemory__hint{margin:0;padding-left:9px;border-left:2px solid var(--pt-info);background:var(--pt-info-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere;padding-top:6px;padding-bottom:6px}
.pentest-publicmemory__gates{display:flex;flex-direction:column;gap:5px;margin:0;padding:9px 11px;list-style:none;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash)}
.pentest-publicmemory__gates>li{position:relative;padding-left:13px;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-publicmemory__gates>li::before{content:"▸";position:absolute;left:0;color:var(--pt-wait);font-size:10px}
.pentest-publicmemory__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.pentest-publicmemory__meta{margin:0;color:var(--pt-fg-faint);font:400 10.5px/1.5 var(--pt-font-mono);letter-spacing:.04em}

/* ═════════════════ skill 库（§2.2 可增 / 可改 / 可停用） ═════════════════ */
.pentest-skill-library__note{color:var(--pt-fg-dim)}
.pentest-skill-library__risk{margin:0;padding:8px 10px;border:1px solid var(--pt-danger-line);border-left-width:3px;background:var(--pt-danger-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-skill-library__undecided{margin:0;padding:7px 10px;border:1px dashed var(--pt-wait-line);background:var(--pt-wait-wash);color:var(--pt-wait);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-skill-library__name{color:var(--pt-fg);font:500 12.5px/1.5 var(--pt-font-mono)}
.pentest-skill-library__desc{display:inline-block;max-width:70ch;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-skill-library__adder,.pentest-skill-library__hash{display:inline-block;max-width:100%;margin-right:6px;vertical-align:middle;color:var(--pt-fg-faint);font:400 11px/1.6 var(--pt-font-mono);overflow-wrap:anywhere}
.pentest-skill-library__pick-name{color:var(--pt-fg);font:500 12px/1.5 var(--pt-font-mono)}
.pentest-skill-library__pick-desc{flex:1 1 260px;min-width:0;color:var(--pt-fg-faint);font-size:11px;line-height:1.55;overflow-wrap:anywhere}
/* 勾选装载的行：名称 + 描述 + 来源徽标要能换行，而不是挤成一条不换行的长行 */
.pentest-skill-library .pentest-list__item>.pentest-check{display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px 8px;width:100%}
.pentest-skill-library .pentest-list__item>.pentest-check>input{flex:0 0 auto;margin-top:3px}
.pentest-skill-library__hint{margin:0 0 6px}

/* ═════════════════ 作业列表 ═════════════════ */
.pentest-engagement-list__bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin:0 0 10px;min-width:0}
.pentest-engagement-list__bar>.pentest-field{flex:1 1 240px;margin:0;min-width:0}
.pentest-engagement-list__name{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.pentest-engagement-list__archived{display:inline-flex;align-items:center;gap:6px;color:var(--pt-fg-dim);font:400 11.5px/1.5 var(--pt-font-mono)}
.pentest-engagement-list__actions{display:inline-flex;gap:6px;align-items:center}
.pentest-engagement-list__error{margin:8px 0 0;color:var(--pt-danger);font:400 11.5px/1.6 var(--pt-font-mono)}
.pentest-engagement-list__purge-warn{margin:0;color:var(--pt-danger);font:400 11.5px/1.6 var(--pt-font-sans)}
.pentest-engagement-list__purge{margin:10px 0 0;border:1px solid var(--pt-danger-line);background:var(--pt-danger-wash);padding:10px;display:flex;flex-direction:column;gap:8px}
.pentest-engagement-list__purge-note{margin:0;color:var(--pt-fg-dim);font:400 11.5px/1.6 var(--pt-font-sans)}
.pentest-engagement-list__purge-actions{display:flex;gap:8px;align-items:center}
/* 名称是人写的标签，不是命令：在按钮外观之上还原正文排版，并允许折行 */
.pentest-engagement-list__name>.pentest-button{max-width:100%;font-family:var(--pt-font-sans);font-size:12px;font-weight:500;letter-spacing:.02em;text-transform:none;white-space:normal;text-align:left;overflow-wrap:anywhere}

/* ═════════════════ 新建作业向导 ═════════════════ */
.pentest-wizard{display:flex;flex-direction:column;gap:12px;min-width:0}
.pentest-wizard__section{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 12px;border:1px solid var(--pt-line);background:var(--pt-bg-panel)}
.pentest-wizard__section>.pentest-field{margin-bottom:0}
.pentest-wizard__section-title{margin:0;color:var(--pt-fg-dim);font:600 10.5px/1.3 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase}
.pentest-wizard__section-title::before{content:"▸";margin-right:6px;color:var(--pt-accent)}
.pentest-wizard__section-hint{margin:0;max-width:84ch;color:var(--pt-fg-faint);font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.pentest-wizard__notice{margin:0;padding:8px 10px;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;overflow-wrap:anywhere}
.pentest-wizard__done{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding:8px 10px;border:1px solid var(--pt-accent-line);background:var(--pt-accent-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}

/* 高级选项：默认折叠，展开后各字段恢复正常间距 */
.pentest-wizard__advanced{display:flex;flex-direction:column;gap:6px;min-width:0;padding:0 12px 12px;border:1px solid var(--pt-line);background:var(--pt-bg-well)}
.pentest-wizard__advanced>.pentest-field{margin-bottom:0}
.pentest-wizard__advanced-title{appearance:none;display:flex;align-items:center;gap:8px;width:auto;margin:0 -12px 4px;padding:9px 12px;border:0;border-bottom:1px solid var(--pt-line);background:transparent;color:var(--pt-fg-dim);font:500 10.5px/1.4 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase;text-align:left;cursor:pointer;transition:color var(--pt-dur-fast) var(--pt-ease),background var(--pt-dur-fast) var(--pt-ease)}
.pentest-wizard__advanced-title:hover{color:var(--pt-fg);background:var(--pt-hover)}
.pentest-wizard__advanced-title[aria-expanded="true"]{color:var(--pt-accent)}
.pentest-wizard__advanced-title>span[aria-hidden="true"]{color:var(--pt-accent)}
.pentest-wizard__advanced-title .pentest-wizard__section-hint{margin-left:auto;text-align:right;text-transform:none;letter-spacing:0;font-family:var(--pt-font-sans)}

/* 目标 / 排除项行编辑器：一行放下「类型 / 值 / 协议 / 端口 / 任意端口 / 删除」 */
.pentest-wizard__rows{display:flex;flex-direction:column;gap:6px;min-width:0;margin-top:2px}
.pentest-wizard__row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;padding:7px 8px;border:1px solid var(--pt-line);background:var(--pt-bg-well)}
.pentest-wizard__row>.pentest-select{flex:0 1 132px;min-width:0}
.pentest-wizard__row>.pentest-input{flex:1 1 170px;min-width:0}
.pentest-wizard__row>.pentest-button{flex:0 0 auto}
.pentest-wizard__protocols{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 10px;flex:1 1 210px;min-width:0}
.pentest-wizard__protocol{display:inline-flex;align-items:center;gap:4px;color:var(--pt-fg-dim);font-size:11px;cursor:pointer}
.pentest-wizard__protocol:hover{color:var(--pt-fg)}
.pentest-wizard__protocol input{accent-color:var(--pt-accent);flex:0 0 auto}
/* 「任意端口」是一次宽授权：给等待色，别让它看起来是个普通勾选 */
.pentest-wizard__anyport{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;padding:5px 8px;border:1px solid var(--pt-wait-line);background:var(--pt-wait-wash);color:var(--pt-wait);font-size:11px;line-height:1.4;white-space:nowrap;cursor:pointer}
.pentest-wizard__anyport input{accent-color:var(--pt-wait);flex:0 0 auto}
.pentest-wizard__anyport:hover{border-color:var(--pt-wait)}
.pentest-wizard__days{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.pentest-wizard__day{display:inline-flex;align-items:center;gap:4px;color:var(--pt-fg-dim);font-size:11.5px;cursor:pointer}
.pentest-wizard__day:hover{color:var(--pt-fg)}
.pentest-wizard__day input{accent-color:var(--pt-accent);flex:0 0 auto}
.pentest-wizard__window{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.pentest-wizard__window>.pentest-input{flex:0 1 118px;width:118px}

/* 规范化后的最终范围：提交前人类要核对的最后一屏 */
.pentest-wizard__preview{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 12px;border:1px solid var(--pt-accent-line);background:var(--pt-bg-well)}
.pentest-wizard__preview-title{margin:0;color:var(--pt-accent);font:600 10.5px/1.3 var(--pt-font-mono);letter-spacing:.12em;text-transform:uppercase}
.pentest-wizard__limits{margin:0;padding-top:6px;border-top:1px solid var(--pt-line-soft);color:var(--pt-fg-dim);font:400 11px/1.65 var(--pt-font-mono);overflow-wrap:anywhere}
/* 提交前的人类闸门：策略说明（信息紫）+ 确认勾选（天蓝实底、3px 左条，勾上后加辉光） */
.pentest-wizard__policy-note{margin:0;padding-left:9px;border-left:2px solid var(--pt-info);background:var(--pt-info-wash);color:var(--pt-fg-dim);font-size:11.5px;line-height:1.65;padding-top:6px;padding-bottom:6px;overflow-wrap:anywhere}
.pentest-wizard__ack{display:flex;align-items:flex-start;gap:9px;min-width:0;padding:10px 12px;border:1px solid var(--pt-accent-line);border-left-width:3px;background:var(--pt-accent-wash);color:var(--pt-fg);font-size:12px;line-height:1.6;cursor:pointer;transition:border-color var(--pt-dur-fast) var(--pt-ease),box-shadow var(--pt-dur-fast) var(--pt-ease)}
.pentest-wizard__ack:hover{border-color:var(--pt-accent)}
.pentest-wizard__ack:has(input:checked){border-color:var(--pt-accent);box-shadow:var(--pt-glow-accent)}
.pentest-wizard__ack input{accent-color:var(--pt-accent);flex:0 0 auto;margin-top:2px}
.pentest-wizard__ack>span{min-width:0;overflow-wrap:anywhere}

.pentest-wizard__gates{display:flex;flex-direction:column;gap:5px;margin:0;padding:9px 11px;list-style:none;border:1px solid var(--pt-wait-line);border-left-width:3px;background:var(--pt-wait-wash)}
.pentest-wizard__gates>li{position:relative;padding-left:13px;color:var(--pt-fg-dim);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-wizard__gates>li::before{content:"▸";position:absolute;left:0;color:var(--pt-wait);font-size:10px}
.pentest-wizard__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}

/* ═════════════════ 标识 ═════════════════ */
/*
 * pentest-client 在 DOM 里没有元素：它以插件标识（dsh-pentest-client）与日志前缀的形式出现，
 * 覆盖自检的正则把它算作「使用中」，因此这里保留一条无害规则（真的挂到元素上也只是统一数字对齐）。
 */
.pentest-client{font-variant-numeric:tabular-nums}
`;
