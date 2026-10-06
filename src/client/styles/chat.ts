/**
 * 会话域样式：intake 对话、只读 Agent 轨迹、消息流与待确认范围方案。
 *
 * 规则见 `shell.ts` 顶部：只引用 `var(--pt-*)`，不出现字面颜色。
 *
 * ── 这一域的三条硬要求（都对应实测过的坏结果）──
 *
 *   1. **长输出不能拉爆对话流**：工具调用与结果的正文是命令与 JSON，一行可能几百字符，
 *      系统提示词一次几 KB。因此 tool 正文走「等宽 + `white-space:pre` + 横向滚动 +
 *      `max-height` 内凹井」，system 正文（思考 / 系统提示词）同样封顶。
 *   2. **消息是「标签行 + 正文」两级**：标签回答**谁在说**（等宽小号 + 角色色），
 *      正文回答**说了什么**。角色色：human 信息紫、agent 天蓝、system 灰、tool 琥珀。
 *   3. **方案确认卡片是人类闸门**：它必须强于普通信息块——琥珀描边 + 标题栏 + 勾选区，
 *      按钮栏右对齐、主按钮在前。
 *
 * ── 一处做不到的事（不新增标记就无解）──
 *
 * 「正文里命令与 JSON 用等宽、中文走 sans」只能按**角色**分，不能按**内容**分：正文是
 * 单个 `<pre>` 文本节点（`projectTranscript` / `traceTranscript` 不做行内标记），没有
 * `<code>` 片段可供选择器挂载。于是 human / agent / system 正文用 sans，tool 正文整块用
 * `var(--pt-font-mono)`。
 *
 * ── 两处 `:has()` ──
 *
 * 方案卡片与勾选区的禁用态需要「由子元素反推父元素」，而这两个组件由共享的 `Card`
 * 与原生 `<label><input>` 产出，没有可挂载的状态类。`:has()` 取不到时只是少一层强调，
 * 可读性不受影响（Chromium 105+ 可用）。
 */

export const CHAT_CSS = `
/* ───────────── 落点根：插件在会话页/页签里的三个入口 ───────────── */
.pentest-intake,.pentest-chat-card,.pentest-trace{position:relative;background-color:var(--pt-bg-void);background-image:var(--pt-scanlines),var(--pt-vignette);color:var(--pt-fg)}

/* ───────────── 工具栏（对话与轨迹共用同一套） ───────────── */
.pentest-session-chat__bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 9px;padding:0 0 9px;border-bottom:1px solid var(--pt-line)}
.pentest-session-chat__bar>.pentest-badge{flex:0 0 auto;max-width:100%}
.pentest-session-chat__stamp{margin-left:auto;font:400 10.5px/1.4 var(--pt-font-mono);color:var(--pt-fg-faint);white-space:nowrap}
.pentest-session-chat__intro{margin:0 0 9px;font-size:11.5px;line-height:1.7;color:var(--pt-fg-faint);max-width:78ch}
.pentest-session-chat__intro strong{color:var(--pt-wait);font-weight:500}

/* ───────────── 对话流（内凹井 + 自己的滚动条） ───────────── */
.pentest-session-chat{display:flex;flex-direction:column;gap:2px;background:var(--pt-bg-well);border:1px solid var(--pt-line);box-shadow:var(--pt-well-shadow);padding:8px;min-height:132px;max-height:min(56vh,520px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin}
.pentest-session-chat>.pentest-empty{margin:auto 0}

/* ───────────── 消息：标签行 + 正文 ───────────── */
.pentest-msg{display:flex;flex-direction:column;gap:3px;min-width:0;max-width:100%;background:var(--pt-bg-module);border-left:2px solid var(--pt-line);padding:7px 10px 8px;animation:pt-boot var(--pt-dur-base) var(--pt-ease) both}
.pentest-msg__label{font:500 10px/1.35 var(--pt-font-mono);letter-spacing:.06em;color:var(--pt-fg-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pentest-msg__body{margin:0;min-width:0;max-width:100%;font:400 12px/1.7 var(--pt-font-sans);color:var(--pt-fg-dim);white-space:pre-wrap;overflow-wrap:anywhere;transition:color var(--pt-dur-fast) var(--pt-ease)}
.pentest-msg:hover .pentest-msg__body{color:var(--pt-fg)}

/* human：信息青——人自己说的话要一眼找到 */
.pentest-msg--human{border-left-color:var(--pt-info);background:var(--pt-info-wash)}
.pentest-msg--human .pentest-msg__label{color:var(--pt-info)}
.pentest-msg--human .pentest-msg__body{color:var(--pt-fg)}

/* agent：天蓝——正在与你对话的那一个 */
.pentest-msg--agent{border-left-color:var(--pt-accent-line)}
.pentest-msg--agent .pentest-msg__label{color:var(--pt-accent);text-shadow:var(--pt-glow-text)}
.pentest-msg--agent .pentest-msg__body{color:var(--pt-fg)}

/* system：灰、安静——思考、系统提示词、回合结束这类运行事件 */
.pentest-msg--system{border-left-color:var(--pt-line);background:var(--pt-bg-well)}
.pentest-msg--system .pentest-msg__label{color:var(--pt-fg-faint)}
.pentest-msg--system .pentest-msg__body{font-size:11.5px;color:var(--pt-fg-faint);background:var(--pt-bg-well);border:1px solid var(--pt-line-soft);padding:7px 9px;max-height:240px;overflow:auto;scrollbar-width:thin}

/* tool：琥珀 + 内凹井——命令与 JSON 原样铺开，横向滚动，绝不撑破容器 */
.pentest-msg--tool{border-left-color:var(--pt-wait-line)}
.pentest-msg--tool .pentest-msg__label{color:var(--pt-wait)}
.pentest-msg--tool .pentest-msg__body{font:400 11.5px/1.6 var(--pt-font-mono);font-variant-ligatures:none;color:var(--pt-fg-dim);white-space:pre;background:var(--pt-bg-well);border:1px solid var(--pt-line-soft);box-shadow:var(--pt-well-shadow);padding:8px 10px;max-height:300px;overflow:auto;scrollbar-width:thin}

/* ───────────── 输入区（记录流**之后**的普通兄弟，不吸附） ─────────────
 *
 * 这里曾经是 position:sticky;bottom:0：想让它「滚动时留在视野里」，但它的最近滚动祖先
 * 不是记录流（.pentest-session-chat 是**兄弟**，不是祖先），而是外层主面板——
 * 于是它脱离原位、悬在面板底部，随面板滚动在会话记录之间穿梭（实机观察到的现象，
 * 2026-10-04 人类报障）。
 *
 * 记录流自己有 max-height + overflow-y:auto：翻记录只动记录流内部，
 * 输入框作为其后的兄弟**原地不动**；要留在视野里的是记录流，不是输入框。
 */
.pentest-session-chat__composer{display:flex;flex-direction:column;align-items:flex-end;gap:8px;margin:10px 0 0;padding:10px 0 0;border-top:1px solid var(--pt-line);transition:border-color var(--pt-dur-fast) var(--pt-ease)}
.pentest-session-chat__composer:focus-within{border-top-color:var(--pt-accent-line)}
.pentest-session-chat__composer>.pentest-field{width:100%;margin:0}
.pentest-session-chat__composer .pentest-textarea{min-height:64px}
.pentest-session-chat__composer .pentest-button{min-width:140px;justify-content:center}

/* ───────────── 错误（会话操作失败 / 范围确认失败） ───────────── */
.pentest-session-chat__error{margin:10px 0 0;border:1px solid var(--pt-danger-line);border-left-width:3px;background:var(--pt-danger-wash);color:var(--pt-danger);padding:7px 10px;font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}

/* ───────────── 待确认范围方案：人类闸门，比普通信息块强 ───────────── */
.pentest-card:has(>.pentest-proposal__ack){border-color:var(--pt-wait-line);box-shadow:var(--pt-glow-wait)}
.pentest-proposal__meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 9px}
.pentest-proposal__value{font-family:var(--pt-font-mono);font-size:11.5px;color:var(--pt-info);overflow-wrap:anywhere}
.pentest-proposal__exclusions{margin:8px 0 0;padding-left:9px;border-left:2px solid var(--pt-wait-line);font:400 11.5px/1.7 var(--pt-font-mono);color:var(--pt-fg-dim);overflow-wrap:anywhere}
.pentest-proposal__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0 0;font-size:11.5px;line-height:1.7;color:var(--pt-fg-dim);overflow-wrap:anywhere}
.pentest-proposal__actions>.pentest-button:first-child{margin-left:auto}
.pentest-proposal__note{margin:7px 0 0;font-size:11.5px;line-height:1.7;color:var(--pt-fg-faint);overflow-wrap:anywhere}
.pentest-proposal__error{margin:7px 0 0;border:1px solid var(--pt-danger-line);background:var(--pt-danger-wash);color:var(--pt-danger);padding:7px 10px;font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
.pentest-proposal__pacing{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:1px;background:var(--pt-line);border:1px solid var(--pt-line);margin:8px 0 0}
.pentest-proposal__preview-meta{margin:0 0 8px;font:400 11px/1.6 var(--pt-font-mono);color:var(--pt-fg-faint);overflow-wrap:anywhere}
.pentest-proposal__preview-blockers{margin:0 0 9px;border:1px solid var(--pt-danger-line);border-left-width:3px;background:var(--pt-danger-wash);padding:8px 10px}
.pentest-proposal__preview-blockers p{margin:0;font-size:11.5px;line-height:1.6;color:var(--pt-fg-dim)}
.pentest-proposal__preview-blockers ul{margin:6px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:4px}
.pentest-proposal__preview-blockers li{font-size:11.5px;line-height:1.6;color:var(--pt-danger)}

/* 闸门：不勾选不能确认——勾选区用等待琥珀，且明显不是普通正文 */
.pentest-proposal__ack{display:flex;align-items:flex-start;gap:8px;margin:10px 0 0;padding:9px 11px;border:1px solid var(--pt-wait-line);background:var(--pt-wait-wash);cursor:pointer;font-size:11.5px;line-height:1.65;color:var(--pt-fg-dim);transition:border-color var(--pt-dur-fast) var(--pt-ease),background var(--pt-dur-fast) var(--pt-ease)}
.pentest-proposal__ack:hover{border-color:var(--pt-wait)}
.pentest-proposal__ack input[type="checkbox"]{flex:0 0 14px;width:14px;height:14px;margin:2px 0 0;accent-color:var(--pt-wait);cursor:pointer}
.pentest-proposal__ack input[type="checkbox"]:focus-visible{outline:1px solid var(--pt-wait);outline-offset:2px}
.pentest-proposal__ack:has(input[type="checkbox"]:disabled){border-color:var(--pt-line);background:var(--pt-bg-well);opacity:.62;cursor:not-allowed}
.pentest-proposal__ack:has(input[type="checkbox"]:disabled) input[type="checkbox"]{cursor:not-allowed}

/* 未满足的确认条件：逐条列出，不能确认的原因必须看得见 */
.pentest-proposal__gates{list-style:none;display:flex;flex-direction:column;gap:5px;margin:9px 0 0;padding:9px 11px;border:1px solid var(--pt-wait-line);background:var(--pt-wait-wash)}
.pentest-proposal__gates li{font-size:11.5px;line-height:1.6;color:var(--pt-wait);overflow-wrap:anywhere}
.pentest-proposal__gates li::before{content:"▸ ";font-family:var(--pt-font-mono)}

/* 按钮栏：右对齐，主按钮在前（标记顺序即「确认 → 驳回」） */
.pentest-proposal__actions-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin:12px 0 0;padding:10px 0 0;border-top:1px solid var(--pt-line)}

/* ───────────── 会话内提案的紧凑事实行（intake 尾卡） ───────────── */
.pentest-intake__targets{list-style:none;display:flex;flex-direction:column;gap:1px;margin:8px 0 0;padding:0;border:1px solid var(--pt-line);background:var(--pt-line-soft);box-shadow:var(--pt-well-shadow);max-height:220px;overflow:auto;scrollbar-width:thin}
.pentest-intake__targets li{background:var(--pt-bg-well);padding:6px 9px;font:400 11.5px/1.6 var(--pt-font-mono);color:var(--pt-fg-dim);overflow-wrap:anywhere}
.pentest-intake__actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:8px 0 0;font-size:12px;line-height:1.65;color:var(--pt-fg-dim);overflow-wrap:anywhere}
/* 动作类别用胶囊列出来：它是这张卡里**最需要被逐项核对**的东西（§13.1），
 * 一行「允许动作：passive_collection」既难读也难核对。 */
.pentest-intake__actions-label{font:500 10px/1.35 var(--pt-font-mono);letter-spacing:.06em;color:var(--pt-fg-faint)}
.pentest-intake__action{border:1px solid var(--pt-line);background:var(--pt-bg-module);border-radius:999px;padding:1px 9px;font:400 11.5px/1.7 var(--pt-font-sans);color:var(--pt-fg)}
.pentest-proposal__summary{font:400 11px/1.5 var(--pt-font-mono);color:var(--pt-fg-faint);margin-left:2px}
/* 主按钮为什么点不动：写在按钮行下面，颜色用 wait（「等你操作」的语气）。 */
.pentest-intake__gatehint{margin:8px 0 0;font-size:11px;line-height:1.6;color:var(--pt-wait);overflow-wrap:anywhere}
.pentest-intake__note{margin:7px 0 0;padding-left:9px;border-left:2px solid var(--pt-line);font-size:11.5px;line-height:1.7;color:var(--pt-fg-faint);overflow-wrap:anywhere}
.pentest-intake__buttons{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin:12px 0 0;padding:10px 0 0;border-top:1px solid var(--pt-line)}
/* 次要动作靠左、决定性的两个靠右：三个按钮平分一行会让「确认」与「看看会发生什么」看起来同等重要。 */
.pentest-intake__buttons>.pentest-button:first-child{margin-right:auto}
`;
