export function ShellPreview() {
  return (
    <div className="shell-preview">
      <header className="shell-preview-topbar">
        <div className="shell-preview-traffic" aria-hidden="true">
          <span className="traffic-light red" />
          <span className="traffic-light yellow" />
          <span className="traffic-light green" />
        </div>

        <div className="shell-preview-titleblock">
          <div className="shell-preview-title">ZTerm Shell</div>
          <div className="shell-preview-subtitle">default = single shell · split on demand · tabs inside each pane</div>
        </div>

        <div className="shell-preview-actions">
          <span className="shell-preview-pill active">⌘K</span>
          <span className="shell-preview-pill">split</span>
          <span className="shell-preview-pill">profile</span>
        </div>
      </header>

      <div className="shell-preview-toolbar">
        <button type="button" className="shell-preview-menu-button">Profiles</button>

        <div className="shell-preview-toolbar-center">
          <div className="shell-preview-profile-name">~/Documents/github/zterm</div>
          <div className="shell-preview-profile-meta">restore last shell · tabs · splits · connections</div>
        </div>

        <div className="shell-preview-tabs">
          <button type="button" className="shell-preview-tab active">tmux</button>
          <button type="button" className="shell-preview-tab">logs</button>
          <button type="button" className="shell-preview-tab add">+</button>
        </div>
      </div>

      <main className="shell-preview-stage">
        <section className="shell-preview-shell">
          <div className="shell-preview-shell-top">
            <div className="shell-preview-shell-tabs">
              <button type="button" className="shell-preview-pane-tab active">single pane</button>
            </div>

            <div className="shell-preview-shell-actions">
              <button type="button" className="shell-preview-shell-action">Split</button>
              <button type="button" className="shell-preview-shell-action">+</button>
            </div>
          </div>

          <div className="shell-preview-shell-body">
            <div className="shell-preview-terminal-panel">
              <div className="shell-preview-statusline">
                <span className="shell-preview-status connected">CONNECTED</span>
                <span>100.86.84.63:3333 · wterm</span>
                <span>session: main</span>
              </div>

              <div className="shell-preview-terminal-lines">
                <div>• default shell is single pane</div>
                <div>• split is on demand and starts equal</div>
                <div>• panes can be dragged to resize</div>
                <div>• each pane can hold multiple tabs</div>
                <div>• quick menu is overlay, not persistent sidebar</div>
              </div>
            </div>

            <div className="shell-preview-drag-rail" aria-hidden="true">
              <span className="shell-preview-drag-dot" />
            </div>
          </div>
        </section>
      </main>

      <div className="shell-preview-palette-overlay">
        <section className="shell-preview-palette">
          <div className="shell-preview-palette-top">
            <div className="shell-preview-palette-tabs">
              <button type="button" className="shell-preview-palette-tab active">快捷输入</button>
              <button type="button" className="shell-preview-palette-tab">剪贴板</button>
            </div>

            <div className="shell-preview-palette-search">
              <span className="shell-preview-search-icon">⌕</span>
              <span>搜索</span>
            </div>
          </div>

          <div className="shell-preview-palette-list">
            <div className="shell-preview-palette-item active">
              <span className="shell-preview-palette-index">⌥1</span>
              <span className="shell-preview-palette-text">tmux attach -t main</span>
            </div>
            <div className="shell-preview-palette-item">
              <span className="shell-preview-palette-index">⌥2</span>
              <span className="shell-preview-palette-text">ssh 100.86.84.63</span>
            </div>
            <div className="shell-preview-palette-item">
              <span className="shell-preview-palette-index">⌥3</span>
              <span className="shell-preview-palette-text">cd ~/Documents/github/zterm</span>
            </div>
            <div className="shell-preview-palette-item">
              <span className="shell-preview-palette-index">⌥4</span>
              <span className="shell-preview-palette-text">pnpm --filter @zterm/mac package</span>
            </div>
            <div className="shell-preview-palette-item">
              <span className="shell-preview-palette-index">⌥5</span>
              <span className="shell-preview-palette-text">install bundle</span>
            </div>
          </div>

          <div className="shell-preview-palette-foot">
            <span className="shell-preview-shortcut">⌘J</span>
            <span>快捷键呼出，tab 切换快捷输入 / 剪贴板</span>
          </div>
        </section>
      </div>
    </div>
  );
}
