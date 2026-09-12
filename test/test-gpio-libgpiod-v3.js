// Standalone test for gpio-libgpiod-v2.js against your real test bed
// (libgpiod v2.2.1, Raspberry Pi OS Trixie). Tests door 1 only
// (switch=16, sensor=17); once this passes, rerun with door 2's pins
// (switch=23, sensor=22) by editing the constants below.
//
// This is an ES module (matches gpio-libgpiod-v2.js and the ESM-converted
// index.js) - run it with a package.json nearby that has "type": "module"
// (the one in this same delivery already does), or rename this file to
// use a .mjs extension if you're running it standalone elsewhere.
//
// Usage: node test-gpio-libgpiod-v2.js

import { Gpio } from './gpio-libgpiod-v3.js';

const SWITCH_GPIO = 23;
const SENSOR_GPIO = 17;
const RELAY_ACTIVE_LOW = true; // confirmed on the earlier test bed's relay - re-confirm on THIS board's relay before trusting it

console.log('--- Test 1: readSync on sensor (no watch active yet) ---');
const sensor = new Gpio(SENSOR_GPIO, 'in', 'none');
console.log(`readSync() = ${sensor.readSync()}`);
console.log(`Expected: matches a manual \`gpioget --numeric --chip gpiochip0 ${SENSOR_GPIO}\` run right now.\n`);

console.log('--- Test 2: watch() + setEdge(\'both\') on sensor ---');
console.log('Slide the magnet past the sensor now (expect some bounce, per what you already saw).');
console.log('Waiting up to 15 seconds...\n');

let eventCount = 0;
sensor.setEdge('both');
sensor.watch((err, value) => {
  if (err) {
    console.error('watch() callback received an error:', err);
    return;
  }
  eventCount += 1;
  console.log(`watch() fired (#${eventCount}): value = ${value}`);
});

setTimeout(() => {
  console.log(`\nTotal events received: ${eventCount}\n`);

  console.log('--- Test 3: setEdge(\'rising\') while watch is active (dynamic reconfig) ---');
  sensor.setEdge('rising');
  eventCount = 0;
  console.log('Slide the magnet past again - only rising should fire now.');
  console.log('Waiting 10 more seconds...\n');

  setTimeout(() => {
    console.log(`Rising-only events received: ${eventCount}\n`);

    sensor.unwatchAll();
    console.log('unwatchAll() called - gpiomon child process should now be stopped.\n');

    console.log('--- Test 4: readSync on sensor AFTER unwatchAll (real gpioget call) ---');
    console.log(`readSync() = ${sensor.readSync()}\n`);

    console.log('--- Test 5: writeSync on switch (WILL ACTIVATE THE RELAY) ---');
    console.log('Constructing as \'high\' (should be the RELEASED state, given activeLow).');
    const doorSwitch = new Gpio(SWITCH_GPIO, 'high', 'none', { activeLow: RELAY_ACTIVE_LOW });

    setTimeout(() => {
      console.log('Writing logical 0 (should trigger the relay, given activeLow)...');
      doorSwitch.writeSync(0);

      setTimeout(() => {
        console.log('Writing logical 1 (should release the relay)...');
        doorSwitch.writeSync(1);

        setTimeout(() => {
          console.log('\n--- Test 6: process cleanup check ---');
          console.log('Script is about to exit. In ANOTHER terminal, run:');
          console.log('  ps aux | grep -E "gpiomon|gpioset"');
          console.log('and confirm NOTHING from this test is still running.');
          process.exit(0);
        }, 1000);
      }, 1000);
    }, 1000);
  }, 10000);
}, 15000);
