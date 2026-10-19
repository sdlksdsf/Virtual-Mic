/* Shared icon sprite. Injected once so every page stays in sync. */
(function () {
  'use strict';
  if (document.getElementById('voxbridge-sprite')) return;
  const sprite = document.createElement('div');
  sprite.id = 'voxbridge-sprite';
  sprite.setAttribute('aria-hidden', 'true');
  sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  sprite.innerHTML = `
  <svg xmlns="http://www.w3.org/2000/svg">
    <symbol id="i-windows" viewBox="0 0 24 24"><path d="M3.5 5.4 11 4.3v7.1H3.5Zm8.7-1.2L21 3v8.4h-8.8ZM3.5 12.7H11v7.1l-7.5-1.1Zm8.7 0H21V21l-8.8-1.3Z"/></symbol>
    <symbol id="i-android" viewBox="0 0 24 24"><path d="M6 10.5h12v7.2a1.8 1.8 0 0 1-1.8 1.8H7.8A1.8 1.8 0 0 1 6 17.7ZM8.4 6.2 7.3 4.5M15.6 6.2l1.1-1.7"/><path d="M7.5 10.5V6.9a4.5 4.5 0 0 1 9 0v3.6M3.6 11.6v4.6M20.4 11.6v4.6M10 15.6h.01M14 15.6h.01"/><circle cx="12" cy="6.9" r="4.5"/></symbol>
    <symbol id="i-apple" viewBox="0 0 24 24"><path d="M15.6 12.4c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.1-2.9.9-3.6.9-.7 0-1.9-.9-3.1-.9-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.6.8 1.2 1.7 2.5 3 2.4 1.2-.1 1.6-.8 3.1-.8s1.8.8 3.1.8c1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.6-1-2.6-3.7ZM14 5.3c.6-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.2-.6 2.8-1.4Z"/></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v12M8 11l4 4 4-4M4 19h16"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5 9 17l10.5-10.5"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6Z"/><path d="M9.5 12.2 11.4 14l3.4-3.6"/></symbol>
    <symbol id="i-wave" viewBox="0 0 24 24"><path d="M3 12h2l2-5 3 10 3-14 3 12 2-3h3"/></symbol>
    <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6"/></symbol>
    <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></symbol>
    <symbol id="i-wifi" viewBox="0 0 24 24"><path d="M3 8.5a14 14 0 0 1 18 0M6 12a9.5 9.5 0 0 1 12 0M9 15.4a5 5 0 0 1 6 0"/><circle cx="12" cy="19" r="1"/></symbol>
    <symbol id="i-usb" viewBox="0 0 24 24"><path d="M12 21V6M12 6l-2.5 2M12 6l2.5 2M12 13l-4-2.5M8 10.5V8M8 10.5l-2 1.5M12 16l3.5-2.5M15.5 13.5V11M15.5 13.5l1.5 1"/><circle cx="12" cy="3.5" r="1.5"/></symbol>
    <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
    <symbol id="i-github" viewBox="0 0 24 24"><path d="M9 20.5c-4 1.2-4-2-5.5-2.5M15 22v-3.4a3 3 0 0 0-.8-2.3c2.6-.3 5.3-1.3 5.3-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.4 11.4 0 0 0-6 0C6 3.6 5 3.9 5 3.9a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 3.5 10.3c0 4.7 2.7 5.7 5.3 6A3 3 0 0 0 8 18.6V22"/></symbol>
    <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/></symbol>
    <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"/></symbol>
    <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
    <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></symbol>
    <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></symbol>
    <symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12Z"/></symbol>
    <symbol id="i-disc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.6"/></symbol>
    <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></symbol>
    <symbol id="i-plug" viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v4"/></symbol>
    <symbol id="i-radio" viewBox="0 0 24 24"><path d="M4 9.5a8 8 0 0 1 16 0M7 13a5 5 0 0 1 10 0"/><circle cx="12" cy="17" r="1.6"/><path d="M12 3v1.5"/></symbol>
    <symbol id="i-phone" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 5h3M12 18.2h.01"/></symbol>
    <symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/></symbol>
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
    <symbol id="i-volume" viewBox="0 0 24 24"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4Z"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11"/></symbol>
    <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></symbol>
    <symbol id="i-chip" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></symbol>
    <symbol id="i-monitor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></symbol>
  </svg>`;
  document.body.prepend(sprite);
})();
