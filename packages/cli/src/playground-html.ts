export const PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Renderify Runtime Playground</title>
    <style>
      :root {
        --bg-top: #e7f3ff;
        --bg-bottom: #fff9f0;
        --panel: rgba(255, 255, 255, 0.88);
        --panel-hover: rgba(255, 255, 255, 0.95);
        --line: rgba(17, 24, 39, 0.08);
        --line-strong: rgba(17, 24, 39, 0.14);
        --ink: #0f172a;
        --subtle: #64748b;
        --brand: #0f766e;
        --brand-2: #0369a1;
        --brand-light: rgba(15, 118, 110, 0.08);
        --danger: #dc2626;
        --danger-light: rgba(220, 38, 38, 0.06);
        --radius: 12px;
        --radius-lg: 16px;
        --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
        --shadow: 0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
        --shadow-lg: 0 8px 24px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04);
        --transition: 0.18s ease;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
        background: radial-gradient(ellipse at 10% 0%, var(--bg-top) 0%, var(--bg-bottom) 70%);
        min-height: 100vh;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      .shell {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 28px 48px;
      }

      header {
        margin-bottom: 28px;
        padding-bottom: 24px;
        border-bottom: 1px solid var(--line);
      }

      .title {
        margin: 0 0 6px;
        font-size: 32px;
        font-weight: 700;
        letter-spacing: -0.02em;
        background: linear-gradient(135deg, var(--brand), var(--brand-2));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .sub {
        margin: 0;
        color: var(--subtle);
        font-size: 15px;
        letter-spacing: 0.01em;
      }

      .sub span {
        display: inline-block;
        padding: 0 6px;
        color: rgba(15, 118, 110, 0.4);
        font-weight: 500;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 20px;
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius-lg);
        padding: 0;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        box-shadow: var(--shadow);
        transition: box-shadow var(--transition), transform var(--transition);
        overflow: hidden;
      }

      .card:hover {
        box-shadow: var(--shadow-lg);
      }

      .card-header {
        padding: 16px 20px 12px;
        border-bottom: 1px solid var(--line);
      }

      .card-body {
        padding: 16px 20px 20px;
      }

      .span-4 {
        grid-column: span 4;
      }

      .span-6 {
        grid-column: span 6;
      }

      .span-8 {
        grid-column: span 8;
      }

      .span-12 {
        grid-column: span 12;
      }

      h2 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--subtle);
        display: flex;
        align-items: center;
        gap: 8px;
      }

      h2::before {
        content: "";
        display: inline-block;
        width: 3px;
        height: 14px;
        border-radius: 2px;
        background: linear-gradient(180deg, var(--brand), var(--brand-2));
        flex-shrink: 0;
      }

      textarea {
        width: 100%;
        min-height: 132px;
        border: 1px solid var(--line-strong);
        border-radius: var(--radius);
        padding: 12px 14px;
        font: inherit;
        font-size: 14px;
        line-height: 1.6;
        resize: vertical;
        background: #fff;
        color: var(--ink);
        transition: border-color var(--transition), box-shadow var(--transition);
      }

      textarea::placeholder {
        color: #94a3b8;
      }

      textarea:focus {
        outline: none;
        border-color: var(--brand);
        box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      button {
        border: 1px solid transparent;
        border-radius: var(--radius);
        padding: 9px 16px;
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        background: linear-gradient(160deg, var(--brand), var(--brand-2));
        color: #fff;
        box-shadow: var(--shadow-sm);
        transition: all var(--transition);
        white-space: nowrap;
      }

      button:hover:not(:disabled) {
        filter: brightness(1.08);
        box-shadow: var(--shadow);
        transform: translateY(-1px);
      }

      button:active:not(:disabled) {
        transform: translateY(0) scale(0.98);
        filter: brightness(0.95);
      }

      button.secondary {
        background: #fff;
        color: var(--ink);
        border-color: var(--line-strong);
      }

      button.secondary:hover:not(:disabled) {
        background: #f8fafc;
        border-color: var(--brand);
        color: var(--brand);
      }

      button.danger {
        background: var(--danger);
      }

      button.danger:hover:not(:disabled) {
        background: #b91c1c;
      }

      button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        transform: none;
        filter: none;
      }

      .status {
        min-height: 20px;
        margin-top: 12px;
        color: var(--subtle);
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .status::before {
        content: "";
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--brand);
        opacity: 0.5;
        flex-shrink: 0;
      }

      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--subtle);
        user-select: none;
        cursor: pointer;
      }

      .toggle input[type="checkbox"] {
        accent-color: var(--brand);
      }

      .render-output {
        min-height: 180px;
        border: 1px solid var(--line-strong);
        border-radius: var(--radius);
        padding: 16px;
        background: #fff;
        position: relative;
        transition: border-color var(--transition);
      }

      .render-output[data-empty="true"]::after {
        content: "Preview will appear here";
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: #cbd5e1;
        font-size: 14px;
        font-weight: 500;
        pointer-events: none;
      }

      .render-scope {
        all: initial;
        display: block;
        min-height: 1px;
        color: #0f172a;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }

      .render-scope :where(*) {
        all: revert;
        box-sizing: border-box;
      }

      .render-scope :where(img, svg, canvas, video) {
        max-width: 100%;
      }

      pre {
        margin: 0;
        max-height: 400px;
        overflow: auto;
        padding: 14px 16px;
        font-size: 12px;
        line-height: 1.7;
        font-family: "IBM Plex Mono", "SF Mono", "Fira Code", monospace;
        border-radius: var(--radius);
        background: #1e293b;
        color: #e2e8f0;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      pre::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }

      pre::-webkit-scrollbar-track {
        background: transparent;
      }

      pre::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }

      pre::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      /* ── Source Code card ── */

      .source-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
      }

      .source-header-row h2 {
        flex-shrink: 0;
      }

      .source-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .source-badge {
        display: inline-block;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.03em;
        border-radius: 6px;
        background: linear-gradient(135deg, rgba(15,118,110,0.10), rgba(3,105,161,0.10));
        color: var(--brand);
        border: 1px solid rgba(15,118,110,0.15);
        text-transform: uppercase;
      }

      .source-copy-btn {
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 6px;
        cursor: pointer;
        background: #fff;
        color: var(--subtle);
        border: 1px solid var(--line-strong);
        transition: all var(--transition);
        margin-left: auto;
      }

      .source-copy-btn:hover {
        color: var(--brand);
        border-color: var(--brand);
        background: var(--brand-light);
        transform: translateY(-1px);
      }

      .source-pre {
        margin: 0;
        max-height: 520px;
        overflow: auto;
        padding: 0;
        font-size: 13px;
        line-height: 1.75;
        font-family: "IBM Plex Mono", "SF Mono", "Fira Code", monospace;
        border-radius: var(--radius);
        background: #0f172a;
        color: #e2e8f0;
        border: 1px solid rgba(255, 255, 255, 0.06);
        counter-reset: srcline;
        line-height: 0px;
        padding-top: 20px;
      }

      .source-line {
        display: block;
        padding: 0 16px 0 0;
        counter-increment: srcline;
        min-height: 1.75em;
      }

      .source-line:hover {
        background: rgba(255, 255, 255, 0.04);
      }

      .source-line::before {
        content: counter(srcline);
        display: inline-block;
        width: 44px;
        padding-right: 14px;
        text-align: right;
        color: #475569;
        user-select: none;
        -webkit-user-select: none;
        border-right: 1px solid rgba(255, 255, 255, 0.06);
        margin-right: 14px;
        font-size: 12px;
      }

      .source-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 120px;
        color: #475569;
        font-size: 13px;
        font-family: "IBM Plex Mono", "SF Mono", "Fira Code", monospace;
        background: #0f172a;
        border-radius: var(--radius);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .tok-keyword { color: #c084fc; }
      .tok-type { color: #67e8f9; }
      .tok-string { color: #86efac; }
      .tok-comment { color: #64748b; font-style: italic; }
      .tok-number { color: #fbbf24; }
      .tok-literal { color: #fb923c; }
      .tok-function { color: #60a5fa; }
      .tok-tag { color: #f472b6; }
      .tok-attr { color: #fbbf24; }
      .tok-operator { color: #94a3b8; }
      .tok-regex { color: #f87171; }

      .debug-section {
        opacity: 0.75;
        transition: opacity var(--transition);
      }

      .debug-section:hover {
        opacity: 1;
      }

      @media (max-width: 980px) {
        .shell {
          padding: 20px 16px 32px;
        }

        .title {
          font-size: 26px;
        }

        .grid {
          gap: 14px;
        }

        .span-4,
        .span-6,
        .span-8 {
          grid-column: span 12;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <h1 class="title">Renderify Playground</h1>
        <p class="sub">Prompt <span>&rarr;</span> RuntimePlan <span>&rarr;</span> Runtime <span>&rarr;</span> Browser</p>
      </header>

      <div class="grid">
        <section class="card span-4">
          <div class="card-header"><h2>Prompt</h2></div>
          <div class="card-body">
            <textarea id="prompt" placeholder="Describe what to render...">Build an analytics dashboard with a chart and KPI cards</textarea>
            <div class="actions">
              <button id="run-prompt">Render</button>
              <button id="stream-prompt" class="secondary">Stream</button>
              <button id="clear" class="danger">Clear</button>
            </div>
            <div class="status" id="status">Ready.</div>
          </div>
        </section>

        <section class="card span-8">
          <div class="card-header"><h2>Rendered HTML</h2></div>
          <div class="card-body">
            <div class="render-output" id="html-output" data-empty="true"></div>
          </div>
        </section>

        <section class="card span-6">
          <div class="card-header"><h2>Plan JSON</h2></div>
          <div class="card-body">
            <textarea id="plan-editor">{}</textarea>
            <div class="actions">
              <button id="run-plan">Render Plan</button>
              <button id="probe-plan" class="secondary">Probe</button>
              <button id="copy-plan-link" class="secondary">Copy Link</button>
            </div>
          </div>
        </section>

        <section class="card span-6">
          <div class="card-header"><h2>Diagnostics</h2></div>
          <div class="card-body">
            <pre id="diagnostics">{}</pre>
          </div>
        </section>

        <section class="card span-12" id="source-section">
          <div class="card-header">
            <div class="source-header-row">
              <h2>Source Code</h2>
              <div class="source-meta" id="source-meta" style="display:none">
                <span class="source-badge" id="source-lang-badge"></span>
                <span class="source-badge" id="source-runtime-badge"></span>
                <span class="source-badge" id="source-export-badge"></span>
                <button class="source-copy-btn" id="copy-source" type="button">Copy</button>
              </div>
            </div>
          </div>
          <div class="card-body">
            <div class="source-empty" id="source-empty">No source code in the current plan. Render a prompt that generates interactive components to see source here.</div>
            <pre class="source-pre" id="source-pre" style="display:none"><code id="source-code"></code></pre>
          </div>
        </section>

        <section class="card span-12">
          <div class="card-header"><h2>Streaming Feed</h2></div>
          <div class="card-body">
            <pre id="stream-output">[]</pre>
          </div>
        </section>

        <section class="card span-12 debug-section">
          <div class="card-header"><h2>Debug Stats</h2></div>
          <div class="card-body">
            <div class="actions">
              <button id="refresh-debug" class="secondary">Refresh</button>
              <label class="toggle">
                <input id="auto-refresh-debug" type="checkbox" checked />
                Auto refresh (2s)
              </label>
            </div>
            <div class="status" id="debug-status">Waiting for debug stats...</div>
            <pre id="debug-output">{}</pre>
          </div>
        </section>
      </div>
    </div>

    <script>
      const byId = (id) => document.getElementById(id);
      const statusEl = byId("status");
      const promptEl = byId("prompt");
      const htmlOutputEl = byId("html-output");
      const planEditorEl = byId("plan-editor");
      const diagnosticsEl = byId("diagnostics");
      const streamOutputEl = byId("stream-output");
      const copyPlanLinkEl = byId("copy-plan-link");
      const refreshDebugEl = byId("refresh-debug");
      const autoRefreshDebugEl = byId("auto-refresh-debug");
      const debugStatusEl = byId("debug-status");
      const debugOutputEl = byId("debug-output");
      const sourceSectionEl = byId("source-section");
      const sourceCodeEl = byId("source-code");
      const sourcePreEl = byId("source-pre");
      const sourceEmptyEl = byId("source-empty");
      const sourceMetaEl = byId("source-meta");
      const sourceLangBadge = byId("source-lang-badge");
      const sourceRuntimeBadge = byId("source-runtime-badge");
      const sourceExportBadge = byId("source-export-badge");
      const copySourceEl = byId("copy-source");
      let lastRawSourceCode = "";
      const renderScopeEl = document.createElement("div");
      renderScopeEl.className = "render-scope";
      htmlOutputEl.replaceChildren(renderScopeEl);

      const hasVisibleRenderContent = () => {
        for (const node of renderScopeEl.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            if (String(node.textContent ?? "").trim().length > 0) {
              return true;
            }
            continue;
          }
          if (node.nodeType === Node.COMMENT_NODE) {
            continue;
          }
          return true;
        }
        return false;
      };

      const syncRenderOutputEmptyState = () => {
        htmlOutputEl.dataset.empty = hasVisibleRenderContent() ? "false" : "true";
      };

      const setRenderOutputHtml = (html) => {
        renderScopeEl.innerHTML = String(html ?? "");
        syncRenderOutputEmptyState();
      };

      const clearRenderOutputHtml = () => {
        renderScopeEl.innerHTML = "";
        syncRenderOutputEmptyState();
      };

      const queryRenderOutput = (selector) => renderScopeEl.querySelector(selector);
      syncRenderOutputEmptyState();

      const escHtml = (s) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const highlightSource = (code) => {
        var result = "";
        var i = 0;
        var len = code.length;
        var kw = "import,export,from,default,const,let,var,function,return,if,else,for,while,do,switch,case,break,continue,new,this,class,extends,super,typeof,instanceof,in,of,try,catch,finally,throw,async,await,yield,void,delete".split(",");
        var tp = "interface,type,enum,implements,namespace,declare,as,is,keyof,readonly,abstract,static,public,private,protected".split(",");
        var lt = "true,false,null,undefined,NaN,Infinity".split(",");
        var kwSet = {};
        var tpSet = {};
        var ltSet = {};
        kw.forEach(function(w) { kwSet[w] = 1; });
        tp.forEach(function(w) { tpSet[w] = 1; });
        lt.forEach(function(w) { ltSet[w] = 1; });

        while (i < len) {
          // line comments
          if (code[i] === "/" && i + 1 < len && code[i + 1] === "/") {
            var end = code.indexOf("\\n", i);
            if (end === -1) end = len;
            result += '<span class="tok-comment">' + escHtml(code.slice(i, end)) + "</span>";
            i = end;
            continue;
          }
          // block comments
          if (code[i] === "/" && i + 1 < len && code[i + 1] === "*") {
            var end2 = code.indexOf("*/", i + 2);
            end2 = end2 === -1 ? len : end2 + 2;
            result += '<span class="tok-comment">' + escHtml(code.slice(i, end2)) + "</span>";
            i = end2;
            continue;
          }
          // regex (heuristic: after = ( , ; ! & | ? : [ { ~ ^)
          if (code[i] === "/" && i + 1 < len && code[i + 1] !== "/" && code[i + 1] !== "*") {
            var prevChar = "";
            for (var pi = i - 1; pi >= 0; pi--) {
              if (code[pi] !== " " && code[pi] !== "\\t") { prevChar = code[pi]; break; }
            }
            if ("=({[,;!&|?:~^".indexOf(prevChar) !== -1 || i === 0) {
              var j = i + 1;
              var inClass = false;
              while (j < len && (code[j] !== "/" || inClass)) {
                if (code[j] === "\\\\") { j++; }
                else if (code[j] === "[") { inClass = true; }
                else if (code[j] === "]") { inClass = false; }
                j++;
              }
              if (j < len) { j++; while (j < len && /[gimsuy]/.test(code[j])) j++; }
              result += '<span class="tok-regex">' + escHtml(code.slice(i, j)) + "</span>";
              i = j;
              continue;
            }
          }
          // template literal (simplified - no nesting)
          if (code[i] === "\`") {
            var j2 = i + 1;
            while (j2 < len && code[j2] !== "\`") {
              if (code[j2] === "\\\\") j2++;
              j2++;
            }
            if (j2 < len) j2++;
            result += '<span class="tok-string">' + escHtml(code.slice(i, j2)) + "</span>";
            i = j2;
            continue;
          }
          // strings
          if (code[i] === '"' || code[i] === "'") {
            var q = code[i];
            var j3 = i + 1;
            while (j3 < len && code[j3] !== q && code[j3] !== "\\n") {
              if (code[j3] === "\\\\") j3++;
              j3++;
            }
            if (j3 < len && code[j3] === q) j3++;
            result += '<span class="tok-string">' + escHtml(code.slice(i, j3)) + "</span>";
            i = j3;
            continue;
          }
          // numbers
          if (/[0-9]/.test(code[i]) || (code[i] === "." && i + 1 < len && /[0-9]/.test(code[i + 1]))) {
            var j4 = i;
            if (code[j4] === "0" && j4 + 1 < len && (code[j4 + 1] === "x" || code[j4 + 1] === "X")) {
              j4 += 2;
              while (j4 < len && /[0-9a-fA-F_]/.test(code[j4])) j4++;
            } else {
              while (j4 < len && /[0-9_]/.test(code[j4])) j4++;
              if (j4 < len && code[j4] === ".") { j4++; while (j4 < len && /[0-9_]/.test(code[j4])) j4++; }
              if (j4 < len && (code[j4] === "e" || code[j4] === "E")) {
                j4++;
                if (j4 < len && (code[j4] === "+" || code[j4] === "-")) j4++;
                while (j4 < len && /[0-9]/.test(code[j4])) j4++;
              }
            }
            if (j4 < len && code[j4] === "n") j4++;
            result += '<span class="tok-number">' + escHtml(code.slice(i, j4)) + "</span>";
            i = j4;
            continue;
          }
          // identifiers & keywords
          if (/[a-zA-Z_$]/.test(code[i])) {
            var j5 = i;
            while (j5 < len && /[a-zA-Z0-9_$]/.test(code[j5])) j5++;
            var word = code.slice(i, j5);
            if (kwSet[word]) {
              result += '<span class="tok-keyword">' + escHtml(word) + "</span>";
            } else if (tpSet[word]) {
              result += '<span class="tok-type">' + escHtml(word) + "</span>";
            } else if (ltSet[word]) {
              result += '<span class="tok-literal">' + escHtml(word) + "</span>";
            } else if (j5 < len && code[j5] === "(") {
              result += '<span class="tok-function">' + escHtml(word) + "</span>";
            } else if (/^[A-Z]/.test(word)) {
              result += '<span class="tok-type">' + escHtml(word) + "</span>";
            } else {
              result += escHtml(word);
            }
            i = j5;
            continue;
          }
          // JSX tags
          if (code[i] === "<" && i + 1 < len && (/[A-Za-z]/.test(code[i + 1]) || code[i + 1] === "/")) {
            result += '<span class="tok-tag">' + escHtml(code[i]);
            i++;
            if (i < len && code[i] === "/") { result += escHtml(code[i]); i++; }
            var j6 = i;
            while (j6 < len && /[a-zA-Z0-9._]/.test(code[j6])) j6++;
            result += escHtml(code.slice(i, j6)) + "</span>";
            i = j6;
            continue;
          }
          // arrow =>
          if (code[i] === "=" && i + 1 < len && code[i + 1] === ">") {
            result += '<span class="tok-operator">=&gt;</span>';
            i += 2;
            continue;
          }
          // everything else
          result += escHtml(code[i]);
          i++;
        }
        return result;
      };

      const displaySourceCode = (planDetail) => {
        if (!isRecord(planDetail) || !isRecord(planDetail.source)) {
          sourcePreEl.style.display = "none";
          sourceMetaEl.style.display = "none";
          sourceEmptyEl.style.display = "";
          lastRawSourceCode = "";
          return;
        }
        var src = planDetail.source;
        var code = typeof src.code === "string" ? src.code : "";
        if (!code.trim()) {
          sourcePreEl.style.display = "none";
          sourceMetaEl.style.display = "none";
          sourceEmptyEl.style.display = "";
          lastRawSourceCode = "";
          return;
        }
        lastRawSourceCode = code;
        var lang = String(src.language || "jsx").trim().toLowerCase();
        var runtime = String(src.runtime || "").trim().toLowerCase();
        var exportName = String(src.exportName || "default").trim();

        sourceLangBadge.textContent = lang;
        sourceRuntimeBadge.textContent = runtime || "unknown";
        sourceExportBadge.textContent = "export: " + exportName;
        sourceEmptyEl.style.display = "none";
        sourcePreEl.style.display = "";
        sourceMetaEl.style.display = "";

        var lines = code.split("\\n");
        var highlighted = lines.map(function(line) {
          return '<span class="source-line">' + (line.length > 0 ? highlightSource(line) : " ") + "</span>";
        }).join("\\n");

        sourceCodeEl.innerHTML = highlighted;
      };

      const hideSourceCode = () => {
        sourcePreEl.style.display = "none";
        sourceMetaEl.style.display = "none";
        sourceEmptyEl.style.display = "";
        sourceCodeEl.innerHTML = "";
        lastRawSourceCode = "";
      };

      copySourceEl.addEventListener("click", function() {
        if (!lastRawSourceCode) return;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(lastRawSourceCode).then(function() {
            copySourceEl.textContent = "Copied!";
            setTimeout(function() { copySourceEl.textContent = "Copy"; }, 1500);
          });
        }
      });

      const controls = [
        byId("run-prompt"),
        byId("stream-prompt"),
        byId("run-plan"),
        byId("probe-plan"),
        copyPlanLinkEl,
        byId("clear"),
      ];

      const setBusy = (busy) => {
        controls.forEach((button) => {
          button.disabled = busy;
        });
      };

      const setStatus = (text) => {
        statusEl.textContent = text;
      };

      const setDebugStatus = (text) => {
        debugStatusEl.textContent = text;
      };

      const safeJson = (value) => {
        try {
          return JSON.stringify(value ?? {}, null, 2);
        } catch (error) {
          return String(error);
        }
      };

      const isRecord = (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value);

      const DEFAULT_PREACT_VERSION = "10.28.3";
      const ESM_SH_BASE_URL = "https://esm.sh/";
      const BABEL_STANDALONE_URLS = [
        "https://unpkg.com/@babel/standalone/babel.min.js",
        "https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js",
      ];

      let interactiveMountVersion = 0;
      let interactiveBlobModuleUrl = null;
      let babelStandalonePromise;
      let diagnosticsSnapshot = {};
      let debugRefreshTimer = null;
      let debugRefreshInFlight = false;

      const resetInteractiveMount = () => {
        interactiveMountVersion += 1;
        if (interactiveBlobModuleUrl) {
          URL.revokeObjectURL(interactiveBlobModuleUrl);
          interactiveBlobModuleUrl = null;
        }
      };

      const writeDiagnostics = (payload) => {
        diagnosticsSnapshot = isRecord(payload) ? payload : {};
        diagnosticsEl.textContent = safeJson(diagnosticsSnapshot);
      };

      const appendInteractiveWarning = (message) => {
        const diagnostics = Array.isArray(diagnosticsSnapshot.diagnostics)
          ? diagnosticsSnapshot.diagnostics.slice()
          : [];
        diagnostics.push({
          level: "warning",
          code: "PLAYGROUND_INTERACTIVE_MOUNT_FAILED",
          message,
        });
        writeDiagnostics({
          traceId: diagnosticsSnapshot.traceId,
          state: diagnosticsSnapshot.state ?? {},
          diagnostics,
        });
      };

      const isTodoPromptText = (promptText) => /\btodo\b/i.test(String(promptText ?? ""));

      const hasRenderedTodoControls = () =>
        Boolean(
          queryRenderOutput("input[type='text']") &&
            queryRenderOutput("button"),
        );

      const mountBuiltinTodoFallback = () => {
        setRenderOutputHtml([
          '<div class="playground-todo-fallback">',
          "  <h1>Todo App</h1>",
          "  <p data-todo-summary>0 item(s) remaining</p>",
          '  <input type="text" data-todo-input placeholder="Add a todo" />',
          '  <button type="button" data-todo-add>Add Todo</button>',
          "  <ul data-todo-list></ul>",
          "</div>",
        ].join("\\n"));

        const inputEl = queryRenderOutput("[data-todo-input]");
        const addButtonEl = queryRenderOutput("[data-todo-add]");
        const listEl = queryRenderOutput("[data-todo-list]");
        const summaryEl = queryRenderOutput("[data-todo-summary]");
        if (!inputEl || !addButtonEl || !listEl || !summaryEl) {
          return false;
        }

        let nextId = 1;
        let todos = [];

        const renderList = () => {
          listEl.innerHTML = "";
          for (const todo of todos) {
            const itemEl = document.createElement("li");
            const toggleEl = document.createElement("input");
            toggleEl.type = "checkbox";
            toggleEl.checked = Boolean(todo.done);
            toggleEl.addEventListener("input", () => {
              todos = todos.map((entry) =>
                entry.id === todo.id ? { ...entry, done: !entry.done } : entry,
              );
              renderList();
            });

            const textEl = document.createElement("span");
            textEl.textContent = String(todo.text);
            textEl.style.textDecoration = todo.done ? "line-through" : "none";

            const deleteEl = document.createElement("button");
            deleteEl.type = "button";
            deleteEl.textContent = "Delete";
            deleteEl.addEventListener("click", () => {
              todos = todos.filter((entry) => entry.id !== todo.id);
              renderList();
            });

            itemEl.appendChild(toggleEl);
            itemEl.appendChild(textEl);
            itemEl.appendChild(deleteEl);
            listEl.appendChild(itemEl);
          }

          const remaining = todos.filter((todo) => !todo.done).length;
          summaryEl.textContent = remaining + " item(s) remaining";
        };

        const addTodo = () => {
          const text = String(inputEl.value ?? "").trim();
          if (!text) {
            return;
          }
          todos = [...todos, { id: nextId++, text, done: false }];
          inputEl.value = "";
          renderList();
        };

        addButtonEl.addEventListener("click", addTodo);
        inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            addTodo();
          }
        });

        renderList();
        return true;
      };

      const applyTodoInteractiveFallbackIfNeeded = (promptText, mountState) => {
        if (!isTodoPromptText(promptText)) {
          return false;
        }

        const fallbackNeeded =
          Boolean(mountState && mountState.fallbackToStatic) ||
          !hasRenderedTodoControls();
        if (!fallbackNeeded) {
          return false;
        }

        const mounted = mountBuiltinTodoFallback();
        if (mounted) {
          appendInteractiveWarning(
            "Using built-in interactive Todo fallback because generated source could not be mounted reliably.",
          );
        }
        return mounted;
      };

      const toDebugCount = (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : 0;

      const compactDebugSnapshot = (payload) => {
        const inbound = isRecord(payload && payload.inbound) ? payload.inbound : {};
        const outbound = isRecord(payload && payload.outbound) ? payload.outbound : {};
        const inboundRoutes = Array.isArray(inbound.routes) ? inbound.routes : [];
        const outboundTargets = Array.isArray(outbound.targets) ? outbound.targets : [];
        const recent = Array.isArray(payload && payload.recent) ? payload.recent : [];

        return {
          enabled: payload && payload.enabled === true,
          startedAt:
            payload && typeof payload.startedAt === "string"
              ? payload.startedAt
              : undefined,
          uptimeMs: toDebugCount(payload && payload.uptimeMs),
          inbound: {
            totalRequests: toDebugCount(inbound.totalRequests),
            routes: inboundRoutes.slice(0, 10),
          },
          outbound: {
            totalRequests: toDebugCount(outbound.totalRequests),
            targets: outboundTargets.slice(0, 10),
          },
          recent: recent.slice(-25),
          ...(payload && payload.error ? { error: String(payload.error) } : {}),
        };
      };

      const setDebugOutput = (payload) => {
        debugOutputEl.textContent = safeJson(compactDebugSnapshot(payload));
      };

      const formatDebugSummary = (snapshot) => {
        if (!snapshot.enabled) {
          return snapshot.error
            ? "Debug stats unavailable: " + snapshot.error
            : "Debug stats unavailable.";
        }

        const inboundTotal = toDebugCount(
          snapshot.inbound && snapshot.inbound.totalRequests,
        );
        const outboundTotal = toDebugCount(
          snapshot.outbound && snapshot.outbound.totalRequests,
        );
        return (
          "Debug mode enabled. inbound=" +
          inboundTotal +
          ", outbound=" +
          outboundTotal +
          ". Updated " +
          new Date().toLocaleTimeString() +
          "."
        );
      };

      async function requestDebugStats() {
        const response = await fetch("/api/debug/stats", {
          method: "GET",
          cache: "no-store",
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          const message =
            isRecord(payload) && typeof payload.error === "string"
              ? payload.error
              : "request failed with status " + response.status;
          return {
            enabled: false,
            error: message,
            statusCode: response.status,
          };
        }

        return isRecord(payload) ? payload : {};
      }

      async function refreshDebugStats(options = {}) {
        const silent = options && options.silent === true;
        if (debugRefreshInFlight) {
          return;
        }

        debugRefreshInFlight = true;
        if (!silent) {
          setDebugStatus("Refreshing debug stats...");
        }

        try {
          const payload = await requestDebugStats();
          setDebugOutput(payload);
          setDebugStatus(formatDebugSummary(payload));
          if (
            payload &&
            payload.enabled !== true &&
            typeof payload.error === "string" &&
            payload.error.toLowerCase().includes("debug mode is disabled")
          ) {
            autoRefreshDebugEl.checked = false;
            restartDebugAutoRefresh();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const snapshot = {
            enabled: false,
            error: message,
          };
          setDebugOutput(snapshot);
          setDebugStatus("Debug stats unavailable: " + message);
        } finally {
          debugRefreshInFlight = false;
        }
      }

      const restartDebugAutoRefresh = () => {
        if (debugRefreshTimer) {
          clearInterval(debugRefreshTimer);
          debugRefreshTimer = null;
        }

        if (!(autoRefreshDebugEl && autoRefreshDebugEl.checked)) {
          return;
        }

        debugRefreshTimer = setInterval(() => {
          void refreshDebugStats({ silent: true });
        }, 2000);
      };

      const ensureBabelStandalone = async () => {
        if (window.Babel && typeof window.Babel.transform === "function") {
          return;
        }

        if (!babelStandalonePromise) {
          babelStandalonePromise = (async () => {
            const loadBabelFromUrl = (url) =>
              new Promise((resolve, reject) => {
                const existing = document.querySelector(
                  "script[data-babel-standalone='1'][src='" + url + "']",
                );
                if (existing) {
                  if (window.Babel && typeof window.Babel.transform === "function") {
                    resolve();
                    return;
                  }

                  existing.addEventListener("load", () => resolve(), { once: true });
                  existing.addEventListener(
                    "error",
                    () =>
                      reject(
                        new Error("Failed to load Babel standalone from: " + url),
                      ),
                    { once: true },
                  );
                  return;
                }

                const script = document.createElement("script");
                script.src = url;
                script.async = true;
                script.dataset.babelStandalone = "1";
                script.onload = () => resolve();
                script.onerror = () =>
                  reject(new Error("Failed to load Babel standalone from: " + url));
                document.head.appendChild(script);
              });

            let lastError = null;
            for (const url of BABEL_STANDALONE_URLS) {
              try {
                await loadBabelFromUrl(url);
                if (window.Babel && typeof window.Babel.transform === "function") {
                  return;
                }
              } catch (error) {
                lastError = error;
              }
            }

            const detail =
              lastError instanceof Error ? lastError.message : String(lastError);
            throw new Error("Babel standalone is unavailable in playground: " + detail);
          })();
        }

        await babelStandalonePromise;

        if (!(window.Babel && typeof window.Babel.transform === "function")) {
          throw new Error("Babel standalone is unavailable in playground.");
        }
      };

      const isBareModuleSpecifier = (specifier) => {
        const normalized = String(specifier ?? "").trim();
        if (!normalized) {
          return false;
        }

        if (
          normalized.startsWith("./") ||
          normalized.startsWith("../") ||
          normalized.startsWith("/") ||
          normalized.startsWith("http://") ||
          normalized.startsWith("https://") ||
          normalized.startsWith("data:") ||
          normalized.startsWith("blob:")
        ) {
          return false;
        }

        const firstColonIndex = normalized.indexOf(":");
        if (firstColonIndex > 0) {
          return false;
        }

        return true;
      };

      const getManifestResolvedUrl = (planDetail, specifier) => {
        if (!isRecord(planDetail) || !isRecord(planDetail.moduleManifest)) {
          return undefined;
        }
        const descriptor = planDetail.moduleManifest[specifier];
        if (!isRecord(descriptor)) {
          return undefined;
        }
        const resolvedUrl = descriptor.resolvedUrl;
        if (typeof resolvedUrl !== "string" || resolvedUrl.trim().length === 0) {
          return undefined;
        }
        return resolvedUrl.trim();
      };

      const extractPreactVersion = (planDetail) => {
        const candidates = [
          getManifestResolvedUrl(planDetail, "preact"),
          getManifestResolvedUrl(planDetail, "preact/hooks"),
          getManifestResolvedUrl(planDetail, "preact/jsx-runtime"),
        ];

        for (const candidate of candidates) {
          if (!candidate) {
            continue;
          }
          const match = candidate.match(/preact@([^/]+)/);
          if (match && typeof match[1] === "string" && match[1].trim()) {
            return match[1].trim();
          }
        }

        return DEFAULT_PREACT_VERSION;
      };

      const toEsmPreactUrl = (specifier, version) => {
        if (specifier === "preact") {
          return ESM_SH_BASE_URL + "preact@" + version;
        }
        if (specifier.startsWith("preact/")) {
          return (
            ESM_SH_BASE_URL +
            "preact@" +
            version +
            "/" +
            specifier.slice("preact/".length)
          );
        }
        return undefined;
      };

      const extractJspmNpmSpecifier = (url) => {
        try {
          const parsed = new URL(String(url ?? ""));
          const host = String(parsed.host ?? "").toLowerCase();
          if (!host.endsWith("jspm.io")) {
            return undefined;
          }

          const pathname = String(parsed.pathname ?? "");
          if (!pathname.startsWith("/npm:")) {
            return undefined;
          }

          const specifier = pathname.slice("/npm:".length).trim();
          return specifier.length > 0 ? specifier : undefined;
        } catch {
          return undefined;
        }
      };

      const hasExplicitNpmVersion = (specifier) => {
        const normalized = String(specifier ?? "")
          .trim()
          .split("?")[0];
        if (!normalized) {
          return false;
        }

        if (normalized.startsWith("@")) {
          const segments = normalized.split("/");
          if (segments.length < 2) {
            return false;
          }

          const scopedPackage = segments[1];
          const versionIndex = scopedPackage.lastIndexOf("@");
          return versionIndex > 0 && versionIndex < scopedPackage.length - 1;
        }

        const firstSegment = normalized.split("/")[0];
        const versionIndex = firstSegment.lastIndexOf("@");
        return versionIndex > 0 && versionIndex < firstSegment.length - 1;
      };

      const toEsmFallbackForUnpinnedJspmUrl = (url, planDetail) => {
        const specifier = extractJspmNpmSpecifier(url);
        if (!specifier || hasExplicitNpmVersion(specifier)) {
          return undefined;
        }

        const preactVersion = extractPreactVersion(planDetail);
        const aliasQuery = [
          "alias=react:preact/compat,react-dom:preact/compat,react-dom/client:preact/compat,react/jsx-runtime:preact/jsx-runtime,react/jsx-dev-runtime:preact/jsx-runtime",
          "target=es2022",
          "deps=preact@" + preactVersion,
        ].join("&");
        const separator = specifier.includes("?") ? "&" : "?";
        return ESM_SH_BASE_URL + specifier + separator + aliasQuery;
      };

      const toEsmShUrl = (specifier, planDetail) => {
        const normalized = String(specifier ?? "").trim();
        if (!normalized) {
          return normalized;
        }

        if (!isBareModuleSpecifier(normalized)) {
          return normalized;
        }

        // Always resolve preact-family imports via esm.sh in interactive mount,
        // because some jspm preact entrypoints re-export bare "preact" specifiers.
        if (normalized === "preact" || normalized.startsWith("preact/")) {
          const preactVersion = extractPreactVersion(planDetail);
          const esmPreactUrl = toEsmPreactUrl(normalized, preactVersion);
          if (esmPreactUrl) {
            return esmPreactUrl;
          }
        }

        const manifestResolvedUrl = getManifestResolvedUrl(planDetail, normalized);
        if (manifestResolvedUrl) {
          const fallbackUnpinned = toEsmFallbackForUnpinnedJspmUrl(
            manifestResolvedUrl,
            planDetail,
          );
          if (fallbackUnpinned) {
            return fallbackUnpinned;
          }
          return manifestResolvedUrl;
        }

        return ESM_SH_BASE_URL + normalized;
      };

      // Playground-only simplification: this regex-based rewrite can match
      // comment/string literals. Production runtime paths must use lexer parsing.
      const rewriteTranspiledImports = (code, planDetail) =>
        String(code ?? "")
          .replace(/\\bfrom\\s*["']([^"']+)["']/g, (full, specifier) =>
            full.replace(specifier, toEsmShUrl(specifier, planDetail)),
          )
          .replace(/\\bimport\\s*["']([^"']+)["']/g, (full, specifier) =>
            full.replace(specifier, toEsmShUrl(specifier, planDetail)),
          )
          .replace(
            /\\bimport\\s*\\(\\s*["']([^"']+)["']\\s*\\)/g,
            (full, specifier) =>
              full.replace(specifier, toEsmShUrl(specifier, planDetail)),
          );

      const shouldMountPreactSource = (planDetail) => {
        if (!isRecord(planDetail) || !isRecord(planDetail.source)) {
          return false;
        }
        const runtime = String(planDetail.source.runtime ?? "")
          .trim()
          .toLowerCase();
        const code = planDetail.source.code;
        return runtime === "preact" && typeof code === "string" && code.trim().length > 0;
      };

      const shouldRunRenderifySource = (planDetail) => {
        if (!isRecord(planDetail) || !isRecord(planDetail.source)) {
          return false;
        }
        const runtime = String(planDetail.source.runtime ?? "")
          .trim()
          .toLowerCase();
        const code = planDetail.source.code;
        return runtime === "renderify" && typeof code === "string" && code.trim().length > 0;
      };

      const transpileSourceForInteractiveMount = (source, runtime) => {
        const language = String(source.language ?? "jsx")
          .trim()
          .toLowerCase();
        if (
          language !== "js" &&
          language !== "jsx" &&
          language !== "ts" &&
          language !== "tsx"
        ) {
          throw new Error("Unsupported source language for interactive mount: " + language);
        }

        if (runtime === "renderify" && (language === "jsx" || language === "tsx")) {
          throw new Error(
            "Renderify runtime interactive mount does not support JSX source without preact runtime.",
          );
        }

        const presets = [];
        if (language === "ts" || language === "tsx") {
          presets.push("typescript");
        }
        if (runtime === "preact" && (language === "jsx" || language === "tsx")) {
          presets.push([
            "react",
            {
              runtime: "automatic",
              importSource: "preact",
            },
          ]);
        }

        const transformed = window.Babel.transform(String(source.code ?? ""), {
          sourceType: "module",
          presets,
          filename: "renderify-playground-source." + language,
          babelrc: false,
          configFile: false,
          comments: false,
        });

        if (!isRecord(transformed) || typeof transformed.code !== "string") {
          throw new Error("Babel returned empty code for interactive mount.");
        }

        return transformed.code;
      };

      const mountPreactSourceInteractively = async (
        planDetail,
        runtimeState,
        mountVersion,
      ) => {
        if (!shouldMountPreactSource(planDetail)) {
          return;
        }

        await ensureBabelStandalone();
        if (mountVersion !== interactiveMountVersion) {
          return;
        }

        const source = planDetail.source;
        const transpiled = transpileSourceForInteractiveMount(source, "preact");
        const rewritten = rewriteTranspiledImports(transpiled, planDetail);
        const preactImportUrl = toEsmShUrl("preact", planDetail);
        const exportNameRaw =
          typeof source.exportName === "string" && source.exportName.trim().length > 0
            ? source.exportName.trim()
            : "default";

        if (interactiveBlobModuleUrl) {
          URL.revokeObjectURL(interactiveBlobModuleUrl);
          interactiveBlobModuleUrl = null;
        }

        interactiveBlobModuleUrl = URL.createObjectURL(
          new Blob([rewritten], { type: "text/javascript" }),
        );

        const sourceNamespace = await import(interactiveBlobModuleUrl);
        if (mountVersion !== interactiveMountVersion) {
          return;
        }

        const resolveComponentExport = (namespace, preferredExportName) => {
          if (!isRecord(namespace)) {
            return undefined;
          }

          const triedNames = new Set();
          const queueName = (name) => {
            const normalized = String(name ?? "").trim();
            if (!normalized || triedNames.has(normalized)) {
              return;
            }
            triedNames.add(normalized);
          };
          queueName(preferredExportName);
          queueName("default");

          for (const [name, value] of Object.entries(namespace)) {
            if (typeof value === "function" && /^[A-Z]/.test(name)) {
              queueName(name);
            }
          }

          for (const [name, value] of Object.entries(namespace)) {
            if (typeof value === "function") {
              queueName(name);
            }
          }

          for (const name of triedNames) {
            const candidate = namespace[name];
            if (typeof candidate === "function") {
              return candidate;
            }

            if (
              isRecord(candidate) &&
              typeof candidate.default === "function"
            ) {
              return candidate.default;
            }
          }

          return undefined;
        };

        const component = resolveComponentExport(sourceNamespace, exportNameRaw);
        if (typeof component !== "function") {
          throw new Error(
            "Source export '" + exportNameRaw + "' is not a component function.",
          );
        }

        const preactNamespace = await import(preactImportUrl);
        if (mountVersion !== interactiveMountVersion) {
          return;
        }

        if (
          !isRecord(preactNamespace) ||
          typeof preactNamespace.h !== "function" ||
          typeof preactNamespace.render !== "function"
        ) {
          throw new Error("Failed to load Preact runtime for interactive mount.");
        }

        const runtimeInput = {
          context: {},
          state: isRecord(runtimeState) ? runtimeState : {},
          event: null,
        };
        clearRenderOutputHtml();
        preactNamespace.render(
          preactNamespace.h(component, runtimeInput),
          renderScopeEl,
        );
        syncRenderOutputEmptyState();
      };

      const runRenderifySourceInteractively = async (planDetail, mountVersion) => {
        if (!shouldRunRenderifySource(planDetail)) {
          return;
        }

        await ensureBabelStandalone();
        if (mountVersion !== interactiveMountVersion) {
          return;
        }

        const source = planDetail.source;
        const transpiled = transpileSourceForInteractiveMount(source, "renderify");
        const rewritten = rewriteTranspiledImports(transpiled, planDetail);

        if (interactiveBlobModuleUrl) {
          URL.revokeObjectURL(interactiveBlobModuleUrl);
          interactiveBlobModuleUrl = null;
        }

        interactiveBlobModuleUrl = URL.createObjectURL(
          new Blob([rewritten], { type: "text/javascript" }),
        );

        await import(interactiveBlobModuleUrl);
      };

      const HASH_SOURCE_LANGUAGE_KEYS = {
        js64: "js",
        jsx64: "jsx",
        ts64: "ts",
        tsx64: "tsx",
      };

      const toBase64Bytes = (input) => {
        const normalized = String(input ?? "")
          .trim()
          .replace(/[\\r\\n\\t ]+/g, "")
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        if (!normalized) {
          throw new Error("Base64 payload is empty.");
        }
        const remainder = normalized.length % 4;
        const padded =
          remainder === 0 ? normalized : normalized + "=".repeat(4 - remainder);
        return atob(padded);
      };

      const decodeBase64Text = (input) => {
        const binary = toBase64Bytes(input);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new TextDecoder().decode(bytes);
      };

      const encodeBase64Url = (input) => {
        const text = String(input ?? "");
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        return btoa(binary)
          .replace(/\\+/g, "-")
          .replace(/\\//g, "_")
          .replace(/=+$/g, "");
      };

      const getHashSearchParams = () => {
        const rawHash = window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : window.location.hash;
        return new URLSearchParams(rawHash);
      };

      const parseJsonFromBase64 = (input, label) => {
        try {
          const decoded = decodeBase64Text(input);
          return JSON.parse(decoded);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error("Failed to decode " + label + ": " + message);
        }
      };

      const resolveSourceHashPayload = (params) => {
        const sourceEntry = Object.entries(HASH_SOURCE_LANGUAGE_KEYS).find(
          ([key]) => params.has(key),
        );
        if (!sourceEntry && !params.has("source64")) {
          return null;
        }

        const explicitLanguage = String(params.get("language") || "")
          .trim()
          .toLowerCase();
        const language =
          (sourceEntry ? sourceEntry[1] : undefined) ||
          (explicitLanguage === "js" ||
          explicitLanguage === "jsx" ||
          explicitLanguage === "ts" ||
          explicitLanguage === "tsx"
            ? explicitLanguage
            : "jsx");
        const sourceRaw = sourceEntry ? params.get(sourceEntry[0]) : params.get("source64");
        if (!sourceRaw) {
          throw new Error("Source hash payload is empty.");
        }

        const code = decodeBase64Text(sourceRaw);
        const runtimeRaw = String(params.get("runtime") || "").trim().toLowerCase();
        const runtime =
          runtimeRaw === "renderify" || runtimeRaw === "preact"
            ? runtimeRaw
            : language === "jsx" || language === "tsx"
              ? "preact"
              : "renderify";
        const exportName = String(params.get("exportName") || "default").trim() || "default";
        const manifestPayload = params.get("manifest64");
        const moduleManifest = manifestPayload
          ? parseJsonFromBase64(manifestPayload, "manifest64")
          : undefined;
        const planId =
          String(params.get("id") || "").trim() ||
          "hash_source_" + Date.now().toString(36);

        return {
          specVersion: "runtime-plan/v1",
          id: planId,
          version: 1,
          root: {
            type: "element",
            tag: "div",
            children: [{ type: "text", value: "Renderify source root" }],
          },
          capabilities: {},
          ...(moduleManifest &&
          typeof moduleManifest === "object" &&
          !Array.isArray(moduleManifest)
            ? { moduleManifest }
            : {}),
          source: {
            code,
            language,
            exportName,
            runtime,
          },
          metadata: {
            tags: ["hash-deeplink", "source"],
          },
        };
      };

      async function request(path, method, body) {
        const response = await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload && payload.error ? String(payload.error) : "request failed");
        }

        if (path !== "/api/debug/stats") {
          void refreshDebugStats({ silent: true });
        }
        return payload;
      }

      const applyRenderPayload = async (payload) => {
        resetInteractiveMount();
        setRenderOutputHtml(payload.html ?? "");
        planEditorEl.value = safeJson(payload.planDetail ?? {});
        displaySourceCode(payload.planDetail);
        writeDiagnostics({
          traceId: payload.traceId,
          state: payload.state ?? {},
          diagnostics: payload.diagnostics ?? [],
        });

        const mountVersion = interactiveMountVersion;
        const mountState = {
          attempted: false,
          fallbackToStatic: false,
          message: undefined,
        };

        try {
          if (shouldMountPreactSource(payload.planDetail)) {
            mountState.attempted = true;
            await mountPreactSourceInteractively(
              payload.planDetail,
              payload.state ?? {},
              mountVersion,
            );
          } else if (shouldRunRenderifySource(payload.planDetail)) {
            mountState.attempted = true;
            await runRenderifySourceInteractively(payload.planDetail, mountVersion);
          }
        } catch (error) {
          if (mountVersion !== interactiveMountVersion) {
            return mountState;
          }
          setRenderOutputHtml(payload.html ?? "");
          const message = error instanceof Error ? error.message : String(error);
          appendInteractiveWarning(message);
          console.warn("[playground] interactive mount failed:", message);
          mountState.fallbackToStatic = true;
          mountState.message = message;
        }

        return mountState;
      };

      const resetRenderPanels = () => {
        resetInteractiveMount();
        clearRenderOutputHtml();
        planEditorEl.value = "{}";
        writeDiagnostics({});
        hideSourceCode();
      };

      async function renderPlanObject(plan, statusText) {
        setBusy(true);
        setStatus(statusText || "Rendering plan...");
        try {
          const payload = await request("/api/plan", "POST", { plan });
          const mountState = await applyRenderPayload(payload);
          const todoFallbackApplied = applyTodoInteractiveFallbackIfNeeded(
            promptEl.value,
            mountState,
          );
          if (todoFallbackApplied) {
            setStatus("Plan rendered (interactive todo fallback).");
          } else if (mountState && mountState.fallbackToStatic) {
            setStatus("Plan rendered (static fallback). See diagnostics.");
          } else {
            setStatus("Plan rendered.");
          }
          return payload;
        } catch (error) {
          setStatus("Plan render failed.");
          diagnosticsEl.textContent = String(error);
          throw error;
        } finally {
          setBusy(false);
          void refreshDebugStats({ silent: true });
        }
      }

      async function runPrompt() {
        const prompt = promptEl.value.trim();
        if (!prompt) {
          setStatus("Prompt is required.");
          return;
        }

        setBusy(true);
        setStatus("Rendering prompt...");
        resetRenderPanels();
        streamOutputEl.textContent = "[]";
        try {
          const payload = await request("/api/prompt", "POST", { prompt });
          const mountState = await applyRenderPayload(payload);
          const todoFallbackApplied = applyTodoInteractiveFallbackIfNeeded(
            prompt,
            mountState,
          );
          if (todoFallbackApplied) {
            setStatus("Prompt rendered (interactive todo fallback).");
          } else if (mountState && mountState.fallbackToStatic) {
            setStatus("Prompt rendered (static fallback). See diagnostics.");
          } else {
            setStatus("Prompt rendered.");
          }
        } catch (error) {
          setStatus("Prompt render failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
          void refreshDebugStats({ silent: true });
        }
      }

      async function streamPrompt() {
        const prompt = promptEl.value.trim();
        if (!prompt) {
          setStatus("Prompt is required.");
          return;
        }

        setBusy(true);
        setStatus("Streaming prompt...");
        resetRenderPanels();
        const streamEvents = [];
        let streamErrorMessage;
        let streamCompleted = false;
        let streamInteractiveFallback = false;
        let streamTodoFallback = false;

        try {
          const response = await fetch("/api/prompt-stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt }),
          });

          if (!response.ok || !response.body) {
            throw new Error("stream request failed");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              const event = JSON.parse(line);
              streamEvents.push({
                type: event.type,
                planId: event.planId ?? null,
                llmTextLength: String(event.llmText ?? "").length,
              });

              if (event.type === "error") {
                const message =
                  event.error && typeof event.error.message === "string"
                    ? event.error.message
                    : event.error
                      ? String(event.error)
                      : "Stream request failed";
                streamErrorMessage = message;
                continue;
              }

              if (event.html) {
                setRenderOutputHtml(event.html);
              }
              if (event.type === "final" && event.final) {
                const mountState = await applyRenderPayload(event.final);
                if (applyTodoInteractiveFallbackIfNeeded(prompt, mountState)) {
                  streamTodoFallback = true;
                }
                if (mountState && mountState.fallbackToStatic) {
                  streamInteractiveFallback = true;
                }
                streamCompleted = true;
              }
            }
          }

          streamOutputEl.textContent = safeJson(streamEvents);
          if (streamErrorMessage) {
            throw new Error(streamErrorMessage);
          }

          if (streamCompleted && streamTodoFallback) {
            setStatus("Stream completed (interactive todo fallback).");
          } else if (streamCompleted && streamInteractiveFallback) {
            setStatus("Stream completed (static fallback). See diagnostics.");
          } else {
            setStatus(
              streamCompleted
                ? "Stream completed."
                : "Stream finished without final result.",
            );
          }
        } catch (error) {
          setStatus("Stream failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
          void refreshDebugStats({ silent: true });
        }
      }

      async function runPlan() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        try {
          const plan = JSON.parse(raw);
          await renderPlanObject(plan, "Rendering plan...");
        } catch (error) {
          setStatus("Plan render failed.");
          diagnosticsEl.textContent = String(error);
        }
      }

      async function probePlan() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        setBusy(true);
        setStatus("Probing plan...");
        try {
          const plan = JSON.parse(raw);
          const payload = await request("/api/probe-plan", "POST", { plan });
          diagnosticsEl.textContent = safeJson(payload);
          setStatus("Plan probe completed.");
        } catch (error) {
          setStatus("Plan probe failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
          void refreshDebugStats({ silent: true });
        }
      }

      function clearAll() {
        resetInteractiveMount();
        clearRenderOutputHtml();
        writeDiagnostics({});
        hideSourceCode();
        streamOutputEl.textContent = "[]";
        void refreshDebugStats({ silent: true });
        setStatus("Cleared.");
      }

      async function copyPlanLink() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          const encoded = encodeBase64Url(JSON.stringify(parsed));
          const shareUrl =
            window.location.origin +
            window.location.pathname +
            "#plan64=" +
            encoded;

          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(shareUrl);
            setStatus("Plan share link copied.");
            diagnosticsEl.textContent = safeJson({
              shareUrl,
            });
            return;
          }

          diagnosticsEl.textContent = shareUrl;
          setStatus("Clipboard unavailable; share URL written to diagnostics.");
        } catch (error) {
          setStatus("Failed to create share link.");
          diagnosticsEl.textContent = String(error);
        }
      }

      async function renderFromHashPayload() {
        const params = getHashSearchParams();
        if (Array.from(params.keys()).length === 0) {
          return;
        }

        try {
          const plan64 = params.get("plan64");
          const plan = plan64
            ? parseJsonFromBase64(plan64, "plan64")
            : resolveSourceHashPayload(params);

          if (!plan) {
            return;
          }

          planEditorEl.value = safeJson(plan);
          await renderPlanObject(plan, "Rendering hash payload...");
          setStatus("Hash payload rendered.");
        } catch (error) {
          setStatus("Hash payload render failed.");
          diagnosticsEl.textContent = String(error);
        }
      }

      byId("run-prompt").addEventListener("click", runPrompt);
      byId("stream-prompt").addEventListener("click", streamPrompt);
      byId("run-plan").addEventListener("click", runPlan);
      byId("probe-plan").addEventListener("click", probePlan);
      refreshDebugEl.addEventListener("click", () => {
        void refreshDebugStats();
      });
      autoRefreshDebugEl.addEventListener("change", () => {
        restartDebugAutoRefresh();
      });
      copyPlanLinkEl.addEventListener("click", () => {
        void copyPlanLink();
      });
      byId("clear").addEventListener("click", clearAll);

      restartDebugAutoRefresh();
      void refreshDebugStats({ silent: true });
      void renderFromHashPayload();
      window.addEventListener("hashchange", () => {
        void renderFromHashPayload();
      });
      window.addEventListener("beforeunload", () => {
        if (debugRefreshTimer) {
          clearInterval(debugRefreshTimer);
          debugRefreshTimer = null;
        }
      });
    </script>
  </body>
</html>`;
