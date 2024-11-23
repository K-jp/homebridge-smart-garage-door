# homebridge-smart-garage
 
Garage door opener for Apple HomeKit using HomeBridge on a raspberry pi.

This accessory controls and monitors the opening and closing of a garage door.

It uses GPIO pins for toggling a relay switch control door movement and for monitoring the current state of the door (i.e. open, opening, closed, closing).

This accessory requires a relay switch connects to the garage door motor in order to move the door and actuators that allow the accessory to determine if the door is copen or closed.

This accessory can be optionally configured with actuators to monitor the current state of the door. 

When the accessory is configured with one or two actuators, it will use interrupts to determine when the garage door state (i.e. open or closed) changes, thus allowing the accessory to always know the current door state and report it, even when a traditional wireless door controller or wired door switch are used to open or close the garage door.

When the accessory is NOT configured with one or two actuators, it will only be able to toggle a relay switch to control door movement. It will NOT be able to determine the actual garage door state (i.e. open or closed). Furthermore, the accessory will assume the door is closed when the accessory is initially added to Apple HomeKit and the accessory will not be able to report when the garage door has been open or closed by a traditional wireless door controller or wired door switch.

## configuration
Config.schema.json is the recommended method for configuing this accessory.

Here is an example of a garage door confguration with a switch and 1 actuator. An actuator is defined as the json objects, doorSensor for the 1st actuator and doorSensor2 if a 2nd actuator is configured.
```json
{
    "name": "Garage Door",
    "ignoreGPIOinUse": "on",
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
    "ignoreGPIOinUse": "on",
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

“ignoreGPIOinUseSettings”: <”key value”>, (optional) - key values in quotes are ON or OFF

    ON – any GPIO pin specified in this config which is currently in use, will be ignored and the GPIO pin to be used.

    OFF – any GPIO pin specified in the config which is currently in use it will log an error and terminate.

doorSwitch”:{

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

        stop – upon receiving a new door move request while currently executing a door move request, the door movement will stop.

        off - upon receiving a new door move request while currently executing a door move request, the new request will be ignored.

        on - upon receiving a new door move request while currently executing a door move request, the current request door movement will reverse.

        Default is stop.
    
    “waitTimeAfterNewDoorRequest”:<seconds>,  (optional) – key value range 2 – 5

        Number of seconds to wait before another new door move request to interrupt the current request can be executed.

        This setting is only used after a door move request has been interrupted.

        In the event that a user sends multiple door move requests, this setting allows the door motor to respond in an orderly fashion to either stop the current door movement or reverse the current door movement.

        Default is 2.