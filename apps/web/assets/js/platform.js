/* Runs before first paint: the download page renders one hero, not four, and
 * in-app browsers (which cannot save files) are flagged immediately. Kept as a
 * separate blocking file so every page shares one detector. */
(function () {
  var ua = navigator.userAgent;
  var u = ua.toLowerCase();
  var platform = /android/.test(u)
    ? 'android'
    : /iphone|ipod/.test(u)
      ? 'ios'
      : /ipad/.test(u) || (/macintosh/.test(u) && navigator.maxTouchPoints > 1)
        ? 'ios'
        : /windows/.test(u)
          ? 'windows'
          : /mac os x|macintosh/.test(u)
            ? 'mac'
            : 'other';
  document.documentElement.dataset.platform = platform;
  if (/(FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Snapchat|Pinterest|; wv\))/i.test(ua)) {
    document.documentElement.dataset.inapp = 'true';
  }
})();
