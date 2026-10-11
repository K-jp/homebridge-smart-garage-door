# homebridge-smart-garage-door
 
Garage door opener for Apple HomeKit using HomeBridge on a raspberry pi.

This accessory controls and monitors the opening and closing of a garage door.

It uses GPIO pins for toggling a relay switch control door movement and for monitoring the current state of the door (i.e. open, opening, closed, closing).

This accessory requires a relay switch connects to the garage door motor in order to move the door and actuators that allow the accessory to determine if the door is copen or closed.

This accessory can be optionally configured with actuators to monitor the current state of the door. 

When the accessory is configured with one or two actuators, it will use interrupts to determine when the garage door state (i.e. open or closed) changes, thus allowing the accessory to always know the current door state and report it, even when a traditional wireless door controller or wired door switch are used to open or close the garage door.

When the accessory is NOT configured with one or two actuators, it will only be able to toggle a relay switch to control door movement. It will NOT be able to determine the actual garage door state (i.e. open or closed). Furthermore, the accessory will assume the door is closed when the accessory is initially added to Apple HomeKit and the accessory will not be able to report when the garage door has been open or closed by a traditional wireless door controller or wired door switch.

## documentation

An overview of how the garage door accessory works is in the [Simple Garage Story Board](https://github.com/K-jp/homebridge-smart-garage-door/blob/main/documentation/Simple%20Garage%20Story%20Board.pptx) (PowerPoint, in the repository's `documentation` folder).

## prerequisites

- Node.js `^22.0.0` or `^24.0.0`, and Homebridge `^2.0.0`.
- A Raspberry Pi running an OS with **libgpiod v2.x** and its character-device GPIO interface (confirmed on Raspberry Pi OS Trixie) - not the older sysfs GPIO interface, which recent Raspberry Pi OS releases have removed.
- **Python 3 with the `python3-libgpiod` system package installed** (`sudo apt install python3-libgpiod`). This is an **operating-system** dependency, not an npm one - it will not be installed automatically when you install this plugin, and needs to be present separately. This accessory uses Python's own libgpiod bindings, in a small helper process, to talk to the GPIO hardware directly - not npm packages, and not command-line GPIO tools.
- Standard Raspberry Pi GPIO numbering on `gpiochip0` (confirmed on Raspberry Pi 3B/3A+ hardware). The package python3-libgpiod was automatically installed when using Raspberry Pi Imager v2.0.12.

## installation

1. Install the Python GPIO bindings (once per Pi):
   ```bash
   sudo apt install python3-libgpiod
   ```
2. Install the plugin, either by searching for `homebridge-smart-garage-door` on the **Plugins** tab of the Homebridge UI, or from the command line:
   ```bash
   sudo hb-service add homebridge-smart-garage-door
   ```
3. Add an accessory entry to the `accessories` array in `config.json` (see below), then restart Homebridge.

## configuration
The recommended way to configure this accessory is the plugin's settings form in the Homebridge UI (Plugins tab → **Settings**), which is driven by `config.schema.json`. You can also edit `config.json` directly using the examples below.
Here is an example of a garage door confguration with only a switch.
 ```json
{
    "name": "Garage Door",
    "sensors": 0,
    "doorSwitch": {
        "GPIO": 5,
        "relaySwitch": "NO"
    },
    "accessory": "smartgaragedoor"
}
```
Here is an example of a garage door confguration with a switch and 1 actuator. An actuator is defined as the json objects, doorSensor for the 1st actuator and doorSensor2 if a 2nd actuator is configured.
```json
{
    "name": "Garage Door",
    "sensors": 1,
    "doorSwitch": {
        "GPIO": 5,
        "relaySwitch": "NO"
    },
    "doorSensor": {
        "GPIO": 24,
        "actuator": "NO"
    },
    "accessory": "smartgaragedoor"
}
```
Here is an example of a garage door confguration with 2 actuators.
```json
{
    "name": "Garage Door",
    "sensors": 2,
    "doorSwitch": {
        "GPIO": 16
            },
    "doorSensor": {
        "GPIO": 22,
        "actuator": "NO"
        },
    "doorSensor2": {
        "GPIO": 17,
        "actuator": "NO"
    },
    "accessory": "smartgaragedoor"
}
```
### configuration settings

"doorSwitch”:{

    “GPIO”:<pin>,  (required) – key values are one of the following GPIO pins: 5,6,12,13,16,17,22,23,24,25,26,27

    “pressTimeInMs”:<milliseconds> (optional) – key value range 1000 – 2000

        Number of milliseconds to wait for the relay switch send its signal to the garage door motor to start moving the door.

        Default is 1500 milliseconds.

    “moveTimeInSec”:<seconds>,  (optional) – key value range 10 – 15

        Number of seconds to wait for the door to complete an open or close request.

        This is used for setting a timeout event trigger which the accessory uses to determine the door state after a door move request has been executed.

        NOTE:   The move time specified should align with the actual door motor move time. 
                If actuator(s) are configured, then an interrupt can trigger a door move completion sooner than the move time specified. 
        
        Default is 12 seconds.
    
    “relaySwitch”: <”key value”> , (optional) - key values in quotes are NO or NC

        NO – normally open which indicates sending a high (1) signal to toggle the relay switch.

        NC – normally closed which indicates sending a low (0) signal to toggle the relay switch.

        Default is NO

    “interruptDoorRequest”: <”key value”>, (optional) - key values in quotes are STOP, ON, OFF

        off - upon receiving a new door move request while currently executing a door move request, the new request will be ignored.

        on - upon receiving a new door move request while currently executing a door move request, the current request door movement will reverse.

        stop – upon receiving a new door move request while currently executing a door move request, the door movement will stop.

        Default is off.

        NOTE: Setting this configuration parameter to on or stop for a door without sensors is not recommended and a warning will be logged at statup

"doorSensor" / "doorSensor2": {

    “GPIO”:<pin>,  (required) – key values are one of the following GPIO pins: 5,6,12,13,16,17,22,23,24,25,26,27

    “actuator”: <”key value”> , (optional) - key values in quotes are NO or NC

        NO – normally open which indicates the actuator wire in on the NO terminal and will send a high (1) when magnet is detected.

        NC – normally open which indicates the actuator wire in on the NC terminal and will send a low (0) when magnet is detected.

        Default is NO

    “position”: <”key value”>, (optional) - key values in quotes are open or closed.

        off - upon receiving a new door move request while currently executing a door move request, the new request will be ignored.

        on - upon receiving a new door move request while currently executing a door move request, the current request door movement will reverse.

        stop – upon receiving a new door move request while currently executing a door move request, the door movement will stop.

        Default is closed

        NOTE: Setting this configuration parameter when 2 actuators are configued will result in a warning since doorSensor actuator must be assocated when the door is closed and doorSensor2 acture must be assocated when the door is open

    "debounceTimeoutMs":<milliseconds> (optional) – key value range 0 – 1000

        Ignores rapid, spurious sensor transitions that occur within this many milliseconds of each other, before treating a transition as real.

        Found to be needed on some hardware where the sensor's magnet is mounted on the door trolley - a brief mechanical wobble as the door starts moving can produce a few real, rapid transitions right at the start of a move, well before the door itself is actually travelling. A modest value (tens to a couple hundred milliseconds) is negligible against real door movement (which takes several seconds), but effectively filters this out.

        Default is 0 (off) - matching original behavior for installations that don't need it.

## Multiple Garage Doors (Child Bridges)

`config.schema.json` (the Homebridge UI's configuration form) only supports configuring a single `smartgaragedoor` accessory at a time. To run two or more garage doors, each as its own child bridge, the additional accessory entries must be added to `config.json` by hand - the UI form cannot generate this for you.

Each additional door needs its own entry in the `accessories` array, with its own `_bridge` block containing a unique `username` (a MAC-address-style identifier, not shared with the main bridge or any other accessory/child bridge) and a unique `port`, which will be automatically generated by homebridge when invoking "Set Up Child Bridge" in the Plugins window. Tested, working example for two doors:

```json
{
    "name": "TBdoor1",
    "sensors": 1,
    "doorSwitch": {
        "GPIO": 5,
        "pressTimeInMs": 1500,
        "moveTimeInSec": 12,
        "relaySwitch": "NO",
        "interruptDoorRequest": "stop"
        },
    "doorSensor": {
        "GPIO": 24,
        "debounceTimeoutMs": 150,
        "position": "closed"
        },
    "accessory": "smartgaragedoor",
        "_bridge": {
        "username": "0E:9D:F4:D3:14:EF",
        "port": 50195,
        "name": "Homebridge Smart Garage Door"
        }
},
{
    "name": "TBdoor2",
    "sensors": 1,
    "doorSwitch": {
        "GPIO": 12,
        "pressTimeInMs": 1500,
        "moveTimeInSec": 12,
        "relaySwitch": "NO",
        "interruptDoorRequest": "stop"
        },
    "doorSensor": {
        "GPIO": 13,
        "debounceTimeoutMs": 150,
        "actuator": "NC",
        "position": "closed"
        },
    "accessory": "smartgaragedoor",
        "_bridge": {
        "username": "0E:D2:CA:3C:C4:6E",
        "port": 59065,
        "name": "Homebridge Smart Garage Door"
        }
}
```

A reasonable workflow: use `config.schema.json`/the UI form to configure the first door normally, then manually duplicate and edit its `accessories` entry in `config.json` for each additional door, giving each its own `name`, GPIO pins, and `_bridge` block.

## Known Issues

### config.schema.json: missing "GPIO" in DoorSensor and/or DoorSensor2

The `GPIO` field in `config.schema.json` only checks fot it to be present in doorSwitch, so it is possible to create a configuration with missing GPIO fields for either doorSensor or doorSensor2. If a GPIO is missing then index.js will report an error and terminate. If this occurs thenenter Homebridge to enter the missing GPIO information by either directly editing the JSON file via the JSON Config window or recreate the configuration via the Plugins window and select Plugin Config.

Plese be aware that homebridge will automatically restart the accessory unless you stop homebridge.
