/**
 * VS Code sets `vscode-light` / `vscode-dark` / `vscode-high-contrast` on
 * `<body>` and live-updates it when the user switches themes. Mirror that
 * onto `<html class="dark">` so Tailwind's class-based dark mode engages --
 * this is what makes the webview follow the host editor's theme instead of
 * carrying a fixed light/dark choice of its own.
 *
 * Outside VS Code (plain browser preview during development), body never
 * gets a vscode-* class, so this falls back to the OS/browser's
 * prefers-color-scheme -- the preview still looks right, it just isn't
 * following a host that doesn't exist yet.
 */
export function initVsCodeThemeSync(): void {
  const apply = () => {
    const body = document.body;
    const isDark =
      body.classList.contains('vscode-dark') ||
      body.classList.contains('vscode-high-contrast') ||
      (!body.classList.contains('vscode-light') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
  };

  apply();
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}
