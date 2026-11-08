// Platform decisions for the PWA (service worker, iOS, installed mode). PURE: every input is a
// parameter, nothing reads window/navigator here, so the rules are testable from test.html.

/**
 * Should the page register the service worker?
 *   https            yes (the published site)
 *   http + ?sw=1     yes (local acceptance run: http://127.0.0.1:8080/?sw=1)
 *   plain http       no  (daily development on localhost keeps using the no-store server)
 * `hostname` is accepted for symmetry with window.location but does not change the answer:
 * registering is decided by the protocol and the query only.
 */
export function shouldRegisterSw({ protocol, hostname, search } = {}) {
  if (protocol === 'https:') return true;
  const query = typeof search === 'string' ? search : '';
  return new URLSearchParams(query).has('sw');
}

/**
 * Is this an iOS device? iPhone / iPad / iPod user agents, plus iPadOS 13+, which pretends to be
 * a Macintosh but reports touch points (pass navigator.maxTouchPoints as the second argument).
 */
export function isIos(userAgent, maxTouchPoints = 0) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && Number(maxTouchPoints) > 1;
}

/**
 * Is this iOS *Safari*, the only iOS browser that can add a web app to the home screen?
 * Chrome / Firefox / Edge / Opera / DuckDuckGo on iOS and the in-app webviews of KakaoTalk, Naver,
 * Line, Facebook and Instagram all say 'iPhone' but cannot install: they get an "open this in
 * Safari" banner instead of the share-button steps.
 */
const IOS_NOT_SAFARI_RE = /CriOS|FxiOS|EdgiOS|OPT\/|DuckDuckGo|KAKAOTALK|NAVER|Line\/|FBAN|FBAV|Instagram/;

export function isIosSafari(userAgent, maxTouchPoints = 0) {
  if (!isIos(userAgent, maxTouchPoints)) return false;
  return !IOS_NOT_SAFARI_RE.test(userAgent);
}

/**
 * Is the app running as an installed home-screen app?
 *   navigatorStandalone   navigator.standalone (Safari only)
 *   matchMediaStandalone  window.matchMedia('(display-mode: standalone)').matches
 */
export function isStandalone({ navigatorStandalone, matchMediaStandalone } = {}) {
  return navigatorStandalone === true || matchMediaStandalone === true;
}

/**
 * Decide whether Inicio shows the "install me on the home screen" banner.
 *   ios         isIos(...)
 *   safari      isIosSafari(...); false = another iOS browser or an in-app webview (KakaoTalk...)
 *   standalone  isStandalone(...)
 *   snoozeDay   study day on which 'Más tarde' was pressed (meta installHintSnoozeDay), or null
 *   today       the current study day ('YYYY-MM-DD')
 *   cardCount   live cards; accepted for symmetry with the export reminder but the banner shows
 *               with or without cards (installing BEFORE importing is what keeps the data in one place)
 * Returns null (no banner), { kind: 'ios' } (Safari: share button -> add to home screen) or
 * { kind: 'ios-other' } (another iOS browser / webview: open the address in Safari first).
 * Android/desktop browsers get their own beforeinstallprompt button in Ajustes instead of a banner.
 */
export function installHint({ ios, safari, standalone, snoozeDay, today, cardCount } = {}) {
  if (!ios) return null;
  if (standalone) return null;
  if (snoozeDay && today && String(snoozeDay) >= String(today)) return null;
  return { kind: safari === false ? 'ios-other' : 'ios' };
}

/** Show the "import your file first" onboarding hint? Only on a database without any live card. */
export function emptyDbHint(cardCount) {
  return Number(cardCount) === 0;
}

/**
 * Which onboarding banner does an empty database get?
 *   null             there are cards: no banner
 *   'import'         no cards: import the export file from the other device before 'Cargar ejemplos'
 *   'install-first'  no cards AND the iOS install banner is showing (`install` = installHint(...) result):
 *                    install first and import INSIDE the installed app. iOS keeps separate storage
 *                    for the home-screen app and for browser tabs, so an import here would land in
 *                    the wrong place and the installed app would still be empty.
 */
export function onboardingHint({ cardCount, install } = {}) {
  if (!emptyDbHint(cardCount)) return null;
  return install ? 'install-first' : 'import';
}
