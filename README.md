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

    “GPIO”:<gpio pin>  (**required** key:value)

    “pressTimeInMs”:<milliseconds> (optional) – key value range is 1000 – 2000 milliseconds

                                                Number of milliseconds to wait for the relay switch send 
                                                it’s signal to the garage door motor to start moving the door.

                                                Default is 1500 milliseconds.

    "moveTimeInSec”:<seconds>  (optional) – key value range is 0 – 15 seconds

                                                Number of seconds to wait for the door to complete an 
                                                open or close request.

                                                This is use for setting a timeout event trigger which 
                                                the accessory uses to determine the door state after a 
                                                door move request has been executed.

                                                **NOTE**: if the accessory has been configured with actuator(s), 
                                                an interrupt should occur either before or close to the timeout, 
                                                assuming the move time aligns with the actual door motor move time.

                                                Default is 12 seconds.

    “relaySwitch”:<text> (optional) – key text in quotes can be either **NO** or **NC**

                                            NO – normally open which indicates sending a high (1) signal to 
                                            toggle the relay switch.

                                            NC – normally closed which indicates sending a low (0) signal to 
                                            toggle the relay switch.

                                        `   Default is NO.

    “interruptDoorRequest”:<text> (optional) – key text  in quotes can be either **stop**, **off**, or **on**

                                            stop – upon receiving a new door move request when the accessory 
                                            is executing a door move request the accessory will toggle the 
                                            door switch which should stop the door movement.

                                            off - upon receiving a new door move request when the accessory 
                                            is executing a door move request the accessory will ignore 
                                            the request and complete the current door move request.

                                            on - upon receiving a new door move request when the accessory 
                                            is executing a door move request the accessory will stop 
                                            the current request and execute the new door move request.

                                        `   Default action is stop.

    "waitTimeAfterNewDoorRequest”:<seconds>  (optional) – key value range is 2 – 5 seconds

                                            Number of seconds to wait before another 
                                            new door move request can be executed.

                                            In the event of multiple new door request actions, 
                                            the accessory will reject any subsequent new requests 
                                            to give the door motor time to reverse the 
                                            current door movement direction.

                                            Default is 2 seconds.

