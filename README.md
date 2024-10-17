# homebridge-smart-garage
 
Garage door opener for Apple HomeKit using HomeBridge on a raspberry pi.

This accessory supports the use of actuators to determine when the garage door is open or closed.

Using an actuator allows this accessory to use interrupts to determine when the garage door moves.

Using 1 actuator and positioing it so that it triggers when the door is fully closed is expected to be the most common configuration.
However, a second actuator could also be configured to sense if the door has stopped moving and is partially open.

When an actuator is used, this accessory will detect when the door is open or closed by an external garage door switch.

A user can also configure this accessory without any actuator(s) and just send request to move the door. 

This accessory can also configure this accessory without any actuator(s) and just toggle the door switch send to move the door. 

If no actuator is used, this accessory will initially assume the door is closed and toggle between the door open an closed with each successive request to move the door.
