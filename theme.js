/* Apply the saved theme before the stylesheet paints to avoid a flash. */
(() => {
  const KEY = "agent-factory-theme";
  let preference = "auto";
  try {
    preference = localStorage.getItem(KEY) || "auto";
  } catch {
    preference = "auto";
  }
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const theme = preference === "dark" || (preference === "auto" && systemDark) ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
})();
