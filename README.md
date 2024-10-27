# homebridge-smart-garage
 
Garage door opener for Apple HomeKit using HomeBridge on a raspberry pi.

This accessory controls and monitors the opening and closing of a garage door.

It uses GPIO pins for toggling a relay switch control door movement and for monitoring the current state of the door (i.e. open, opening, closed, closing).

This accessory requires a relay switch connects to the garage door motor in order to move the door and actuators that allow the accessory to determine if the door is copen or closed.

This accessory can be optionally configured with actuators to monitor the current state of the door. 

When the accessory is configured with one or two actuators, it will use interrupts to determine when the garage door state (i.e. open or closed) changes, thus allowing the accessory to always know the current door state and report it, even when a traditional wireless door controller or wired door switch are used to open or close the garage door.

When the accessory is NOT configured with one or two actuators, it will only be able to toggle a relay switch to control door movement. It will NOT be able to determine the actual garage door state (i.e. open or closed). Furthermore, the accessory will assume the door is closed when the accessory is initially added to Apple HomeKit and the accessory will not be able to report when the garage door has been open or closed by a traditional wireless door controller or wired door switch.

This accessory validates the configuration JSON file.

Sample configuration for the requie object doorSwitch which is used to configure the relay switch.
"doorSwitch": {
                "GPIO": 5,
                "relaySwitch": "NO",
                "interruptDoorRequest": "stop"
            },

 doorSwitch supports the following key:value entries:

 “GPIO”:<gpio pin>,  (**required** key:value)

 “pressTimeInMs”:<milliseconds> (optional) – key value range 1000 – 2000
