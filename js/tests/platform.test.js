// Tests for js/platform.js (pure): service worker registration rule, iOS detection, install hints.

import { test, eq, deepEq } from './harness.js';
import { shouldRegisterSw, isIos, isIosSafari, isStandalone, installHint, emptyDbHint, onboardingHint } from '../platform.js';

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1';
const UA_IPADOS_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// iOS browsers and webviews that are NOT Safari (they cannot add to the home screen)
const UA_IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1';
const UA_IOS_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15';
const UA_IOS_KAKAO =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.6.0';
const UA_IOS_NAVER =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.3.0)';
const UA_IOS_LINE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.5.0';

test('platform: shouldRegisterSw on https, on http only with ?sw', () => {
  eq(shouldRegisterSw({ protocol: 'https:', hostname: 'mhlee99.github.io', search: '' }), true, 'https');
  eq(shouldRegisterSw({ protocol: 'http:', hostname: 'localhost', search: '' }), false, 'plain localhost');
  eq(shouldRegisterSw({ protocol: 'http:', hostname: '127.0.0.1', search: '' }), false, 'plain 127.0.0.1');
  eq(shouldRegisterSw({ protocol: 'http:', hostname: '127.0.0.1', search: '?sw=1' }), true, '?sw=1');
  eq(shouldRegisterSw({ protocol: 'http:', hostname: 'localhost', search: '?sw' }), true, 'bare ?sw');
  eq(shouldRegisterSw({ protocol: 'http:', hostname: 'localhost', search: '?modo=nuevas' }), false, 'other query');
  eq(shouldRegisterSw({}), false, 'no information: do not register');
});

test('platform: isIos recognises iPhone, iPad, iPadOS-as-Macintosh with touch; not Android/Windows', () => {
  eq(isIos(UA_IPHONE), true, 'iPhone');
  eq(isIos(UA_IPAD), true, 'iPad');
  eq(isIos(UA_IPADOS_DESKTOP, 5), true, 'iPadOS desktop UA + touch points');
  eq(isIos(UA_IPADOS_DESKTOP, 0), false, 'real Mac: no touch points');
  eq(isIos(UA_IPADOS_DESKTOP), false, 'real Mac: touch points not given');
  eq(isIos(UA_ANDROID, 5), false, 'Android');
  eq(isIos(UA_WINDOWS, 10), false, 'Windows touch laptop');
  eq(isIos(''), false, 'empty');
  eq(isIos(null), false, 'null');
});

test('platform: isIosSafari is true for Safari only, not Chrome/Firefox/webviews on iOS, not Android', () => {
  eq(isIosSafari(UA_IPHONE), true, 'iPhone Safari');
  eq(isIosSafari(UA_IPAD), true, 'iPad Safari');
  eq(isIosSafari(UA_IPADOS_DESKTOP, 5), true, 'iPadOS Safari desktop UA + touch points');
  eq(isIosSafari(UA_IPADOS_DESKTOP, 0), false, 'real Mac');
  eq(isIosSafari(UA_IOS_CHROME), false, 'Chrome on iOS');
  eq(isIosSafari(UA_IOS_FIREFOX), false, 'Firefox on iOS');
  eq(isIosSafari(UA_IOS_KAKAO), false, 'KakaoTalk in-app webview');
  eq(isIosSafari(UA_IOS_NAVER), false, 'Naver in-app webview');
  eq(isIosSafari(UA_IOS_LINE), false, 'Line in-app webview');
  eq(isIosSafari(UA_ANDROID), false, 'Android');
  eq(isIosSafari(UA_WINDOWS), false, 'Windows');
  eq(isIosSafari(''), false, 'empty');
  eq(isIosSafari(null), false, 'null');
});

test('platform: isStandalone from navigator.standalone or the display-mode media query', () => {
  eq(isStandalone({ navigatorStandalone: true, matchMediaStandalone: false }), true, 'Safari flag');
  eq(isStandalone({ navigatorStandalone: undefined, matchMediaStandalone: true }), true, 'media query');
  eq(isStandalone({ navigatorStandalone: false, matchMediaStandalone: false }), false);
  eq(isStandalone({}), false, 'nothing known');
  eq(isStandalone(), false, 'no argument');
});

test('platform: installHint shows on iOS Safari, hides when standalone, snoozed or not iOS', () => {
  const base = { ios: true, standalone: false, snoozeDay: null, today: '2026-11-08', cardCount: 12 };
  deepEq(installHint(base), { kind: 'ios' }, 'iOS browser tab');
  deepEq(installHint({ ...base, cardCount: 0 }), { kind: 'ios' }, 'also on an empty database');
  eq(installHint({ ...base, standalone: true }), null, 'already installed');
  eq(installHint({ ...base, snoozeDay: '2026-11-08' }), null, 'snoozed today');
  eq(installHint({ ...base, snoozeDay: '2026-11-09' }), null, 'snoozed on a later day (clock moved back)');
  deepEq(installHint({ ...base, snoozeDay: '2026-11-07' }), { kind: 'ios' }, 'snooze expired yesterday');
  eq(installHint({ ...base, ios: false }), null, 'Android / desktop');
  eq(installHint({}), null, 'nothing known');
});

test('platform: installHint kind: ios for Safari, ios-other for Chrome/KakaoTalk on iOS', () => {
  const base = { ios: true, standalone: false, snoozeDay: null, today: '2026-11-08', cardCount: 0 };
  deepEq(installHint({ ...base, safari: true }), { kind: 'ios' }, 'Safari tab');
  deepEq(installHint({ ...base, safari: undefined }), { kind: 'ios' }, 'browser not known: Safari steps');
  deepEq(installHint({ ...base, safari: false }), { kind: 'ios-other' }, 'Chrome / KakaoTalk webview');
  eq(installHint({ ...base, safari: false, standalone: true }), null, 'installed: nothing to tell');
  eq(installHint({ ...base, safari: false, snoozeDay: '2026-11-08' }), null, 'ios-other also snoozes');
  eq(installHint({ ...base, ios: false, safari: false }), null, 'not iOS at all');
});

test('platform: onboardingHint: import on an empty db, install-first while the iOS banner shows', () => {
  eq(onboardingHint({ cardCount: 0, install: null }), 'import', 'empty db, Android/desktop/installed app');
  eq(onboardingHint({ cardCount: 0, install: { kind: 'ios' } }), 'install-first', 'empty db in a Safari tab');
  eq(onboardingHint({ cardCount: 0, install: { kind: 'ios-other' } }), 'install-first', 'empty db in a webview');
  eq(onboardingHint({ cardCount: 3, install: { kind: 'ios' } }), null, 'cards exist: no onboarding');
  eq(onboardingHint({ cardCount: 3, install: null }), null, 'cards exist');
  eq(onboardingHint({ cardCount: undefined }), null, 'unknown count: no hint');
  eq(onboardingHint(), null, 'no argument');
});

test('platform: emptyDbHint only for a database without live cards', () => {
  eq(emptyDbHint(0), true);
  eq(emptyDbHint(1), false);
  eq(emptyDbHint(20), false);
  eq(emptyDbHint(undefined), false, 'unknown count: no hint');
});
