(() => {
  const storedLocale = localStorage.getItem("github-trend-radar:locale");
  const locale = storedLocale === "en" || storedLocale === "ko"
    ? storedLocale
    : navigator.languages.some((language) => language.toLowerCase().startsWith("ko"))
      ? "ko"
      : "en";
  document.documentElement.lang = locale;
})();
