'use strict';

// Node.js wrapper around gpio_helper.py - one persistent Python process
// per GPIO line, talking over JSON-lines on stdin/stdout. Replaces
// gpio-libgpiod.js's CLI-wrapping approach entirely (gpioset/gpiomon
// spawned per-operation), which had a real, confirmed race condition
// in its output-write path and a separate, unexplained sensor value
// inversion under real hardware testing that did NOT reproduce via
// direct libgpiod Python API calls on the same hardware - see project
// notes and gpio_helper.py's own header comments.
//
// API SHAPE DELIBERATELY MATCHES gpio-libgpiod.js exactly, including
// which methods are async and which are synchronous fire-and-forget,
// specifically so index.js needs NO further changes beyond swapping
// which file it imports from:
//   - writeSync() / setDirection() / setActiveLow() are async (return
//     Promises) - index.js already awaits these, from the async
//     conversion done for gpio-libgpiod.js's write-path fix.
//   - watch() / setEdge() / unwatchAll() are synchronous, fire-and-
//     forget - index.js calls these without awaiting. This works
//     safely here because gpio_helper.py processes stdin commands
//     strictly in the order received (single-threaded main loop), so
//     commands sent in sequence from Node take effect in that same
//     sequence even without Node waiting for each response - the same
//     ordering guarantee index.js already depends on.
//   - readSync() is synchronous. For a sensor with an active watch, it
//     returns a value cached from the most recent real edge event (no
//     IPC round-trip needed) - same caching approach gpio-libgpiod.js
//     already used. For the very first read before any watch has
//     started (which index.js's constructor flow genuinely needs -
//     see getDoorStateInfo() called before activateDoorSensor()), a
//     brief, one-shot, synchronous bootstrap read via a separate
//     Python invocation supplies the initial value, fully completing
//     and releasing its own line request BEFORE the persistent helper
//     process opens the same line - sequential, not concurrent, so
//     there's no conflict between the two.

import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_SCRIPT = join(__dirname, 'gpio_helper.py');
const CHIP = '/dev/gpiochip0'; // confirmed on this hardware throughout the project

const liveChildren = new Set();
function trackChild(child) {
  liveChildren.add(child);
  child.on('exit', () => liveChildren.delete(child));
}
function killAllChildren() {
  for (const child of liveChildren) {
    try { child.kill('SIGTERM'); } catch (ignore) { /* already dead */ }
  }
}
process.on('exit', killAllChildren);
process.on('SIGINT', () => { killAllChildren(); process.exit(130); });
process.on('SIGTERM', () => { killAllChildren(); process.exit(143); });

const DEFAULT_TIMEOUT_MS = 5000;

// SUPERSEDES an earlier "onoffActiveLowToLibgpiod" inversion, which was
// itself a fix for a real bug but was ITSELF WRONG in a way that only
// surfaced through real Homebridge operation (a relay staying engaged
// for a full 12-second door-move cycle instead of a brief press).
//
// Root cause, confirmed directly against the Linux kernel's own sysfs
// GPIO source (drivers/gpio/gpiolib-sysfs.c), not assumed: onoff's
// two write paths are NOT electrically equivalent, by kernel design:
//   - writeSync() writes onoff's sysfs `value` file, handled by
//     gpio_value_store() -> gpiod_set_value_cansleep() - this DOES
//     apply active_low as a normal logical-to-physical inversion.
//   - onoff's construction-time / setDirection('high'|'low') writes
//     the sysfs `direction` file, handled by gpio_direction_store():
//       sysfs_streq(buf, "high") -> gpiod_direction_output_raw(desc, 1)
//     the `_raw` suffix is the kernel's own convention for "bypasses
//     active_low entirely, sets the physical pin level directly" -
//     confirmed by contrasting it with value's non-raw
//     gpiod_set_value_cansleep() in the same file. This is deliberate
//     upstream kernel design, not a driver quirk: `direction=high/low`
//     is documented as a glitch-free initialization convenience, and
//     the kernel authors made it immune to whatever active_low happens
//     to be configured, specifically so it can't be unexpectedly
//     inverted.
//
// Confirmed against this app's real, both-Pi behavior: production
// (onoff) reliably shows the relay released immediately after every
// Homebridge restart (direction='high', always physical HIGH,
// regardless of activeLow - matches _raw semantics) AND was directly,
// audibly confirmed via a stop/reverse test to trigger on
// writeSync(1)+activeLow:true (matches value's active_low-respecting
// semantics: logical-active + active_low=true => physical LOW =
// triggered for this relay).
//
// This module has ONE underlying line-request mechanism (gpiod's
// LineSettings), not onoff's two separate sysfs files/code paths, so
// it cannot literally replicate "two different kernel functions" - but
// it CAN and does replicate their combined real-world EFFECT:
//   - writeSync() -> reconfigure_lines() Value.ACTIVE/INACTIVE, WITH
//     active_low applied normally (direct passthrough of the caller's
//     activeLow, no inversion) - matching gpiod_set_value_cansleep().
//   - setDirection('high'|'low') -> compensates for whatever
//     active_low is CURRENTLY set, so the resulting physical level is
//     always the literal one requested, regardless of active_low -
//     matching gpiod_direction_output_raw()'s bypass behavior. See its
//     own implementation below for the exact compensation.
//
// This distinction turned out to matter for every device this app
// uses as an output (currently only the switch); it does not apply to
// sensors at all, since they're inputs and never call setDirection().

class Gpio {
  constructor(gpio, direction, edge, options) {
    if (typeof edge === 'object' && !options) {
      options = edge;
      edge = undefined;
    }
    options = options || {};

    this._offset = gpio;
    this._isOutput = direction === 'out' || direction === 'high' || direction === 'low';
    // Direct passthrough for BOTH outputs and inputs now - see the
    // header comment above for why outputs no longer need a special
    // inversion (the earlier inversion was compensating for the wrong
    // code path's semantics). Sensors were already verified correct as
    // direct passthrough earlier today; this is unchanged for them.
    this._activeLow = !!options.activeLow;
    this._edge = edge || 'none';
    this._debounceMs = options.debounceTimeout || 0;
    this._listeners = [];
    this._dispatchQueue = Promise.resolve(); // serializes edge-event dispatch - see _queueDispatch notes below
    this._lastValue = null;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._nextId = 1;
    this._watchActive = false; // Python-side watcher thread believed running
    this._reconfigureScheduled = false; // coalescing flag - see _scheduleReconfigure()

    if (!this._isOutput) {
      // See header comment - one-time synchronous bootstrap read,
      // fully self-contained, completes before the persistent helper
      // below ever touches this line.
      this._lastValue = this._bootstrapReadSync();
    }

    const pyDirection = this._isOutput
      ? (direction === 'high' ? 'high' : 'low') // matches gpio-libgpiod.js: non-'high' output defaults to low/0
      : 'in';

    const args = [
      HELPER_SCRIPT,
      '--chip', CHIP,
      '--offset', String(this._offset),
      '--direction', pyDirection,
      '--edge', 'none', // watcher thread only starts once watch() is actually called - see header comment
    ];
    if (this._activeLow) args.push('--active-low');
    if (this._debounceMs > 0) args.push('--debounce-ms', String(this._debounceMs));

    this._proc = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    trackChild(this._proc);

    this._buffered = '';
    this._proc.stdout.setEncoding('utf8');
    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._proc.stderr.on('data', (chunk) => {
      console.error(`gpio_helper.py (GPIO ${this._offset}) stderr:`, chunk.toString().trim());
    });
    this._proc.on('error', (err) => {
      console.error(`gpio_helper.py (GPIO ${this._offset}) failed to start:`, err);
    });
    this._proc.on('exit', (code, signal) => {
      // Don't leave any in-flight command hanging forever if the
      // helper process dies unexpectedly.
      for (const [, entry] of this._pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`gpio_helper.py for GPIO ${this._offset} exited (code=${code}, signal=${signal})`));
      }
      this._pending.clear();
    });
  }

  // --- internal helpers -----------------------------------------------

  _bootstrapReadSync() {
    const activeLowArg = this._activeLow ? 'True' : 'False';
    const script = [
      'import gpiod',
      'from gpiod.line import Direction, Value',
      `with gpiod.request_lines('${CHIP}', consumer='bootstrap-read', config={${this._offset}: gpiod.LineSettings(direction=Direction.INPUT, active_low=${activeLowArg})}) as r:`,
      `    print(1 if r.get_value(${this._offset}) == Value.ACTIVE else 0)`,
    ].join('\n');
    const stdout = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    const n = parseInt(stdout.trim(), 10);
    if (n !== 0 && n !== 1) {
      throw new Error(`bootstrap read for GPIO ${this._offset}: unexpected output ${JSON.stringify(stdout)}`);
    }
    return n;
  }

  _send(cmd, extra = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          reject(new Error(`gpio_helper.py command '${cmd}' (id=${id}, GPIO ${this._offset}) timed out`));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      const msg = { id, cmd, ...extra };
      this._proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  // Fire-and-forget variant for watch()/setEdge()/unwatchAll(), which
  // index.js calls synchronously without awaiting - see header comment
  // for why this is safe given gpio_helper.py's strict in-order
  // command processing. Errors are logged, not thrown at the caller.
  _sendNoWait(cmd, extra = {}) {
    this._send(cmd, extra).catch((err) => {
      console.error(`gpio_helper.py (GPIO ${this._offset}) command '${cmd}' failed:`, err.message);
    });
  }

  _onStdout(chunk) {
    this._buffered += chunk;
    const lines = this._buffered.split('\n');
    this._buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        console.error(`gpio_helper.py (GPIO ${this._offset}) sent unparseable line:`, JSON.stringify(line));
        continue;
      }
      if ('event' in msg) {
        this._handleEvent(msg);
      } else if ('id' in msg) {
        const entry = this._pending.get(msg.id);
        if (!entry) continue; // already timed out, or unknown id
        this._pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg);
        else entry.reject(new Error(msg.error || `gpio_helper.py (GPIO ${this._offset}): unknown error`));
      }
    }
  }

  _handleEvent(msg) {
    if (msg.event === 'edge') {
      this._lastValue = msg.value;
      this._queueDispatch(null, msg.value);
    } else if (msg.event === 'fatal') {
      console.error(`gpio_helper.py (GPIO ${this._offset}) fatal:`, msg.error);
      this._queueDispatch(new Error(msg.error));
    }
  }

  // IMPORTANT, found via real Homebridge testing (not assumed): an
  // earlier version fired every edge event's listener callback
  // immediately, with no serialization between separate events. Since
  // index.js's watch() callback runs a full async chain
  // (processDoorMoveEvent -> processDoorInterrupt -> updateDoorState,
  // including several reconfigure round-trips), several edge events
  // arriving close together (e.g. a magnet moved slowly past the
  // actuator, lingering near the threshold) could each kick off their
  // OWN full processing chain, all running interleaved rather than one
  // at a time - the state after the LAST one to finish wasn't
  // necessarily the one reflecting where the magnet actually ended up,
  // producing a door state that stopped updating even though real
  // events kept arriving. Confirmed via real Homebridge log output
  // showing multiple reconfigure command IDs in flight simultaneously
  // for the same line, not one at a time.
  //
  // Fix: queue dispatches on a promise chain, so each edge event's
  // FULL listener processing (including everything it awaits
  // internally) completes before the next event's dispatch begins.
  // This app's actual door movement is far slower than this adds as
  // overhead (a few tens of ms per event, confirmed via earlier
  // round-trip timing), so this doesn't introduce any meaningful lag
  // for real operation - see project notes on why manually-simulated
  // fast magnet movement isn't representative of the real door anyway.
  _queueDispatch(err, value) {
    this._dispatchQueue = this._dispatchQueue
      .then(() => this._dispatchToListenersSerial(err, value))
      .catch((e) => {
        console.error(`Unexpected error in dispatch queue for GPIO ${this._offset}:`, e);
      });
  }

  async _dispatchToListenersSerial(err, value) {
    for (const callback of this._listeners.slice(0)) {
      try {
        await callback(err, value);
      } catch (dispatchErr) {
        console.error(`Unhandled error in watch() callback for GPIO ${this._offset}:`, dispatchErr);
      }
    }
  }

  // --- public API (scoped to exactly what this app's index.js calls) --

  async writeSync(value) {
    await this._send('set_value', { value: value ? 1 : 0 });
  }

  readSync() {
    // NOTE: this used to fall back to a fresh _bootstrapReadSync() call
    // whenever no watch was active yet. Found via real testing (not
    // assumed) that this is genuinely unsafe: the persistent helper
    // process spawned in the constructor holds this line open for the
    // object's entire lifetime, and a SEPARATE process attempting to
    // request the same line fails with "Device or resource busy" -
    // confirmed directly, on a completely different code path than the
    // CLI-wrapper's own earlier, similar unverified-concurrent-access
    // question. This isn't just a test-script issue either: index.js's
    // own very first readSync() call (via getDoorStateInfo(), called
    // immediately after `new Gpio(...)` returns) would hit the exact
    // same collision in real usage, since the persistent helper is
    // already running by the time the constructor returns.
    //
    // Fix: rely entirely on the one-time construction-time bootstrap
    // value (which runs BEFORE the persistent helper exists, so it
    // can't collide with anything) plus real edge-event updates from
    // the persistent helper afterward - never attempt a second,
    // separate-process read after construction.
    if (this._lastValue !== null) {
      return this._lastValue;
    }
    // Should not normally be reachable for a correctly-constructed
    // input line (the constructor always sets _lastValue) - kept only
    // as a defensive last resort, not a normal operational path.
    return this._bootstrapReadSync();
  }

  async setDirection(direction) {
    // Scoped to this app's actual usage - only ever 'high'/'low',
    // matching gpio-libgpiod.js's same scoping.
    //
    // IMPORTANT: must always mean the literal physical level, immune
    // to whatever active_low is currently set - matching the kernel's
    // gpiod_direction_output_raw() semantics (see the header comment
    // above the class for the full kernel-source-verified explanation
    // and why this differs from writeSync()). Compensated here with
    // the same XOR logic gpio_helper.py's build_settings() uses:
    // Value.ACTIVE lands on physical HIGH only when active_low=False;
    // when active_low=True, Value.INACTIVE is needed instead to still
    // land on physical HIGH. Symmetric for 'low'/physical LOW.
    if (direction === 'high' || direction === 'low') {
      const wantHigh = direction === 'high';
      const outputValue = (wantHigh !== this._activeLow) ? 1 : 0;
      await this._send('reconfigure', { edge: this._isOutput ? 'none' : this._edge, output_value: outputValue });
    } else {
      throw new Error(
        `setDirection('${direction}') is not supported by this replacement - ` +
        `only 'high'/'low' are, matching this app's actual usage`
      );
    }
  }

  async setActiveLow(invert) {
    // Direct passthrough now, matching the constructor - see the
    // header comment above the class for why outputs no longer need a
    // special inversion here.
    this._activeLow = !!invert;
    await this._send('reconfigure', { active_low: this._activeLow, edge: this._isOutput ? 'none' : this._edge });
  }

  // IMPORTANT, found via real hardware/Homebridge testing (not
  // assumed): index.js's actual sequence for handling a real sensor
  // event is resetGarageDoorSensor() [-> unwatchAll()] immediately
  // followed, within the same synchronous chain (confirmed - no await
  // in between, traced through processDoorMoveEvent/processDoorInterrupt/
  // updateDoorState), by activateDoorSensor() [-> setEdge() + watch()]
  // to rearm for the next transition. Each of those three calls used to
  // send its OWN separate reconfigure to gpio_helper.py immediately -
  // meaning "disarm" (edge:none, tearing down the watcher thread) and
  // "rearm" (edge:<new>, spawning a new one) were two separate round
  // trips with a real gap between them. libgpiod does not buffer edge
  // events while a line is unrequested, so a genuine, real transition
  // occurring in that gap was silently lost - confirmed directly: a
  // magnet moved away and back within that window sometimes failed to
  // register at all ("feels like it's not armed").
  //
  // Fix: defer the actual reconfigure send to a microtask, coalescing
  // any of setEdge()/watch()/unwatchAll() called within the same
  // synchronous burst into ONE reconfigure reflecting the FINAL state
  // after all of them have run - going directly from the old edge type
  // to the new one when this app's real disarm-then-immediately-rearm
  // pattern happens, with no intermediate "off" state sent to Python at
  // all. A genuinely standalone unwatchAll() (nothing following it in
  // the same tick) still correctly resolves to edge:'none', since the
  // microtask reads _watchActive/_edge lazily, after all synchronous
  // mutations in that burst have already applied.
  _scheduleReconfigure() {
    if (this._reconfigureScheduled) return;
    this._reconfigureScheduled = true;
    queueMicrotask(() => {
      this._reconfigureScheduled = false;
      const edge = this._watchActive ? this._edge : 'none';
      this._sendNoWait('reconfigure', { edge });
    });
  }

  setEdge(edge) {
    this._edge = edge;
    this._scheduleReconfigure();
  }

  watch(callback) {
    this._listeners.push(callback);
    if (this._listeners.length === 1) {
      this._watchActive = true;
    }
    this._scheduleReconfigure();
  }

  unwatchAll() {
    this._listeners = [];
    this._watchActive = false;
    this._scheduleReconfigure();
  }
}

export { Gpio };
