#!/usr/bin/env python3
"""
gpio_helper.py - one persistent process per GPIO line, holding a real
libgpiod LineRequest open for its entire lifetime, talking to a parent
process (Node.js) over JSON-lines on stdin/stdout.

SUPERSEDES gpio-libgpiod.js's CLI-wrapping approach (gpioset/gpiomon
spawned as subprocesses), which had a real, confirmed race condition in
its output-write path (kill-old/spawn-new with no reliable confirmation
- see project notes) and, separately, a still-unexplained sensor value
inversion under real hardware testing. This uses libgpiod's own Python
bindings (the `gpiod` module - confirmed present, version 2.2.1, via
`python3 -c "import gpiod; print(gpiod.api_version)"` on the real target
Pi) directly - no subprocess spawning per operation, no text parsing of
another program's CLI output at all.

Confirmed on real hardware (not assumed) before this was written:
  - request_lines()/LineSettings/LineRequest.get_value/set_value/
    reconfigure_lines/wait_edge_events/read_edge_events all exist with
    the signatures used below - verified via `help()` on the real
    installed module, not from memory of the API.
  - Direct get_value() reads on both a NO-wired sensor (GPIO24) and an
    NC-wired sensor (GPIO13) returned correct, physically-verified
    values (magnet position confirmed against Value.ACTIVE/INACTIVE by
    hand) - the CLI-wrapper's inversion bug does NOT reproduce via this
    API, on the same hardware.

IMPORTANT, confirmed on real hardware (not assumed - this is the fix
for a real problem found by testing): calling LineRequest.release()
does NOT float or reset the physical pin. It only gives up userspace
tracking of the line - the GPIO controller keeps driving whatever
value was last set, indefinitely, until something else changes it.
This was discovered directly: a switch left at its "triggered" value
stayed triggered (light on, relay audibly closed) even after
release() was called, and only cleared on a full Pi reboot. That is a
real behavioral difference from the earlier CLI-wrapper design (where
a killed `gpioset` process WAS confirmed to let the line float safely)
- this module cannot rely on "the request going away" as an implicit
safety net the way the old design could. Every exit path this process
can actually control (normal completion, an explicit "close" command,
SIGTERM, SIGINT, and any uncaught exception) now explicitly forces the
line back to its declared safe value BEFORE releasing - see
_emergency_release() below.

NOT COVERED, and cannot be covered by any software running in this
process - stated plainly rather than implied to be handled: SIGKILL
(kill -9) and a hard power loss. Nothing running inside a process can
intercept either of those; they are hard OS/hardware limits, not a gap
specific to this design (the original onoff/sysfs implementation had
exactly the same limit). If that residual risk matters for your actual
door, it needs an answer outside this process entirely (e.g. a
hardware fail-safe on the relay board itself, or a supervising process
that can react to this one disappearing) - not something to solve here.

Confirmed empirically on real hardware which raw value means what for
THIS relay under Python's default active_low=False: Value.ACTIVE =
released (no reaction), Value.INACTIVE = triggered (audible click,
indicator lit). This is the OPPOSITE naming from the CLI-wrapper's
raw/no-flag convention investigated earlier in this project - do not
assume the two conventions match; each was checked directly against
real hardware rather than inferred from the other.

Protocol (one JSON object per line each direction):
  Node -> Python:
    {"id": <int>, "cmd": "get_value"}
    {"id": <int>, "cmd": "set_value", "value": 0|1}
    {"id": <int>, "cmd": "reconfigure", "edge": "none"|"rising"|"falling"|"both",
                  "output_value": 0|1 (optional), "active_low": bool (optional)}
    {"id": <int>, "cmd": "close"}
  Python -> Node:
    {"id": <int>, "ok": true, "value": 0|1}   (get_value response)
    {"id": <int>, "ok": true}                 (set_value/reconfigure/close response)
    {"id": <int>, "ok": false, "error": "..."}
    {"event": "edge", "value": 0|1, "edge_type": "rising"|"falling",
     "timestamp_ns": <int>}                   (unprompted, from the watcher thread)
    {"event": "fatal", "error": "..."}        (unprompted, watcher thread died)

Values crossing this boundary are always LOGICAL (0/1, matching
onoff's/gpio-libgpiod.js's existing contract) - active_low is handled
entirely by libgpiod itself via LineSettings.active_low. Callers on
the Node side never need to invert anything themselves, but see the
confirmed-mapping note above: which raw electrical state "logical 1"
corresponds to is a property of each specific relay board, verified
per-board, never assumed to carry over from a different board or a
different code path.
"""

import sys
import json
import threading
import time
import argparse
import signal
import atexit

import gpiod
from gpiod.line import Direction, Edge, Value


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--chip', required=True, help='e.g. /dev/gpiochip0')
    p.add_argument('--offset', required=True, type=int)
    p.add_argument('--direction', required=True, choices=['in', 'high', 'low'])
    p.add_argument('--edge', default='none', choices=['none', 'rising', 'falling', 'both'])
    p.add_argument('--active-low', action='store_true')
    p.add_argument('--debounce-ms', type=int, default=0)
    p.add_argument('--consumer', default='homebridge-smart-garage-door')
    return p.parse_args()


EDGE_MAP = {
    'none': Edge.NONE,
    'rising': Edge.RISING,
    'falling': Edge.FALLING,
    'both': Edge.BOTH,
}
EDGE_MAP_REV = {v: k for k, v in EDGE_MAP.items()}


def build_settings(direction_arg, edge_arg, active_low, debounce_ms):
    is_output = direction_arg in ('high', 'low')
    kwargs = dict(
        direction=Direction.OUTPUT if is_output else Direction.INPUT,
        edge_detection=EDGE_MAP[edge_arg] if not is_output else Edge.NONE,
        active_low=active_low,
    )
    if is_output:
        # IMPORTANT: direction='high'/'low' must mean the literal
        # physical level requested, REGARDLESS of active_low - matching
        # the Linux kernel's own sysfs GPIO semantics, confirmed
        # directly against drivers/gpio/gpiolib-sysfs.c:
        # gpio_direction_store() calls gpiod_direction_output_raw() for
        # "high"/"low" (bypasses active_low entirely), while
        # gpio_value_store() calls the non-raw gpiod_set_value_cansleep()
        # (applies active_low normally) for explicit value writes. Found
        # via a real bug: an earlier version of this code applied
        # active_low uniformly to BOTH paths, which happened to look
        # correct at construction/reset time (where it was tested) but
        # produced the wrong physical result for explicit writeSync()
        # calls elsewhere, and vice versa if "fixed" the other way -
        # they are genuinely different operations, not two callers of
        # the same one.
        #
        # XOR compensation: want physical HIGH when direction_arg=='high'.
        # Value.ACTIVE + active_low=False -> physical HIGH (no compensation
        # needed). Value.ACTIVE + active_low=True -> physical LOW (wrong),
        # so use Value.INACTIVE instead when active_low=True to correctly
        # land on physical HIGH. Symmetric for 'low'.
        want_high = (direction_arg == 'high')
        kwargs['output_value'] = Value.ACTIVE if (want_high != active_low) else Value.INACTIVE
    if debounce_ms > 0:
        import datetime
        kwargs['debounce_period'] = datetime.timedelta(milliseconds=debounce_ms)
    return gpiod.LineSettings(**kwargs)


class GpioHelper:
    def __init__(self, args):
        self.offset = args.offset
        self.is_output = args.direction in ('high', 'low')
        self.active_low = args.active_low
        self.current_edge = args.edge
        self._debounce_ms = args.debounce_ms

        settings = build_settings(args.direction, args.edge, args.active_low, args.debounce_ms)
        self.request = gpiod.request_lines(
            args.chip,
            consumer=args.consumer,
            config={self.offset: settings},
        )

        # The value this line should be forced back to on ANY exit path,
        # for output lines only. Starts as whatever it was constructed
        # with (which, per this app's actual usage, is always the idle/
        # released state - see index.js's activateGPIO calls), and is
        # updated if 'reconfigure' is ever given an explicit
        # output_value (matching index.js's resetSwitchDirection/
        # resetSwitchActiveLow, which only ever reassert that same idle
        # state, never a "leave it triggered" state).
        self._safe_value = None
        # The line's actual current intended value - a SEPARATE concept
        # from _safe_value (found necessary via a real bug in actual
        # Homebridge operation: reconfigure_lines() was being called
        # without output_value whenever ONLY active_low changed - e.g.
        # setActiveLow() - and gpiod.LineSettings() silently defaults
        # output_value to INACTIVE when it's not explicitly given,
        # meaning every such reconfigure call was unconditionally
        # re-triggering the relay, even when it was already correctly
        # released. This tracks the real current value so reconfigure
        # can always explicitly preserve it, never relying on
        # LineSettings' own default).
        self._current_output_value = None
        if self.is_output:
            # Same raw/XOR compensation as build_settings() above - this
            # must match the ACTUAL output_value the line was constructed
            # with, which is itself compensated for active_low (see
            # build_settings' comment for the full explanation).
            want_high = (args.direction == 'high')
            self._safe_value = Value.ACTIVE if (want_high != args.active_low) else Value.INACTIVE
            self._current_output_value = self._safe_value


        # Guards stdout so the main thread's command responses and the
        # watcher thread's edge-event lines can never interleave into a
        # corrupted line - both threads share one stdout stream.
        self._stdout_lock = threading.Lock()

        # IMPORTANT, found via a real bug (sensor state never updating
        # when the door state's own switch-controlled move logic
        # deliberately does not arm an edge watch during OPEN - see
        # index.js's activateDoorSensor(), which is BY DESIGN for a
        # single, CLOSED-only sensor): _current_input_value (read via
        # get_value in the polling loop below) is the ONLY thing that
        # keeps Node's cached readSync() value fresh when nothing is
        # watching for edges. Without it, a value read via readSync()
        # after a long, unwatched window (e.g. the 12-second OPEN
        # timer) returns whatever the value was BEFORE that window
        # started, not the real, current one - onoff's readSync() was a
        # real, synchronous filesystem read every time, with no such
        # gap. Guards ALL access to self.request (not just this new
        # loop) since it's now accessed from three threads (main,
        # watcher, poller) instead of two - not verified that
        # libgpiod's Python bindings are safe for concurrent access to
        # the same request object from multiple threads, so this lock
        # is a deliberate, conservative choice rather than an assumed
        # one.
        self._request_lock = threading.Lock()

        # IMPORTANT, found via a real duplicate-event bug in actual
        # Homebridge operation: the poller and watcher must share ONE
        # "last reported value", not track it independently. Without
        # this, a genuine edge caught by the watcher updates Node's
        # cached value immediately, but the poller's own, separately-
        # tracked copy doesn't know that happened - so on its next
        # cycle (within 250ms) it sees the same already-changed value,
        # compares it against its own stale copy, and emits a second,
        # redundant event for the same transition. Observed directly:
        # processPrimarySensorInterrupt fired twice in a row for one
        # physical transition. Harmless in that instance only by luck
        # (the resulting door state was unchanged); the door-move logic
        # does real work (cancels timers, reschedules, logs stats) on
        # every call, so this isn't safe to leave as a "probably
        # idempotent" assumption. Initialized here, BEFORE either the
        # poller or watcher thread starts, so both always see valid
        # shared state from their very first check - never left
        # uninitialized while a thread is already running.
        self._last_reported_lock = threading.Lock()
        self._last_reported_value = None
        if not self.is_output:
            with self._request_lock:
                self._last_reported_value = self.request.get_value(self.offset)

        self._stop_poller = threading.Event()
        self._poller_thread = None
        if not self.is_output:
            self._poller_thread = threading.Thread(target=self._poll_loop, daemon=True)
            self._poller_thread.start()

        self._stop_watcher = threading.Event()
        self._watcher_thread = None
        if not self.is_output and self.current_edge != 'none':
            self._start_watcher()


        # Idempotency guard - normal close, a signal, and atexit could
        # all attempt cleanup; only the first should actually run it.
        self._cleanup_lock = threading.Lock()
        self._cleanup_done = False

        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT, self._handle_signal)
        atexit.register(self._emergency_release)

    def _emit(self, obj):
        with self._stdout_lock:
            sys.stdout.write(json.dumps(obj) + '\n')
            sys.stdout.flush()

    # Polls the line's real, current value on a fixed interval,
    # independent of whether edge-watching is active - see the
    # __init__ comment above for why this is necessary. Input lines
    # only; deliberately NOT gated on current_edge, so it stays correct
    # even during the real app's "no interrupt activation" windows.
    # 250ms keeps staleness low without excessive polling; emits an
    # 'edge' event (same shape the watcher emits) ONLY when the value
    # actually changes, so this is a no-op in the common case and is
    # harmless if it happens to race with a genuine edge event for the
    # same transition (Node-side dispatch of the same value twice is
    # idempotent).
    def _poll_loop(self):
        try:
            while not self._stop_poller.is_set():
                time.sleep(0.25)
                with self._request_lock:
                    current = self.request.get_value(self.offset)
                with self._last_reported_lock:
                    if current != self._last_reported_value:
                        self._last_reported_value = current
                        self._emit({
                            'event': 'edge',
                            'value': 1 if current == Value.ACTIVE else 0,
                            'edge_type': 'poll',
                            'timestamp_ns': time.time_ns(),
                        })
        except Exception as e:
            self._emit({'event': 'fatal', 'error': f'{type(e).__name__}: {e}'})

    def _start_watcher(self):
        if self._watcher_thread and self._watcher_thread.is_alive():
            return
        self._stop_watcher.clear()
        self._watcher_thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._watcher_thread.start()

    def _stop_watcher_thread(self):
        self._stop_watcher.set()
        if self._watcher_thread:
            self._watcher_thread.join(timeout=2)
            self._watcher_thread = None

    def _watch_loop(self):
        try:
            while not self._stop_watcher.is_set():
                # Timeout shortened from an earlier 1.0s to 0.1s -
                # holding _request_lock for the whole wait_edge_events()
                # call (see the __init__ comment on _request_lock for
                # why the lock spans the whole call rather than just
                # read_edge_events()) means a 1.0s timeout would starve
                # the polling thread for up to a full second at a time;
                # 0.1s keeps that worst case low while still checking
                # the stop flag frequently.
                with self._request_lock:
                    has_events = self.request.wait_edge_events(timeout=0.1)
                    events = list(self.request.read_edge_events()) if has_events else []
                for ev in events:
                    edge_type = 'rising' if ev.event_type == ev.Type.RISING_EDGE else 'falling'
                    value = 1 if edge_type == 'rising' else 0
                    new_value = Value.ACTIVE if value else Value.INACTIVE
                    with self._last_reported_lock:
                        if new_value == self._last_reported_value:
                            continue  # already reported (e.g. by the poller) - don't duplicate
                        self._last_reported_value = new_value
                    self._emit({
                        'event': 'edge',
                        'value': value,
                        'edge_type': edge_type,
                        'timestamp_ns': ev.timestamp_ns,
                    })
        except Exception as e:
            self._emit({'event': 'fatal', 'error': f'{type(e).__name__}: {e}'})

    def _handle_signal(self, signum, frame):
        self._emergency_release()
        # Re-raise as a normal exit rather than leaving the process in
        # a half-torn-down state.
        sys.exit(0)

    def _emergency_release(self):
        # Idempotent - safe to call more than once (normal close, then
        # atexit firing anyway, etc.) but only actually does the work
        # once.
        with self._cleanup_lock:
            if self._cleanup_done:
                return
            self._cleanup_done = True

        try:
            self._stop_watcher.set()  # don't join here - avoid blocking a signal handler
        except Exception:
            pass
        try:
            self._stop_poller.set()
        except Exception:
            pass

        # Bounded-timeout acquire, not a plain `with` block: this is the
        # safety-critical shutdown path (signal handler / atexit), and
        # it must never risk hanging indefinitely waiting for
        # _request_lock, even though every other holder is normally
        # quick or bounded (watcher: max ~0.1s per cycle; poller: a
        # single get_value call).
        got_lock = self._request_lock.acquire(timeout=1.0)
        try:
            if self.is_output and self._safe_value is not None:
                try:
                    self.request.set_value(self.offset, self._safe_value)
                except Exception as e:
                    # Deliberately still attempt release() below even if
                    # this failed - and make the failure visible rather
                    # than silently swallowing it, since this is the one
                    # step that actually matters for safety.
                    try:
                        self._emit({'event': 'fatal', 'error': f'emergency release FAILED to set safe value: {type(e).__name__}: {e}'})
                    except Exception:
                        pass

            try:
                self.request.release()
            except Exception:
                pass
        finally:
            if got_lock:
                self._request_lock.release()

    def handle_command(self, msg):
        cmd = msg.get('cmd')
        cid = msg.get('id')
        try:
            if cmd == 'get_value':
                with self._request_lock:
                    v = self.request.get_value(self.offset)
                self._emit({'id': cid, 'ok': True, 'value': 1 if v == Value.ACTIVE else 0})

            elif cmd == 'set_value':
                if not self.is_output:
                    raise RuntimeError('set_value on an input line')
                v = Value.ACTIVE if msg.get('value') else Value.INACTIVE
                with self._request_lock:
                    self.request.set_value(self.offset, v)
                self._current_output_value = v
                self._emit({'id': cid, 'ok': True})

            elif cmd == 'reconfigure':
                new_edge = msg.get('edge', self.current_edge)
                new_active_low = msg.get('active_low', self.active_low)
                kwargs = dict(
                    direction=Direction.OUTPUT if self.is_output else Direction.INPUT,
                    edge_detection=Edge.NONE if self.is_output else EDGE_MAP[new_edge],
                    active_low=new_active_low,
                )
                # IMPORTANT, found via a real bug (sensor edges going
                # entirely undetected in real operation): debounce_period
                # must ALSO be explicitly carried forward here, just like
                # output_value below - gpiod.LineSettings() has no memory
                # of the settings a prior request/reconfigure used, so
                # omitting it here was silently resetting debounce to
                # none on EVERY reconfigure call (which happens on every
                # door-state change, switching between rising/falling),
                # even though it was correctly set at initial
                # construction via build_settings(). The startup log's
                # "debounce 150ms" message only reflects the ONE-TIME
                # initial construction, not what's actually active after
                # any subsequent reconfigure.
                if self._debounce_ms > 0 and not self.is_output:
                    import datetime
                    kwargs['debounce_period'] = datetime.timedelta(milliseconds=self._debounce_ms)
                if self.is_output:
                    # CRITICAL, found via a real bug in actual Homebridge
                    # operation: output_value must ALWAYS be explicitly
                    # set here, never omitted - gpiod.LineSettings()
                    # silently defaults output_value to INACTIVE when
                    # it's not given, which is not necessarily the idle/
                    # safe state (depends on active_low - see
                    # build_settings' header comment for this relay's
                    # actual, kernel-verified active_low/output_value
                    # relationship). A reconfigure that only meant to
                    # change active_low (e.g. setActiveLow(), called on
                    # every sensor-triggered door-state update) was
                    # unconditionally re-triggering the relay as a
                    # result. Always explicitly carry forward the
                    # current value unless this specific call means to
                    # change it.
                    if 'output_value' in msg:
                        new_output_value = Value.ACTIVE if msg['output_value'] else Value.INACTIVE
                        # This reconfigure declared a new idle/safe state -
                        # update what emergency release will force on exit.
                        self._safe_value = new_output_value
                    else:
                        new_output_value = self._current_output_value
                    kwargs['output_value'] = new_output_value
                    self._current_output_value = new_output_value
                settings = gpiod.LineSettings(**kwargs)

                # Reconfigure first, THEN adjust the watcher thread -
                # verified this ordering directly (see standalone test
                # plan) rather than assumed safe.
                with self._request_lock:
                    self.request.reconfigure_lines({self.offset: settings})
                self.active_low = new_active_low

                if not self.is_output:
                    edge_was_active = self.current_edge != 'none'
                    edge_now_active = new_edge != 'none'
                    self.current_edge = new_edge
                    if edge_now_active and not edge_was_active:
                        self._start_watcher()
                    elif not edge_now_active and edge_was_active:
                        self._stop_watcher_thread()
                    # if it was already active and stays active (just a
                    # different edge type), the existing watcher thread
                    # keeps running against the same, now-reconfigured
                    # request - no restart needed.

                self._emit({'id': cid, 'ok': True})

            elif cmd == 'close':
                self._emergency_release()
                self._emit({'id': cid, 'ok': True})
                return False  # signal main loop to exit

            else:
                raise RuntimeError(f'unknown command: {cmd}')

        except Exception as e:
            self._emit({'id': cid, 'ok': False, 'error': f'{type(e).__name__}: {e}'})

        return True

    def run(self):
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as e:
                    self._emit({'event': 'fatal', 'error': f'bad JSON from parent: {e}'})
                    continue
                if not self.handle_command(msg):
                    break
        finally:
            # Covers: stdin closed without an explicit close (parent
            # exited), and any uncaught exception anywhere in the loop
            # above. atexit is still registered as a final backstop for
            # anything even this doesn't catch.
            self._emergency_release()


if __name__ == '__main__':
    args = parse_args()
    helper = GpioHelper(args)
    helper.run()
