// Shared titlebar + sidebar for the mockup pages. `?theme=light` switches palettes.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";
  const page = document.body.dataset.page;

  const icon = {
    plus: '<path d="M8 3v10M3 8h10"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
    tasks: '<path d="M3 4h10M3 8h10M3 12h6"/>',
    models: '<rect x="3" y="3" width="10" height="10"/><path d="M6 6h4v4H6z"/>',
    runtime: '<path d="M2 5h12M2 11h12M5 2v12M11 2v12"/>',
    evals: '<path d="M3 13V8M8 13V3M13 13V6"/>',
    settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  };
  const svg = (n) => `<svg class="ico" viewBox="0 0 16 16">${icon[n]}</svg>`;

  const task = (state, title, n, active) => `
    <div class="task-item${active ? " active" : ""}${state === "run" ? " running" : ""}">
      <span class="dot ${state}"></span><span class="t">${title}</span><span class="n">${n}</span>
    </div>`;

  const nav = (key, label, badge) => `
    <div class="nav-item${page === key ? " active" : ""}">${svg(key)}${label}${badge ? `<span class="badge">${badge}</span>` : ""}</div>`;

  document.querySelector(".titlebar").innerHTML = `
    <div class="brand"><span class="brand-mark"></span>JBotics</div>
    <span class="spacer"></span>
    <span class="stat"><span class="dot ok"></span><b>nanbeige4.2-3b</b> Q6_K</span>
    <span class="stat">llama.cpp <b>b6120</b> cuda</span>
    <span class="stat">vram <span class="meter"><i style="width:58%"></i></span><b>4.6</b>/8G</span>
    <span class="stat"><b>38.2</b> tok/s</span>`;

  document.querySelector(".sidebar").innerHTML = `
    <div class="side-top">
      <button class="btn primary">${svg("plus")}New task <span class="kbd">Ctrl N</span></button>
      <button class="btn icon">${svg("search")}</button>
    </div>
    <div class="side-scroll">
      <div class="side-label"><span>Running</span><span>2</span></div>
      ${task("run", "Fix failing tokenizer test", "14", page === "session")}
      ${task("run", "Add --json flag to export", "6")}
      <div class="side-label"><span>Queued</span><span>1</span></div>
      ${task("", "Rename Config to Settings", "–")}
      <div class="side-label"><span>Today</span><span>4</span></div>
      ${task("ok", "Handle empty input in parser", "22")}
      ${task("ok", "Write tests for path.join", "31")}
      ${task("bad", "Port build script to make", "60")}
      ${task("ok", "Explain the render loop", "9")}
      <div class="side-label"><span>Earlier</span></div>
      ${task("ok", "Bump CI cache keys", "4")}
      ${task("ok", "Fix off-by-one in pager", "17")}
      ${task("ok", "Split tool registry module", "12")}
      ${task("ok", "Add retry to model download", "28")}
      ${task("bad", "Migrate config to TOML", "60")}
    </div>
    <div class="side-nav">
      ${nav("tasks", "Tasks", "12")}
      ${nav("models", "Models", "3")}
      ${nav("runtime", "Runtimes", "1")}
      ${nav("evals", "Evals", "")}
      ${nav("settings", "Settings", "")}
    </div>`;

  const s = document.querySelector(".stream");
  if (s) s.scrollTop = s.scrollHeight;
})();
