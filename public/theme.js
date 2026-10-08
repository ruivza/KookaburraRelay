// Run before the stylesheet so a saved appearance is applied on the first paint.
(() => {
  const key = 'kookaburra-theme';
  const media = matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => ['light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = normalize(localStorage.getItem(key)); } catch {}
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.themePreference = preference;
    window.dispatchEvent(new Event('themechange'));
  }
  window.relayTheme = {
    get preference() { return preference; },
    set(value) {
      preference = normalize(value);
      try { localStorage.setItem(key, preference); } catch {}
      apply();
    },
  };
  media.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = normalize(event.newValue);
      apply();
    }
  });
  apply();
})();
