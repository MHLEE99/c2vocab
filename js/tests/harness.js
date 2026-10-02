// Tiny test harness shared by js/tests.js and the files in js/tests/.
// No framework, no Node: tests register with test() and run() prints them into test.html.

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ? msg + ': ' : ''}expected ${b}, got ${a}`);
}

export async function throws(fn, msg) {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
  }
  if (!threw) throw new Error(msg || 'expected an error');
}

/** Run every registered test in order and write the results into the page. */
export async function run() {
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const li = document.createElement('li');
    try {
      await t.fn();
      passed += 1;
      li.className = 'pass';
      li.textContent = 'PASS  ' + t.name;
    } catch (err) {
      failed += 1;
      li.className = 'fail';
      li.textContent = 'FAIL  ' + t.name + ' — ' + (err && err.message ? err.message : String(err));
      console.error(t.name, err);
    }
    results.appendChild(li);
  }
  const line = `${passed} passed, ${failed} failed`;
  summary.textContent = line;
  summary.className = failed === 0 ? 'pass' : 'fail';
  document.title = line + ' · c2vocab tests';
}
