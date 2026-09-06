'use strict';

// libgpiod v2.x-based replacement for onoff's `Gpio` class.
//
// SUPERSEDES an earlier v1-targeted version of this file. Current
// Raspberry Pi OS (Trixie-based) ships libgpiod v2.2.1, confirmed via
// `gpioget --version` / `dpkg -l` on the real target hardware - a
// meaningfully different CLI (and gpiomon output format) than v1.x,
// which is what the first draft of this module was built against. Do
// not reuse the earlier version on a v2 system - the syntax and output
// formats genuinely differ (confirmed by hand on both versions, not
// assumed from docs).
//
// VERIFIED AGAINST REAL HARDWARE (Raspberry Pi OS Lite, Trixie,
// libgpiod v2.2.1 confirmed via `gpioget --version` / `dpkg -l`):
//   - CLI syntax: `--chip gpiochip0 <offset>` (or `<offset>=<value>` for
//     gpioset), confirmed via `gpioget/gpioset/gpiomon --help`.
//   - `gpioget --numeric --chip gpiochip0 <offset>` prints a bare '0' or
//     '1' with no quoting - confirmed real output.
//   - `gpiomon`'s default output format was confirmed
//     (`<timestamp>\t<rising|falling>\tgpiochip0 <offset> "<name>"`), but
//     this module instead uses `-F '%o %E'` for a minimal, easy-to-parse
//     format (`<offset> <rising|falling>`), per the format specifiers
//     documented in `gpiomon --help`.
//   - `gpioget`/`gpioset`/`gpiomon` all support `-l/--active-low`
//     (confirmed in their --help text); this module passes it through
//     to the CLI tools rather than inverting values in JS, so `rising`/
//     `falling` from gpiomon and the value from gpioget are already
//     correct from the caller's (onoff-compatible) point of view.
//   - `gpioset` does NOT have an interactive/stdin mode in v2 either -
//     confirmed via --help ("gpioset does not exit" by default, no
//     documented way to send a new value to an already-running
//     process). So writeSync() still uses the same kill-old/spawn-new
//     approach as the v1 draft: changing an output value briefly floats
//     the line for however long the OS takes to schedule the new
//     process. Given your relay's confirmed-safe floating/idle
//     behavior, this should be a non-issue, but it's a structural
//     property of the character-device model, not something this module
//     works around.
//   - Real hand-tested edge behavior on this hardware showed contact
//     bounce (several rising/falling pairs within under a millisecond)
//     when sliding a magnet past the actuator sensor by hand - very
//     possibly a test-method artifact rather than how the real door's
//     sensor behaves, but v2's `gpiomon -p/--debounce-period` is wired
//     up here (off by default, matching original onoff behavior which
//     this app never enabled) in case real-hardware testing shows it's
//     needed.
//
// NOT VERIFIED - flagging rather than guessing:
//   - Whether a separate gpioget call can safely read an input line
//     while gpiomon already holds it open for monitoring. Still
//     unconfirmed on v2 (nothing in the --help output settles this
//     either way). To avoid relying on unverified concurrent-access
//     behavior, readSync() on a line with an active watch() does NOT
//     spawn a fresh gpioget - it returns the last value seen via the
//     running gpiomon process instead. Only the very first readSync()
//     before any watch is active does a real gpioget call. If you want
//     to verify concurrent access is actually fine on this system, run
//     `gpiomon` in one terminal and `gpioget` on the same line in
//     another, and let me know - this module could be simplified if so.
//   - The exact grace period needed for a freshly spawned `gpioset`
//     process to actually acquire the line before writeSync() returns -
//     see briefSyncPause() below. Still a pragmatic approximation, not a
//     verified guarantee.
//   - This was captured on a test bed simulating two garage doors, not
//     the actual production 3A+ hardware/wiring. Re-verify chip name and
//     line layout there before deploying.
//
// REMOVED, not ported (confirmed with the app's author this was
// sysfs-era-only workaround code):
//   - ignoreGPIOinUse / stale-export detection and forced unexport. A
//     libgpiod line request is tied to an open file descriptor and is
//     released automatically when the owning process exits for any
//     reason, so there's no cross-process stale-export state to clean
//     up on next startup.
//
// SCOPED DOWN (matches only how this app's index.js actually calls
// onoff - see the code review this was built from):
//   - setDirection() only supports 'high'/'low', matching this app's
//     actual usage (always reasserting a fixed idle output level -
//     confirmed with the app's author to be pure internal bookkeeping
//     for a case where the wall switch and relay are wired in parallel
//     at the door opener's terminals, not through the Pi's GPIO pin).
//   - No debounceTimeout support by default (see debounce note above) -
//     this app's index.js never passes it, but the option exists on the
//     constructor if real-hardware testing shows it's needed.
//   - No async read()/write(), no unwatch(specificCallback), no
//     direction()/edge()/activeLow() getters, no Gpio.HIGH/LOW/accessible
//     - none of these are used by this app's index.js.

import { spawn, execFileSync } from 'node:child_process';

const CHIP = 'gpiochip0'; // confirmed on both the 3B and the Trixie test bed

const liveChildren = new Set();

function trackChild(child) {
  liveChildren.add(child);
  child.on('exit', () => liveChildren.delete(child));
  return child;
}

function killAllChildren() {
  for (const child of liveChildren) {
    try { child.kill('SIGTERM'); } catch (ignore) { /* already dead */ }
  }
}

process.on('exit', killAllChildren);
process.on('SIGINT', () => { killAllChildren(); process.exit(130); });
process.on('SIGTERM', () => { killAllChildren(); process.exit(143); });

// Node has no official synchronous sleep; this bounded busy-wait is the
// common pragmatic workaround, used only to give a freshly spawned
// `gpioset` process a moment to actually acquire the line before
// writeSync() returns. See the NOT VERIFIED note above about tuning
// this if real-hardware timing shows it's needed.
function briefSyncPause(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

function activeLowFlags(activeLow) {
  return activeLow ? ['--active-low'] : [];
}

function readValueSync(offset, activeLow) {
  const args = ['--numeric', ...activeLowFlags(activeLow), '--chip', CHIP, String(offset)];
  const stdout = execFileSync('gpioget', args, { encoding: 'utf8' });
  const n = parseInt(stdout.trim(), 10);
  if (n !== 0 && n !== 1) {
    throw new Error(`unexpected gpioget output: ${JSON.stringify(stdout)}`);
  }
  return n; // already logical (activeLow applied by the CLI tool itself)
}

// Matches the minimal custom format this module requests from gpiomon
// via `-F '%o %E'`, e.g.: "17 rising" / "17 falling"
const GPIOMON_EVENT_RE = /^(\d+)\s+(rising|falling)\s*$/;

class Gpio {
  constructor(gpio, direction, edge, options) {
    if (typeof edge === 'object' && !options) {
      options = edge;
      edge = undefined;
    }
    options = options || {};

    this._offset = gpio;
    this._activeLow = !!options.activeLow;
    this._debouncePeriodMs = options.debounceTimeout || 0; // off by default, see notes above
    this._edge = edge || 'none';
    this._listeners = [];
    this._gpiomon = null;      // child process currently monitoring edges, or null
    this._lastValue = null;    // last known logical value, updated by gpiomon events
    this._holder = null;       // persistent gpioset process for output lines, or null
    this._isOutput = direction === 'out' || direction === 'high' || direction === 'low';

    if (this._isOutput) {
      const initialLogical = direction === 'high' ? 1 : 0;
      this._driveOutput(initialLogical);
    }
  }

  // --- internal helpers -----------------------------------------------

  _driveOutput(logicalValue) {
    if (this._holder) {
      try { this._holder.kill('SIGTERM'); } catch (ignore) { /* already dead */ }
      this._holder = null;
    }

    const args = [
      ...activeLowFlags(this._activeLow),
      '--chip', CHIP,
      `${this._offset}=${logicalValue}`,
    ];
    const child = spawn('gpioset', args, { stdio: 'ignore' });
    child.on('error', (err) => {
      console.error(`gpioset spawn error for GPIO ${this._offset}:`, err);
    });
    trackChild(child);
    this._holder = child;
    this._lastValue = logicalValue;

    briefSyncPause(30); // see NOT VERIFIED note above
  }

  _startMonitoring() {
    if (this._gpiomon) return; // already watching

    const edgeFlag =
      this._edge === 'rising' ? 'rising' :
      this._edge === 'falling' ? 'falling' :
      this._edge === 'both' ? 'both' :
      null;
    if (!edgeFlag) return; // edge 'none' - nothing to monitor

    const args = [
      '--chip', CHIP,
      '--edges', edgeFlag,
      '--format', '%o %E',
      ...activeLowFlags(this._activeLow),
    ];
    if (this._debouncePeriodMs > 0) {
      args.push('--debounce-period', `${this._debouncePeriodMs}ms`);
    }
    args.push(String(this._offset));

    const child = spawn('gpiomon', args);
    trackChild(child);

    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop(); // keep any partial trailing line for next chunk

      for (const line of lines) {
        const match = GPIOMON_EVENT_RE.exec(line);
        if (!match) continue;

        // -l/--active-low is passed through to gpiomon itself, which
        // per its --help text "flip[s] the sense of rising and falling
        // edges" - so 'rising' here already means "transitioned to
        // logical 1" from the caller's point of view, no extra
        // inversion needed.
        const logicalValue = match[2] === 'rising' ? 1 : 0;
        this._lastValue = logicalValue;

        this._listeners.slice(0).forEach((callback) => callback(null, logicalValue));
      }
    });

    child.on('error', (err) => {
      this._listeners.slice(0).forEach((callback) => callback(err));
    });

    this._gpiomon = child;
  }

  _stopMonitoring() {
    if (!this._gpiomon) return;
    try { this._gpiomon.kill('SIGTERM'); } catch (ignore) { /* already dead */ }
    this._gpiomon = null;
  }

  // --- public API (scoped to exactly what this app's index.js calls) --

  writeSync(value) {
    this._driveOutput(value ? 1 : 0);
  }

  readSync() {
    if (this._gpiomon && this._lastValue !== null) {
      // A watch is active - avoid a second process touching the same
      // line concurrently (see NOT VERIFIED note above).
      return this._lastValue;
    }
    const value = readValueSync(this._offset, this._activeLow);
    this._lastValue = value;
    return value;
  }

  setDirection(direction) {
    // Scoped to this app's actual usage - see SCOPED DOWN note above.
    if (direction === 'high') {
      this._isOutput = true;
      this._driveOutput(1);
    } else if (direction === 'low') {
      this._isOutput = true;
      this._driveOutput(0);
    } else {
      throw new Error(
        `setDirection('${direction}') is not supported by this replacement - ` +
        `only 'high'/'low' are, matching this app's actual usage`
      );
    }
  }

  setActiveLow(invert) {
    const wasOutput = this._isOutput;
    const previousLogical = wasOutput ? this._lastValue : null;

    this._activeLow = !!invert;

    // Reassert the same logical value under the new polarity setting.
    if (wasOutput && previousLogical !== null) {
      this._driveOutput(previousLogical);
    }
  }

  setEdge(edge) {
    this._edge = edge;
    if (this._gpiomon) {
      // Edge changed while already watching - respawn with new flags.
      // Confirmed necessary: this app's activateDoorSensor() calls
      // setEdge() again on every door-state transition even while a
      // watch is already active (watch() itself is skipped in that case
      // via the interrupt.count guard), so setEdge() must apply live.
      this._stopMonitoring();
      this._startMonitoring();
    }
  }

  watch(callback) {
    this._listeners.push(callback);
    if (this._listeners.length === 1) {
      this._startMonitoring();
    }
  }

  unwatchAll() {
    this._listeners = [];
    this._stopMonitoring();
  }
}

export { Gpio };
