 // Copyright [2023] [Ken Piro]
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
'use strict'
const gpio = require('onoff').Gpio;
const version = require('./package.json').version;
// this assumes plugin files are in the correct directory which can be obtained from __dirname 
const localFolderName = () => {const path = require('path'); return path.basename(__dirname);};
const plugInModule = localFolderName();
const accessoryName = "smartgaragedoor";
const accessoryInfo  = {developer:`Homebridge Open Source Project`, product:`Homebridge ${accessoryName} - Version ${version}`, randomnum:Math.floor((Math.random() * 10000) + 1)};
// door request source
const doorRequestSources = [ "apple homekit", "garagedoor openner" ];
const [homekit, garageOpenner] = doorRequestSources;
// external door events
const doorStatsEvents  = [ "openClose", "obstructed" ];
const [openClose, obstructed] = doorStatsEvents;
// internal switch operations
const doorSwitchOperations  = [ "startop", "executeop" , "stopop", "reverseop"];
const [startop, executeop, stopop, reverseop] = doorSwitchOperations;
// door sensor indication of physical door state
const doorSensorPositions = [ "open", "closed" ];
const [openDoor, closedDoor] = doorSensorPositions;
// internal state of door sensor monitoring
const doorSensorInterruptActions  = [ "activate", "cancel" ];
const [activateInterrupt, cancelInterrupt] = doorSensorInterruptActions;
// internal parameter setting for onOff GPIO interrupts
const onOffEdgeInterruptSettings = [ "none", "falling", "rising", "both" ];
const [ none, falling, rising, both ] = onOffEdgeInterruptSettings;
// garage door switch management objects 
const doorSwitch  = {GPIO:null, onOff:null, pressTimeInMs:{value:null,minValue:1000,maxValue:2000,defaultValue:1500}, 
                      moveTimeInSec:{value:null,minValue:10,maxValue:15,defaultValue:12},
                      interruptDoorRequest:{ value:null, 
                                             validText:["on","off","stop"],
                                             defaultValue:"off",
                                             interruptValue:{
                                                stop:{ authorized:true, newRequest: false },
                                                on:{ authorized:true, newRequest: true },
                                                off:{ authorized:false, newRequest: false } },
                                            authorized:null, 
                                            newRequest:null, 
                                            newOpInProgress:false,
                                            counter:0},
                      relaySwitch:{ configValue:null, writeValue:null}};
                       
const mutexon = () =>   {//need to prevent partial button push caused by a new request to stop or reverse current door move
                        doorSwitch.interruptDoorRequest.newOpInProgress = true;}

const mutexoff = () =>  {//allow new requests
                      doorSwitch.interruptDoorRequest.newOpInProgress = false;}
                        
//object factory                                                                                                                        
const signalObj = () => {return {validText:[ "NO", "NC" ],defaultValue:"NO",signalValue:{NO:1,NC:0}}}
const sensorObj   =() => {return {GPIO:null, onOff:null, position:null,
                                  interrupt:{ count:0,handler:null },
                                  actuator:{ value:null,doorStateMatch:null,doorStateNoMatch:null }}}
// garage door signal objects 
doorSwitch.relaySwitch  = signalObj();

// garage door sensor objects                                                                                                                                                           
const doorSensor        = sensorObj();
const doorSensor2       = sensorObj();
doorSensor.actuator     = signalObj();
doorSensor2.actuator    = signalObj();

const doorState   = {timerId:null, ignoreGPIOinUse:{value:null,validText:["on","off"],defaultValue:"on",setValue:{on:true,off:false}}, 
                     validGPIOpins:[5,6,12,13,16,17,22,23,24,25,26,27],
                     sensors:{value:0,minValue:0,maxValue:2,defaultValue:0}, homeKitRequest:false, 
                     moveTimeInMs:null, reverseDoorMovement:false, stopDoorMovement:false,
                     last:null, current:null, target:null, obstruction:false};
const doorLog     = {logger:null, accessory:'', name:''};
const doorStats   = {open:{requestSource:'', time:null}, close:{requestSource:'', time:null}, obstruction:{startTime:null, endTime:null}};
const homeBridge  = {Service:null, Characteristic:null, CurrentDoorState:null, TargetDoorState:null, ObstructionDetected:null};

const fatalError  = { Missing_Required_Config:{
                            text:`Missing Required Configuration Info - `},
                      Invalid_Config_Info:{
                            text:`Invalid Configuration - `},
                      Invalid_GPIO:{
                            text:`Invalid GPIO Pin - `},      
                      GPIO_conflict:{
                            text:`Duplicate GPIO Pin detected for both switch and sensor(s) `},
                      Sensor_Position_Requirement:{
                            text:`Primary door sensor position must be [ ${closedDoor} ] when secondary door sensor is configured`}, 
                      Door_Switch_Write_Error:{
                            text: `Door Switch Write Error (OnOff) - `},
                      Door_Sensor_Read_Error:{
                            text: `Door Sensor Read Error (OnOff) - `},
                      Door_Switch_OnOff_Error:{
                            text: `Door Switch OnOff Error (setup) - `},      
                      Door_Sensor_OnOff_Error:{
                            text: `Door Sensor OnOff Error (setup) - `},
                      Internal_Error:{
                            text:`Internal Error - `}};
// standard log events - debug flags control trace info and stats logging - alert, warning, startup and terminating
const logEventLevel  = [ "trace  ", 
                         "info   ", 
                         "stats  ", 
                         "alert  ", 
                         "warning", 
                         "startup", 
                         "terminating" ];
const [traceEvent, infoEvent, statsEvent, alertEvent, warnEvent, startupEvent, terminateEvent] = logEventLevel;
const { log } = require('console');
const debug           = require('debug');
const traceLog        = debug(`${accessoryName}:trace`);
const infoLog         = debug(`${accessoryName}:info`);
const statsLog        = debug(`${accessoryName}:stats`);
// function to get object key literal
const objKeySymbol   = ( obj )        => new Proxy(obj, {get(_, key) {return key;}});
// functions for door switch GPIO OnOff settings
const switchDirection = ( mySwitch )   => {return (mySwitch ? 'high' : 'low');}
const switchSignal    = ( mySwitch )   => {return (mySwitch ^ 1 ? false : true);}
// misc door info functions
const garageDoorHasSensor = ( sensor ) => {return (sensor.GPIO != null ? true : false);}
const doorRequestSource   = ()         => {return (doorState.homeKitRequest  ? homekit : garageOpenner);}
// door state logging text function
const doorStateText       = ( state )  => {const _currentDoorState = homeBridge.CurrentDoorState;
                                           const doorStateKeySymbol = objKeySymbol(_currentDoorState);
                                           switch (state) {
                                            case _currentDoorState.OPEN:    return doorStateKeySymbol.OPEN;
                                            case _currentDoorState.CLOSED:  return doorStateKeySymbol.CLOSED;
                                            case _currentDoorState.OPENING: return doorStateKeySymbol.OPENING;
                                            case _currentDoorState.CLOSING: return doorStateKeySymbol.CLOSING;
                                            case _currentDoorState.STOPPED: return doorStateKeySymbol.STOPPED;
                                            default:                        return "Invalid Door State";}}

// event timer management functions
const killTimer           = (timerId)  => {// clear pending timer 
                                           if (timerId != null) 
                                               clearTimeout(timerId);
                                           return null;} 

const scheduleTimerEvent  = (timerId,timerActionFunction,timer) => {
                                           // schedule an event timer
                                            killTimer(timerId);
                                            return setTimeout(timerActionFunction, timer);}                                      
//error logging functions
const getCaller = (stack)              => {// get calling method / function name
                                           const reDot = /[.]/;
                                           return (stack.search(reDot) == -1 ? stack : stack.split(".")[1]);}

const stopAccessory = (exitCode, msg)  => {// log and terminate execution                                        
                                              logEvent(terminateEvent,`${getCaller(new Error().stack.split("\n")[2].trim().split(" ")[1])} - ${(msg != null ? exitCode.text + msg : exitCode.text)}`);  
                                              throw process.exit(1);}

const logEvent = (event, msg)          => { // logging function for all events
                                            switch (event) {
                                              case traceEvent:
                                                if (!traceLog.enabled) return; 
                                              break; 
                                              case infoEvent:    
                                                if (!infoLog.enabled) return;
                                              break;
                                              case statsEvent:   
                                                if (!statsLog.enabled)  return;
                                              break;
                                              default:           
                                              break;}
                                            // log message 
                                            const log  = doorLog.logger;
                                            const door = doorLog.name;
                                            const accessoryName = doorLog.accessory;
                                            if (event == traceEvent) // get name of the method being traced
                                                var caller = getCaller(new Error().stack.split("\n")[2].trim().split(" ")[1])                                               
                                            log(`${event} - ${accessoryName} - ${door} ${(typeof caller !== "undefined" ? ` - ${caller}`:``)} - ${(msg == null ? ``:msg)}`);}

module.exports = (api) => {
  api.registerAccessory(plugInModule,accessoryName,homekitGarageDoorAccessory);
}                       

class homekitGarageDoorAccessory {
  constructor(log,config,api) {
    // required characteristics for homekit garage door accessory
    homeBridge.Service               = api.hap.Service;
    homeBridge.Characteristic        = api.hap.Characteristic;
    homeBridge.CurrentDoorState      = api.hap.Characteristic.CurrentDoorState;
    homeBridge.TargetDoorState       = api.hap.Characteristic.TargetDoorState;
    homeBridge.ObstructionDetected   = api.hap.Characteristic.ObstructionDetected;
    doorLog.logger                   = log;
    doorLog.name                     = config.name;
    doorLog.accessory                = config.accessory;
    const _currentDoorState          = homeBridge.CurrentDoorState;
    // array used to ensure that GPIO pin numbers configured are unique
    let GPIO_Pins_Configured         = []; 
    // functions to convert object keys and variable names into strings
    const objNameToText   = (obj)   => Object.keys(obj)[0];
    const varToUpperCase  = (myVar) => {return (myVar != null ? new String(myVar).toUpperCase().trim() : myVar);}
    const varToLowerCase  = (myVar) => {return (myVar != null ? new String(myVar).toLowerCase().trim() : myVar);}
    const doorswitch                 = objNameToText({doorSwitch});
    const doorsensor                 = objNameToText({doorSensor});
    const doorsensor2                = objNameToText({doorSensor2});
    // external functions used in constructor
    const {inRange}                  = require('lodash');
    const {writeFileSync,existsSync} = require('fs');
    // functions used to validate config info and construct objects for garage door management
    const switchSensorName = (id)    => {   switch (id) {
                                              case doorswitch:   return "Switch          ";
                                              case doorsensor:   return "Primary Sensor  ";
                                              case doorsensor2:  return "Secondary Sensor";
                                              default:           return "Internal switchSensorName Error";}} 
                                            
    const hasObject = ( configObject, objectName, key, value ) =>{
                                            if (!Object.hasOwn(configObject,key))
                                                return false;

                                            if (typeof value === 'object')
                                                return true;

                                            const errMsg =`configuration parameter [${key}] in ${objectName} needs to an object`;
                                            stopAccessory(fatalError.Invalid_Config_Info, errMsg)}
   
    const setValue = ( configInfo, defaultValue ) => {return (configInfo == null ? defaultValue : configInfo)}

    const validateConfigKeyWord = (configkeyWord,key,keyWords) =>{
                                            if (configkeyWord != null && !keyWords.includes(configkeyWord)){
                                                const errMsg = `${key} : [ ${configkeyWord} ] - valid configuration parameters are [ ${keyWords} ]`;
                                                stopAccessory(fatalError.Invalid_Config_Info, errMsg)}}
    
                                                
    const validateConfigObject = (configObject,objectName,validKeys) => {                                  
                                                  const configParam = Object.keys(configObject);
                                                  let len = configParam.length;
                                                  let index = 0;
                                                  while (len){
                                                    if (!validKeys.includes(configParam[index])){
                                                      const errMsg = `unknown configuration parameter [ ${configParam[index]} ] in ${objectName}`;
                                                      stopAccessory(fatalError.Invalid_Config_Info, errMsg)}
                                                      ++index;
                                                      --len}}
                                                      
    const validateConfigValue = (configvalue,key,minValue,maxValue) => {
                                                        if (!Number.isInteger(configvalue) || !inRange(configvalue,minValue,(maxValue + 1))) {
                                                          // log invalid config.json key word number
                                                          const errMsg = `Invalid Configuration Option for ${key} : [ ${configvalue} ] is invalid - valid number range is ${minValue} to ${maxValue}`;
                                                          stopAccessory(fatalError.Invalid_Config_Info, errMsg)}}                                    
                                                          
    const getValue = ( configInfo,key,saveValue ) => {
                                                      let configValue = setValue(configInfo,saveValue.defaultValue);
                                                      validateConfigValue(configValue,key,saveValue.minValue,saveValue.maxValue);
                                                      return configValue}

    const checkForDuplicateGPIOpins = () => { // prevent duplicate GPIO pin configuration     
                                            let search_len = GPIO_Pins_Configured.length - 1;
                                            let index = 0;
                                            GPIO_Pins_Configured.sort();
                                            while (search_len){
                                              if (GPIO_Pins_Configured[index] == GPIO_Pins_Configured[index+1]){
                                                  const errMsg = `GPIO pin [ ${GPIO_Pins_Configured[index]} ] has been specified more than once`;
                                                  stopAccessory(fatalError.GPIO_conflict, errMsg)};
                                              ++index;
                                            --search_len}}
    
    const getGPIOusePolicy = (configObject,key,saveValue) => { // check for config.ignoreGPIOinUse option..default is to ignore GPIO in use status
                                            const GPIOpolicylValue  = setValue(varToLowerCase(configObject.ignoreGPIOinUse),saveValue.defaultValue)
                                            validateConfigKeyWord(GPIOpolicylValue ,key,saveValue.validText);
                                            return  saveValue.setValue[ GPIOpolicylValue ]} //set user policy                        

    const gpioInuse =(GPIO,unexportGPIO) => { // check availability of GPIO pin                                         
                                            const GPIOexportPath = '/sys/class/gpio/gpio';
                                            const GPIOunexportPath = '/sys/class/gpio/unexport';
                                            const GPIOfile = GPIOexportPath + GPIO + '/';
                                            if (unexportGPIO && existsSync( GPIOfile )) 
                                                writeFileSync(GPIOunexportPath, `${GPIO}`); // free GPIO pin that was previously exported by another process        
                                            return (existsSync( GPIOfile ))}

    const validateGPIOpin = (GPIO,objectName) => {
                                            //const validGPIOpins = [5,6,12,13,16,17,22,23,24,25,26,27];
                                            const GPIOmsgHdr = `[ GPIO ${GPIO} ] `;

                                            if (!Number.isInteger(GPIO)) {
                                                const errMsg = `for ${switchSensorName(objectName)}GPIO value must be either integer or string`;
                                                stopAccessory(fatalError.Invalid_GPIO, GPIOmsgHdr+errMsg)}

                                            if (!doorState.validGPIOpins.includes(GPIO)) {
                                                const errMsg = `for ${switchSensorName(objectName)}valid GPIO pins are [ ${doorState.validGPIOpins} ]`;
                                                stopAccessory(fatalError.Invalid_GPIO, GPIOmsgHdr+errMsg)}
                                                
                                            let gpio_was_inuse = gpioInuse(GPIO);    
                                            if (gpio_was_inuse && gpioInuse(GPIO,doorState.ignoreGPIOinUse.value)) {
                                                const errMsg = `for ${switchSensorName(objectName)}is already inuse`;
                                                stopAccessory(fatalError.Invalid_GPIO, GPIOmsgHdr+errMsg)}
                                          
                                            if (gpio_was_inuse)
                                                logEvent(warnEvent,`${switchSensorName(objectName)} ${GPIOmsgHdr} was being used by another process and has been exported into this process`)}     
                                              
    const setGPIO = (GPIO,objectName) => {// validate GPIO config info 
                                            if (GPIO == null){
                                                const errMsg = ` - GPIO in ${objectName}`;
                                                stopAccessory(fatalError.Missing_Required_Config, errMsg)}
                                            validateGPIOpin(GPIO, objectName);
                                            GPIO_Pins_Configured.push(GPIO); //store GPIO pin for trapping duplicate pin configuration
                                            return GPIO}     
                                               
    const setDeviceSignal = (connectionlValue,key,saveValue ) => {                                                                                                                                                              
                                            const connection = setValue(varToUpperCase(connectionlValue),saveValue.defaultValue)
                                            validateConfigKeyWord(connection,key,saveValue.validText);
                                            return saveValue.signalValue [connection]}
                                                 
    const setActutatorDoorStates = (position,paramText) => {
                                            // set door sensor position to indicate physical position of door when the sesor is activated
                                            // actuator default door position the primary sensor (doorSensor) is closed
                                            // set the sensor match and no match door states based on sesnor activation for door position
                                            const doorposition = setValue(varToLowerCase(position),closedDoor); 
                                            validateConfigKeyWord(doorposition,paramText,doorSensorPositions);
                                            const doorStateMatch    = (doorposition == closedDoor) ? _currentDoorState.CLOSED : _currentDoorState.OPEN;
                                            const doorStateNoMatch  = (doorposition == closedDoor) ? _currentDoorState.OPEN : _currentDoorState.CLOSED;
                                            return [doorposition,doorStateMatch, doorStateNoMatch]}

    const setInterruptHandler = () => {     // set the door sensor interrupt handler
                                            doorSensor.interrupt.handler =  this.processPrimarySensorInterrupt.bind(this);
                                            if (garageDoorHasSensor(doorSensor2)){
                                                doorSensor2.interrupt.handler =  this.processSecondarySensorInterrupt.bind(this);}} 

    const configureDoorSensor = (objectName,configsSensorInfo,doorSensorInfo,doorPosition) =>{ 
                                            // validate door sensor config          
                                            doorSensorInfo.GPIO = setGPIO(configsSensorInfo.GPIO,objectName); 
                                            // set door sensor configuration info with user or default settings
                                            doorSensorInfo.actuator.value = setDeviceSignal(configsSensorInfo.actuator, 
                                                                                            objKeySymbol(doorSensorInfo).actuator,
                                                                                            doorSensorInfo.actuator);
                                            // set door sensor position and actuator value door states
                                            [ doorSensorInfo.position,doorSensorInfo.actuator.doorStateMatch, doorSensorInfo.actuator.doorStateNoMatch ] 
                                                                                = setActutatorDoorStates(doorPosition, objKeySymbol(doorSensorInfo).position);} 

    const setinterruptDoorRequest = (configInfo,key,saveValue) =>{
                                            let interruptDoorRequest = setValue(varToLowerCase(configInfo),saveValue.defaultValue); //default stop
                                            validateConfigKeyWord(interruptDoorRequest,key,saveValue.validText);
                                            return [ saveValue.interruptValue[interruptDoorRequest].authorized, saveValue.interruptValue[interruptDoorRequest].newRequest]}

    const configureDoorSwitch = (objectName,configSwitchInfo,doorSwitchInfo) =>{// validate door switch configuration info
                                            // validate and save GPIO in array to check for duplicates
                                            doorSwitchInfo.GPIO                          = setGPIO(configSwitchInfo.GPIO,objectName);
                                            // validate doorSwitch configuration info with user or default settings 
                                            doorSwitchInfo.pressTimeInMs.value           = getValue(configSwitchInfo.pressTimeInMs,
                                                                                                    objKeySymbol(doorSwitchInfo).pressTimeInMs,
                                                                                                    doorSwitchInfo.pressTimeInMs);
                                            doorSwitchInfo.moveTimeInSec.value           = getValue(configSwitchInfo.moveTimeInSec,
                                                                                                    objKeySymbol(doorSwitchInfo).moveTimeInSec,
                                                                                                    doorSwitchInfo.moveTimeInSec);                                            
                                            // convert physical door move time from sec to ms
                                            doorState.moveTimeInMs =  doorSwitchInfo.moveTimeInSec.value * 1000;

                                            doorSwitchInfo.relaySwitch.writeValue  = doorSwitchInfo.relaySwitch.configValue
                                                                                   = setDeviceSignal(configSwitchInfo.relaySwitch, 
                                                                                                     objKeySymbol(doorSwitchInfo).relaySwitch,
                                                                                                     doorSwitchInfo.relaySwitch);
                                                                      //-----------authorized-----newRequest--------//
                                                                      //   stop |     true           false          //
                                                                      //    on  |     true           true           //
                                                                      //    off |     false          false          //
                                            [ doorSwitchInfo.interruptDoorRequest.authorized, doorSwitchInfo.interruptDoorRequest.newRequest ] 
                                                                                   = setinterruptDoorRequest(configSwitchInfo.interruptDoorRequest,
                                                                                                             objKeySymbol(doorSwitchInfo).interruptDoorRequest,
                                                                                                             doorSwitchInfo.interruptDoorRequest);}
                                                                
    const activateGPIO = (GPIO, direction, edge, options = {}) => {
                                            logEvent(traceEvent, `[ GPIO = ${GPIO} ] [ direction = ${direction} ] [ edge = ${edge} ] `+
                                                                 `[ options entries = ${(options != null ? Object.entries(options) : 'None passed')}]`); 
                                            try { return new gpio(GPIO,direction,edge,options);
                                            } catch(error){  
                                                const errMsg = `Attempt to activate GPIO ${GPIO} - onoff Error = ${error}]`;
                                                stopAccessory(fatalError.Door_Switch_OnOff_Error,errMsg);
                                            }}                                       
    // plugin start
    const loggingIs = (type) => {return (!type || type == undefined) ? false : true};                                                                           
    logEvent(startupEvent,`Plugin Module ${plugInModule} Version ${version} ${(config.sensors ? `- configured with actuator(s)`:``)}- Optional Logging Events `+
                          `[ Trace=${loggingIs(traceLog.enabled)} Info=${loggingIs(infoLog.enabled)} Stats=${loggingIs(statsLog.enabled)} ]`);
                          
    logEvent(traceEvent,`config entries ${Object.entries(config)}`);  

    // ensure 1:1 mapping of accessory to bridge
    if (doorSwitch.GPIO != null){
        const errMsg = `configure a seperate bridge for [ ${varToUpperCase(config.name)} ]`;
        stopAccessory(fatalError.Internal_Error,errMsg);}

    // defensive programming check
    if (config.accessory != accessoryName){ 
      const errMsg = `config acessory name [ ${config.accessory} ] does not match expected name [ ${accessoryName} ]`;
      stopAccessory(fatalError.Internal_Error,errMsg);}

    // validate config sensor
    validateConfigValue(config.sensors,objKeySymbol(config).sensors,doorState.sensors.minValue,doorState.sensors.maxValue);
    
    // check for presense of doorSwitch config object 
    if (!hasObject(config, objNameToText({config}), doorswitch, config.doorSwitch))
      stopAccessory(fatalError.Missing_Required_Config,`${doorswitch}`);

    
    // check for presense of GPIO policy config parameter (ignoreGPIOinUse)
    doorState.ignoreGPIOinUse.value = getGPIOusePolicy(config,objKeySymbol(doorState).ignoreGPIOinUse,doorState.ignoreGPIOinUse);
    logEvent(startupEvent,`GPIO pins will be exported ${(doorState.ignoreGPIOinUse.value ? ``:`if not being used by another process`)}`);
    
    // get door switch config info   
    const doorSwitchKeySymbol = objKeySymbol(doorSwitch);
    const validDoorSwitchParams = [doorSwitchKeySymbol.GPIO, doorSwitchKeySymbol.pressTimeInMs, doorSwitchKeySymbol.moveTimeInSec, 
                                   doorSwitchKeySymbol.relaySwitch, doorSwitchKeySymbol.interruptDoorRequest];
    validateConfigObject(config.doorSwitch, doorswitch, validDoorSwitchParams);
    configureDoorSwitch(doorswitch, config.doorSwitch, doorSwitch);
      
    //check for primary door sensors
    if (hasObject(config, objNameToText({config}), doorsensor, config.doorSensor)){
        ++doorState.sensors.value;
        // get primary door sensor config info
        const doorSensorKeySymbol = objKeySymbol(doorSensor);
        const validDoorSensorParams = [doorSensorKeySymbol.GPIO, doorSensorKeySymbol.actuator, doorSensorKeySymbol.position];
        validateConfigObject(config.doorSensor, doorsensor, validDoorSensorParams);
        configureDoorSensor(doorsensor, config.doorSensor, doorSensor, config.doorSensor.position); 
        //check for secondary door sensor    
                               
        if (hasObject(config, objNameToText({config}), doorsensor2, config.doorSensor2)){
            ++doorState.sensors.value;
            // when 2 door sensors are configured...the primary door sensor position 
            // must be 'closed' which is the default when position is not specified
            // this should not occur when using the config.json schema
            if (doorSensor.position == openDoor)
               stopAccessory(fatalError.Sensor_Position_Requirement);
            // use primary door sensor config info as a superset for secondary sensor config validation
            const filterdoorSensor2 = {keys:[...validDoorSensorParams],itemsToRemove:[]};
            // remove 'position' and 'doorSensor2' text strings from list of valid config text for secondary door sensor object
            filterdoorSensor2.itemsToRemove.push(doorSensorKeySymbol.position);
            const removeItem = (item) => {return !filterdoorSensor2.itemsToRemove.includes(item)}
            // create list of valid config info for second door sensor
            const validdoorSensor2Params = filterdoorSensor2.keys.filter(removeItem);
            validateConfigObject(config.doorSensor2, doorsensor2, validdoorSensor2Params);
            configureDoorSensor(doorsensor2, config.doorSensor2, doorSensor2, openDoor); //secondary door sensot position is always 'open'
         }; 
      };
      
    // check GPIO's are unique 
    checkForDuplicateGPIOpins();

    // check for door sensor config mismatch
    if (doorState.sensors.value != config.sensors){
       // validate number of sensors configured
       const errMsg = `configuration mismatch - was expecting ${config.sensors} sensor(s) - configuration contains ${doorState.sensors.value} sensor(s)`;
       if (doorState.sensors.value < config.sensors){
          stopAccessory(fatalError.Internal_Error,errMsg);
       } else {
          logEvent(warnEvent,errMsg);
       }
    }      
    
    // configure interrupt handler methods
    if (doorState.sensors) 
        setInterruptHandler();    

    // door switch configured...open GPIO for door switch, log door switch configuration info
    doorSwitch.onOff = activateGPIO(doorSwitch.GPIO, 
                                    switchDirection(doorSwitch.relaySwitch.configValue), 
                                    none, 
                                    {activeLow: switchSignal(doorSwitch.relaySwitch.configValue)});

    logEvent(startupEvent,`${switchSensorName(doorswitch)} [ GPIO: ${doorSwitch.GPIO} ] - [ Switch is active ${switchDirection(doorSwitch.relaySwitch.configValue)} ]`);
    logEvent(startupEvent,`${switchSensorName(doorswitch)} switch activation time : ${doorSwitch.pressTimeInMs.value} ms`);
    logEvent(startupEvent,`${switchSensorName(doorswitch)} OPEN / CLOSE time: ${doorSwitch.moveTimeInSec.value} seconds`);
             
    const interruptDoorRequestConditions = () => {return (doorSwitch.interruptDoorRequest.authorized ? 
                                                         `ACCEPTED - current request will be stopped ${doorSwitch.interruptDoorRequest.newRequest ? 
                                                         ` - new request EXECUTED` :``} `: `REJECTED`)};
    logEvent(startupEvent,`${switchSensorName(doorswitch)} when a door open or close request is already in progress, a new request received will be ${interruptDoorRequestConditions()}`);
    
    if (!doorState.sensors.value && doorSwitch.interruptDoorRequest.authorized){
      const warnMsg = `door has no sensors configured and should either remove interruptDoorRequest from configuration or set interruptDoorRequest to off`;
      logEvent(warnEvent,warnMsg)}

    const configuredSensors = (garageDoorHasSensor(doorSensor2) ? `Primary and Secondary Sensors are` : `Primary Sensor   is`);
    const logCurrentDoorState = () => {
                                  logEvent(startupEvent,`${(!garageDoorHasSensor(doorSensor) ? `No door sensor so assume door`:`${configuredSensors} indicating door`)} `+
                                                        `${doorStateText(doorState.current)}`);}                                                                                  

    if (garageDoorHasSensor(doorSensor)) {   
        // door sensor configured ...open GPIO for door sensor, log door sensor configuration info
        logEvent(startupEvent,`${configuredSensors} configured:to alert on ${(garageDoorHasSensor(doorSensor2) ? 'OPEN, CLOSED and detect Partially Open (ie STOPPED - possible obstacle blockage)' :'OPEN and CLOSED')}`);

        // startup logging door sensor info
        const logSensorStartupinfo = (sensor,id) => {
                                  logEvent(startupEvent,`${switchSensorName(id)} [ GPIO: ${sensor.GPIO} ] - [ Interrupt on ${sensor.actuator.value ? `Active High` : `Active low`} ]`);
                                  logEvent(startupEvent,`${switchSensorName(id)} can determine door is completely ${sensor.position.toUpperCase()}`);
                                  logEvent(startupEvent,`${switchSensorName(id)} on sensor match door is ${doorStateText(sensor.actuator.doorStateMatch)} `+
                                                        `- on no match door is ${doorStateText(sensor.actuator.doorStateNoMatch)}`);} 
        // activate primary door sensor
        doorSensor.onOff = activateGPIO(doorSensor.GPIO, 'in', none );
        logSensorStartupinfo(doorSensor,doorsensor);

        if (garageDoorHasSensor(doorSensor2)){ 
            // activate secondary door sensor
            doorSensor2.onOff = activateGPIO(doorSensor2.GPIO, 'in', none );
            logSensorStartupinfo(doorSensor2,doorsensor2);}

        // get cuurent door state info
        [ doorState.target, doorState.obstruction, doorState.current ] = this.getDoorStateInfo(doorSensor);
        doorState.obstruction = false; //on startup obstacle detection is inaccurate to report...can only correctly report door is open
        logCurrentDoorState();
     
        if (doorState.target != _currentDoorState .CLOSED)
            this.collectDoorStats(doorState.current,doorState.obstruction);

        //set up door sensor(s) interrupt monitoring 
        this.activateDoorSensor(doorState.current); 
    }else{
        // no door sensor switch only...so assume door is closed
        doorState.target = doorState.current = _currentDoorState .CLOSED;
        logCurrentDoorState();
    } 
    // create a garage door service
    this.garageDoorService = new homeBridge.Service.AccessoryInformation();      
    this.garageDoorService
        .setCharacteristic(homeBridge.Characteristic.Manufacturer, accessoryInfo.developer)
        .setCharacteristic(homeBridge.Characteristic.Model, accessoryInfo.product)
        .setCharacteristic(homeBridge.Characteristic.SerialNumber, accessoryInfo.randomnum);

    this.garageDoorOpener = new homeBridge.Service.GarageDoorOpener(doorLog.name);

    this.currentDoorState = this.garageDoorOpener.getCharacteristic(homeBridge.CurrentDoorState);
    this.currentDoorState
        .onGet(this.getCurrentDoorState.bind(this));
          
    this.targetDoorState = this.garageDoorOpener.getCharacteristic(homeBridge.TargetDoorState);
    this.targetDoorState
        .onSet(this.setTargetDoorState.bind(this))
        .onGet(this.getTargetDoorState.bind(this));
          
    this.obstructionDetected = this.garageDoorOpener.getCharacteristic(homeBridge.ObstructionDetected);
    this.obstructionDetected
        .onGet(this.getObstructionDetected.bind(this));     
  }
                     
  getServices(){
    logEvent(traceEvent);
    return [this.garageDoorService, this.garageDoorOpener];
  }

  cancelAllEvents(){
    logEvent(traceEvent,`all timers and interrupt monitors`);
    doorState.timerId  = killTimer( doorState.timerId);
    if (garageDoorHasSensor(doorSensor))
        this.setAllDoorSensors(cancelInterrupt);
  }

  async getObstructionDetected(){
    logEvent(traceEvent,`[ door obstruction = ${doorState.obstruction} ]`);
    return doorState.obstruction;
  }
    
  async getCurrentDoorState(){
    logEvent(traceEvent,`[ current door state = ${doorStateText(doorState.current)} ]`);
    return doorState.current;
  }

  async getTargetDoorState(){
    logEvent(traceEvent,`[ current target door state = ${doorStateText(doorState.target)} ]`);
    return doorState.target;
  }

  async setTargetDoorState(targetDoorState){
    const _currentDoorState  = homeBridge.CurrentDoorState;
    logEvent(traceEvent, `[ current door state = ${doorStateText(doorState.current)} ] [ target door state = ${doorStateText(targetDoorState)} ] `+
                         `[ homeKitRequest - ${doorState.homeKitRequest} ]`);

                                            //-------------authorized------//
                                            //   stop   |     true         //
                                            //    on    |     true         // 
                                            //    off   |     false        //
    const newRequestAction = () => { return (doorSwitch.interruptDoorRequest.authorized && !doorSwitch.interruptDoorRequest.newOpInProgress);}  

    // determine if the current request can be interrupted 
    // update target and current state info to complete new request                                
    let interruptDoorMove = false;  
    if (doorState.homeKitRequest){
      ++doorSwitch.interruptDoorRequest.counter;
      if (!(interruptDoorMove = newRequestAction())) {
          //New Request not allowed
          logEvent(alertEvent,`Disregarding new request ${doorStateText(targetDoorState)} - currently processing ${doorStateText(doorState.current)} request`);
          this.updateTargetDoorState(doorState.target);
          this.updateCurrentDoorState(doorState.current);
          return 
      } else {
          //New Request allowed
          logEvent(traceEvent,`new request to interrupt door move in progress [ source = ${doorRequestSource()} ] [ authorized = ${doorSwitch.interruptDoorRequest.authorized}]`+
                              `[ New Request Status = ${doorSwitch.interruptDoorRequest.newOpInProgress} ] `+
                              `[ currrent request = ${doorStateText(doorState.current)}] [ new request = ${doorStateText(targetDoorState)} ]`);

          logEvent(alertEvent,`Stopping current ${doorStateText(doorState.current)} ${ doorSwitch.interruptDoorRequest.newRequest ? `- starting new ${doorStateText(targetDoorState)} request` : ``}`);                    
      }   
    }
         
    doorState.homeKitRequest = true;    
    doorState.target         = targetDoorState; // set expected door state (open or closed)
    doorState.current        = (targetDoorState == _currentDoorState.OPEN) ? _currentDoorState.OPENING : _currentDoorState.CLOSING;
    this.activateDoorMotor((interruptDoorMove ? stopop : startop )); 
    this.updateCurrentDoorState(doorState.current);
  }

  updateTargetDoorState(currentDoor){
    logEvent(traceEvent);
    logEvent(infoEvent,`Door is ${doorStateText(currentDoor)}`);
    doorState.target = currentDoor;
    this.targetDoorState.updateValue(currentDoor);
  }

  updateCurrentDoorState(currentDoor,obstruction){
    logEvent(traceEvent);
    logEvent(infoEvent,`Door is ${doorStateText(currentDoor)} ${(obstruction ? `and obstructed ` : ``)}from ${doorRequestSource()}`);
    doorState.current = currentDoor;
    this.currentDoorState.updateValue(currentDoor);
    if (obstruction != null){
        doorState.obstruction = obstruction; 
        this.obstructionDetected.updateValue(obstruction);}
  }

  activateDoorMotor(operation){
    logEvent(traceEvent, `${operation.toUpperCase()} [ GPIO = ${doorSwitch.GPIO} ]`); 
                                   
    const pushDoorButton = (op,nextAction,timeOut,timerId) => {
                                logEvent(traceEvent, `[ GPIO = ${doorSwitch.GPIO} ] [ write value = ${doorSwitch.relaySwitch.writeValue} ] [ timeout = ${timeOut} ]`); 
                                try {
                                    doorSwitch.onOff.writeSync(doorSwitch.relaySwitch.writeValue);
                                } catch(error){  
                                    const errMsg = `Attempt to ${op} door switch failed - [ GPIO = ${doorSwitch.GPIO} - write error = ${error} ]`;
                                    stopAccessory(fatalError.Door_Switch_Write_Error,errMsg);
                                };
                                doorSwitch.relaySwitch.writeValue = doorSwitch.relaySwitch.writeValue ^ 1; //cycle through on/off sequence
                                return scheduleTimerEvent( timerId, nextAction, timeOut );}
 

    switch (operation){
      case startop:
        this.cancelAllEvents();// stop listening for door sensor interrupts since an interrupt will occur when the button is pushed
        mutexon();
        doorState.timerId = pushDoorButton(operation,  // press the button 
                                  this.activateDoorMotor.bind(this,executeop),
                                  doorSwitch.pressTimeInMs.value,
                                  doorState.timerId);
      break;
      case executeop:
        doorState.timerId = pushDoorButton(operation,  // release the button and move the door  
                                  this.processDoorTimer.bind(this),
                                  doorState.moveTimeInMs,
                                  doorState.timerId);

        if (garageDoorHasSensor(doorSensor))
            this.activateDoorSensor(doorState.current);//use both sensor and timer to determine when door move has completed 

        mutexoff();
      break;
      case stopop: // this will stop the garagdoor motor
        this.cancelAllEvents();// stop listening for door sensor interrupts since an interrupt will occur when the button is pushed
        mutexon();
        if (doorSwitch.interruptDoorRequest.newRequest){
            doorState.timerId = pushDoorButton(operation,  //press button to stop door movement and press again to reverse door movement
                                      this.activateDoorMotor.bind(this,reverseop),                              
                                      doorSwitch.pressTimeInMs.value,
                                      doorState.timerId);}
        else{
          doorState.timerId = pushDoorButton(operation,
                                    this.activateDoorMotor.bind(this,executeop), // push button to begin to stop door movement
                                    doorSwitch.pressTimeInMs.value,
                                    doorState.timerId);
          doorState.stopDoorMovement= true;}
      break;
      case reverseop:
        doorState.timerId = pushDoorButton(operation,
                                    this.activateDoorMotor.bind(this,startop),   // release the button to stop door movement and reverse door movement                                
                                    doorSwitch.pressTimeInMs.value,
                                    doorState.timerId);
        doorState.reverseDoorMovement = true;
        //doorSwitch.interruptDoorRequest.newOpInProgress = false;//allow new requests to be processed                            
      break;
      default: 
        const errMsg = `invalid operation [${operation}]`;
        stopAccessory(fatalError.Internal_Error,errMsg);
      break;
    }       
  }

  processDoorTimer(){
    logEvent(traceEvent, `[ GPIO = ${doorSensor.GPIO} ]`);
    let doorIsOpenOrClosed,doorObstruction,currentDoorState;
    this.cancelAllEvents();
    if (garageDoorHasSensor(doorSensor)){
        [doorIsOpenOrClosed,doorObstruction,currentDoorState] = this.getDoorStateInfo(doorSensor);
    }else{
        doorObstruction  = false;
        doorIsOpenOrClosed = currentDoorState = doorState.target;
    }
    this.updateDoorState(doorIsOpenOrClosed,doorObstruction,currentDoorState);
  }

  updateDoorState(doorIsOpenOrClosed,doorObstruction,currentDoorState){
    const requestSource = doorRequestSource();   
    logEvent(traceEvent, `[ source = ${requestSource} ] ${(requestSource == homekit ? `[ request = ${doorStateText(doorState.target)} ]` : ``)} `+
                         `[ sensor state = ${doorStateText(currentDoorState)} ] [ door state = ${doorStateText(doorIsOpenOrClosed)} ]`+
                         `[ door state reverse door movement =  ${doorState.reverseDoorMovement} ] [ door request interrupted = ${doorSwitch.interruptDoorRequest.newOpInProgress} ]`);
    
    const resetSwitchDirection = () => {
      logEvent(traceEvent, `[ GPIO = ${doorSwitch.GPIO} ] [ direction value = ${switchDirection(doorSwitch.relaySwitch.configValue)} ]`); 
      try {
        doorSwitch.onOff.setDirection(switchDirection(doorSwitch.relaySwitch.configValue));
      } catch(error){  
        const errMsg = `Attempt to ${op} door switch failed - [ GPIO = ${doorSwitch.GPIO} - setDirection error = ${error} ]`;
        stopAccessory(fatalError.Door_Switch_Write_Error,errMsg);
      };}
      
    const resetSwitchActiveLow = () => {
      logEvent(traceEvent, `[ GPIO = ${doorSwitch.GPIO} ] [ active low value = ${switchSignal(doorSwitch.relaySwitch.configValue)} ]`); 
      try {
        doorSwitch.onOff.setActiveLow(switchSignal(doorSwitch.relaySwitch.configValue));
      } catch(error){  
        const errMsg = `Attempt to ${op} door switch failed - [ GPIO = ${doorSwitch.GPIO} - setActiveLow error = ${error} ]`;
        stopAccessory(fatalError.Door_Switch_Write_Error,errMsg);
      };}
        
    // update door state info
    this.updateTargetDoorState(doorIsOpenOrClosed); // this method will also update dooState.target
    this.updateCurrentDoorState(currentDoorState,doorObstruction); // this method will also update dooState.current and doorState.obstruction
    
    //set door state info
    doorState.last = currentDoorState;  // save last door state for helping to assist in determiing interrupt arming and obstacle detection for next operation
    doorState.stopDoorMovement = doorState.reverseDoorMovement = doorState.homeKitRequest = false;
    
    if (garageDoorHasSensor(doorSensor)){
        this.collectDoorStats(doorIsOpenOrClosed,doorObstruction); // collect door stats information and reset switch info
        this.activateDoorSensor(currentDoorState);} // rearm door sensor interrupts
    
    // reset switch info 
    doorSwitch.interruptDoorRequest.newOpInProgress = false;
    doorSwitch.interruptDoorRequest.counter = 0;
    doorSwitch.relaySwitch.writeValue = doorSwitch.relaySwitch.configValue;                             

    // physical door swich may be in an unkown state if requests were issued from both iphone and traditional garagedoor switch..so always reset it
    resetSwitchDirection();
    resetSwitchActiveLow();
  }

  collectDoorStats(doorstate,doorObstruction){
    const _currentDoorState = homeBridge.CurrentDoorState;  
    
    const dateTimeFormat = (timestamp) =>{      
                              const options = {
                              year: 'numeric', month: 'numeric', day: 'numeric',
                              hour: 'numeric', minute: 'numeric', second: 'numeric',
                              hour12: false};
                              let _date = new Date(timestamp);
                              return `[ ${new Intl.DateTimeFormat('en-US', options).format(_date)} ]`;}
    
    const doorOpenCloseStats = (msg, doorStats) => { 
                             doorStats.time = Date.now();
                             doorStats.requestSource = doorRequestSource();
                             logEvent(statsEvent,`Door ${(msg == openDoor ? `Open` : `Closed`)} time ${dateTimeFormat(doorStats.time)} from [ ${doorStats.requestSource} ]`);}

    const doorObstructStats = (msg,doorstate) => { 
                            const obstructionTime = Date.now();
                            logEvent(statsEvent,`Door Obstruction ${msg} at ${dateTimeFormat(obstructionTime)} `+
                            `- door is ${doorStateText(doorstate)}`);
                            return obstructionTime}
    
    const logDoorStats = (event) => {
                            let doorStatMsg;
                            const totalSecs = (t1,t2) => {const millis = t1 - t2;return Math.floor(millis / 1000);}
                            switch (event) {
                              case openClose: 
                                if (doorStats.open.time != null) { //door is closed but obstruction was detected..so the open request failed and was not logged
                                    doorStatMsg = `Door Open for ${totalSecs(doorStats.close.time, doorStats.open.time)} seconds `+
                                                  `[ open from ${doorStats.open.requestSource} ] - [ closed from ${doorStats.close.requestSource} ]`;
                                    // log event   
                                    logEvent(statsEvent,doorStatMsg);
                                }
                                // reset door event stats
                                doorStats.open.requestSource = doorStats.close.requestSource = '';
                                doorStats.open.time = doorStats.close.time = null;
                              break;
                              case obstructed:
                                doorStatMsg = `Door Obstructed for ${totalSecs(doorStats.obstruction.endTime, doorStats.obstruction.startTime)} seconds`;
                                // log event  
                                logEvent(statsEvent,doorStatMsg);
                                // reset door stats
                                doorStats.obstruction.startTime = doorStats.obstruction.endTime = null;
                              break;
                              default:
                                const errMsg = `invalid event [${event}]`;
                                stopAccessory(fatalError.Internal_Error,errMsg);
                              break;}
                            logEvent(traceEvent,`[ event = ${event} ] [${doorStatMsg}]`);}                  
    
    logEvent(traceEvent,`[ door state = ${doorStateText(doorstate)}  [ door obstruction = ${doorObstruction}] `);
                
    switch (doorstate) {
      case _currentDoorState.STOPPED:
      case _currentDoorState.OPEN:
        if (doorStats.open.time == null)
            doorOpenCloseStats(openDoor,doorStats.open);
      break;
      case _currentDoorState.CLOSED:
        if (doorStats.open.time != null){
            doorOpenCloseStats(closedDoor,doorStats.close);
            logDoorStats(openClose); } // log total door open time
      break; 
      default:
        const errMsg = `invalid door state [${doorstate}]`;
        stopAccessory(fatalError.Internal_Error,errMsg);
      break;}
        
    const doorSensorObstructionEvents  = [ "detected", "corrected" ];
    const [detected, corrected] = doorSensorObstructionEvents;

    if (doorObstruction && doorStats.obstruction.startTime == null){
        doorStats.obstruction.startTime = doorObstructStats(detected,doorstate) 
    } else if (!doorObstruction && doorStats.obstruction.startTime != null){
        doorStats.obstruction.endTime = doorObstructStats(corrected ,doorstate)
        logDoorStats(obstructed); }// log total door obstruction time
    
    if (doorRequestSource() == homekit && doorSwitch.interruptDoorRequest.counter)
        logEvent(alertEvent,`There were ${doorSwitch.interruptDoorRequest.counter} requests to reverse the current door nove request`);
  }

  getGarageDoorSensor(sensor){

    const readSensor = () => {try { return sensor.onOff.readSync();
                                  } catch(error){
                                          const errMsg = `Attempt to read door sensor failed - [GPIO = ${sensor.GPIO} - Read Error = ${error}]`;
                                          stopAccessory(fatalError.Door_Sensor_Read_Error,errMsg);};} 

    const doorGPIOvalue = readSensor();   
    // translate door sensor value to OPEN or CLOSED door state
    const currentDoorState = (doorGPIOvalue == sensor.actuator.value) ? sensor.actuator.doorStateMatch: sensor.actuator.doorStateNoMatch;
    logEvent(traceEvent, `[ GPIO = ${sensor.GPIO} ] [ actuator value = ${doorGPIOvalue} ] `+
                         `[ door state = ${doorStateText(currentDoorState)} ] `+
                         `[match state = ${doorStateText(sensor.actuator.doorStateMatch)}] `+
                         `[NO match state = ${doorStateText(sensor.actuator.doorStateNoMatch)}]`);
    return currentDoorState;
  }

  activateDoorSensor(doorstate) {
    const _currentDoorState  = homeBridge.CurrentDoorState;
    const setBoth = (doorState.last == _currentDoorState.STOPPED || doorstate == _currentDoorState.STOPPED || doorState.reverseDoorMovement);
    logEvent(traceEvent,`[ current door state = ${doorStateText(doorstate)}`);
    
    const setInterruptSignal = (sensor,interruptSignal) => {               
                              logEvent(traceEvent, `[ GPIO = ${sensor.GPIO} ] [ Sensor Actuator = ${sensor.actuator.value} ] [ Interrupt Edge Setting = ${interruptSignal} ]`);
                              try {
                                  sensor.onOff.setEdge(interruptSignal);
                              } catch(error){
                                  const errMsg = `Attempt to set Edge (interrupt signal) failed [ GPIO = ${sensor.GPIO} Edge Setting = ${interruptSignal} Error = ${error} ]`;
                                  stopAccessory(fatalError.Door_Sensor_OnOff_Error,errMsg);
                              };}
    
    const setPrimaryEdgeSignal = (sensor) => {
                              logEvent(traceEvent, `[ GPIO = ${sensor.GPIO} ] [ Edge Setting Door State = ${doorStateText(doorstate)} ]`);
                              if (sensor.actuator.doorStateMatch == doorstate){
                                  return (sensor.actuator.value ^ 1 ? rising : falling) 
                              } else
                                  return (sensor.actuator.value ? rising : falling);} // reverse interrupt edge setting when sesnor does not matches current doorstate                          

    const activatePrimarySensor = (sensor) => {
                              setInterruptSignal(sensor,setPrimaryEdgeSignal(sensor));
                              this.setGarageDoorSensor(sensor,activateInterrupt);}

    const setDualSensorEdgeSignal = (sensor) => {
                              if (setBoth){ return both
                              } else        return setPrimaryEdgeSignal(sensor)}                          
    
    const activateBothSensors = (sensor1,sensor2) => {                        
                              setInterruptSignal(sensor1,setDualSensorEdgeSignal(sensor1));
                              this.setGarageDoorSensor(sensor1,activateInterrupt);
                              if (setBoth){
                                  setInterruptSignal(sensor2,setDualSensorEdgeSignal(sensor2));
                                  this.setGarageDoorSensor(sensor2,activateInterrupt);}}
                                  
    const twoSensors = garageDoorHasSensor(doorSensor2);
                            
    switch(doorstate) {
      case _currentDoorState.OPEN:  
      case _currentDoorState.OPENING:
        if (!twoSensors && (doorSensor.position == openDoor || doorstate == _currentDoorState.OPEN)){
            activatePrimarySensor(doorSensor);  
            return;}

        if(twoSensors){
            activateBothSensors(doorSensor2,doorSensor);
            return}    

      break;
      case _currentDoorState.CLOSED:
      case _currentDoorState.CLOSING:
        if (!twoSensors && (doorSensor.position == closedDoor || doorstate == _currentDoorState.CLOSED)){
            activatePrimarySensor(doorSensor);  
            return}

        if(twoSensors){
          activateBothSensors(doorSensor,doorSensor2);
          return}    

      break;
      case _currentDoorState.STOPPED:
        activateBothSensors(doorSensor,doorSensor2);
      return;    
      default:
        const errMsg = `invalid door state [${doorStateText(doorstate)}`;
        stopAccessory(fatalError.Internal_Error,errMsg);
      break; 
      }
    logEvent(traceEvent,`[ no interrupt activation ]`);
  }

  setAllDoorSensors(interruptAction){
    logEvent(traceEvent,`[ request ${interruptAction} ] `);
    this.setGarageDoorSensor(doorSensor,interruptAction);// activate or cancel listening for door sensor interrupts
    if (garageDoorHasSensor(doorSensor2))
        this.setGarageDoorSensor(doorSensor2,interruptAction);// activate or cancel listening for door sensor2 interrupts
  }

  setGarageDoorSensor(sensor,interruptAction){
    logEvent(traceEvent,`[ request ${interruptAction} GPIO = ${sensor.GPIO} ] `+
                        `[ queued interrupts = ${sensor.interrupt.count} ]`);

    if (interruptAction == activateInterrupt  && !sensor.interrupt.count){
        try {
          sensor.onOff.watch(sensor.interrupt.handler); // wait for door sensor value to change
        } catch (error) {
          const errMsg = `Attempt to monitor interrupt (watch)) failed [ GPIO = ${sensor.GPIO} Error = ${error} ]`;
          stopAccessory(fatalError.Door_Sensor_OnOff_Error,errMsg);
        }
        ++sensor.interrupt.count; // increment watch count
    }else if (interruptAction == cancelInterrupt && sensor.interrupt.count > 0) {
        try {
          sensor.onOff.unwatchAll(); // unwatch all to ensure no interrupts
        } catch (error) {
          const errMsg = `Attempt to cancel all interrupt monitoring (unwatch)) failed [ GPIO = ${sensor.GPIO} Error = ${error} ]`;
          stopAccessory(fatalError.Door_Sensor_OnOff_Error,errMsg);
        }
         --sensor.interrupt.count; // decrement watch count
    }
    logEvent(traceEvent,`[ result ${interruptAction} GPIO = ${sensor.GPIO} ] `+
                        `[ queued listener(s) = ${sensor.interrupt.count} ]`);
  }

  getDoorStateInfo(sensor){
    const _currentDoorState = homeBridge.CurrentDoorState;

    const garageDoorState =() => {
                                  const primaryDoorState  = this.getGarageDoorSensor(doorSensor);

                                  logEvent(traceEvent,`primary door sensor [ GPIO = ${doorSensor.GPIO} ] [ door state = ${doorStateText(primaryDoorState)} ]`);

                                  // 1 sesnor..so just use primary sensor
                                  if (!garageDoorHasSensor(doorSensor2)  || (primaryDoorState == doorSensor.actuator.doorStateMatch)) 
                                      return [primaryDoorState,primaryDoorState];
  
                                  // 2 sensors...primary indicated the door is open...check secondary sensor to determine current door state
                                  const secondaryDoorState = this.getGarageDoorSensor(doorSensor2);
  
                                  logEvent(traceEvent,`secondary door sensor [ GPIO = ${doorSensor2.GPIO} ] [ door state = ${doorStateText(secondaryDoorState)} ]`);
  
                                  if (secondaryDoorState == doorSensor2.actuator.doorStateMatch){
                                    return [secondaryDoorState,secondaryDoorState];
                                  }else return [_currentDoorState.STOPPED,_currentDoorState.OPEN];}
                                
    const [currentDoorState,doorOpenIsOrClosed] = garageDoorState();

    const doorObstruction = (currentDoorState == _currentDoorState.STOPPED && !doorState.stopDoorMovement); //a request to stop door movement should not be reported as an obstacle
    logEvent(traceEvent,`[ GPIO = ${sensor.GPIO} ] [ door sensor = ${doorStateText(doorOpenIsOrClosed)} ] [ door stopped by request = ${doorState.stopDoorMovement}]`+
                        `[ door obstruction = ${doorObstruction} ] [ door state = ${doorStateText(currentDoorState)} ]`);
    // garage door is open or closed
    return [doorOpenIsOrClosed,doorObstruction,currentDoorState];
  }

  processDoorInterrupt(sensor){
    // clear any pending homekit timeout and then update the door state
    logEvent(traceEvent,`[ GPIO = ${sensor.GPIO} ] [ source = ${doorRequestSource()} ]`);
    this.cancelAllEvents();
    const [doorOpenIsOrClosed,doorObstruction,currentDoorState] = this.getDoorStateInfo(sensor);
    this.updateDoorState(doorOpenIsOrClosed,doorObstruction,currentDoorState); 
  }

  processDoorMoveEvent(sensor){
    const _currentDoorState   = homeBridge.CurrentDoorState;
    const requestSource       = doorRequestSource();
    
    logEvent(traceEvent, `[ source = ${requestSource} ][ sensor door position = ${sensor.position}]`);
    
    if (requestSource == garageOpenner && garageDoorHasSensor(doorSensor2)) {
        // 2 door sensors..so able to monitor door transiton state
        const doorIsOpenOrClosed  = this.getGarageDoorSensor(sensor);
        logEvent(traceEvent,`[ GPIO = ${sensor.GPIO} ] [ door is = ${doorIsOpenOrClosed} ]`);

        const monitorDoorMove = (currentDoorOpeningClosing) => {
          logEvent(traceEvent,`[ desired target state = ${doorStateText(doorIsOpenOrClosed)} ] [ door state = ${doorStateText(currentDoorOpeningClosing)} ]`);
          this.updateTargetDoorState(doorIsOpenOrClosed);// update target door state to simulate a homekit request
          this.updateCurrentDoorState(currentDoorOpeningClosing);
          const completeDoorOpenClosed =this.processDoorInterrupt.bind(this,sensor);
          doorState.timerId = scheduleTimerEvent(doorState.timerId,completeDoorOpenClosed,doorState.moveTimeInMs);}

        // door opening or closing via request from native door wireless or wired button
        switch (sensor.position){
          case  openDoor: // secondary sensor...check primary sensor to confirm door is closing

            if (doorIsOpenOrClosed == _currentDoorState.CLOSED && this.getGarageDoorSensor(doorSensor) == _currentDoorState.OPEN){  
                this.activateDoorSensor(_currentDoorState.CLOSING)
                monitorDoorMove(_currentDoorState.CLOSING);
                return;}

          break;
          case  closedDoor: // primary sensor...check secondary sensor to confirm door is opening

            if (doorIsOpenOrClosed == _currentDoorState.OPEN && this.getGarageDoorSensor(doorSensor2) == _currentDoorState.CLOSED){ 
                this.activateDoorSensor(_currentDoorState.OPENING);  
                monitorDoorMove(_currentDoorState.OPENING);
                return;}

          break;
          default:
            const errMsg = `invalid sensor position [${sensor.position}]`;
            stopAccessory(fatalError.Internal_Error,errMsg);
          break;  
          }
    }       
    this.processDoorInterrupt(sensor); // door is either OPEN, CLOSED or STOPPED
  }

  resetGarageDoorSensor(sensor){
    logEvent(traceEvent,`[ last door state = ${doorStateText(doorState.last)} ]`);
    const _currentDoorState  = homeBridge.CurrentDoorState;
    if (doorState.last == _currentDoorState.STOPPED){
        this.setAllDoorSensors(cancelInterrupt)
    }else
        this.setGarageDoorSensor(sensor,cancelInterrupt);
  }

  processPrimarySensorInterrupt(err,doorSensorValue){ 
    logEvent(traceEvent,`[ GPIO = ${doorSensor.GPIO} ] [ actuator = ${doorSensor.actuator.value} ] [ sensor value = ${doorSensorValue} err from OnOff = ${err} ]`);
    this.resetGarageDoorSensor(doorSensor);
    this.processDoorMoveEvent(doorSensor)
  }

  processSecondarySensorInterrupt(err,doorSensorValue){ 
    logEvent(traceEvent,`[ GPIO = ${doorSensor2.GPIO} ] [ actuator = ${doorSensor2.actuator.value} ] [ sensor value = ${doorSensorValue} err from OnOff = ${err} ]`);
    this.resetGarageDoorSensor(doorSensor2);
    this.processDoorMoveEvent(doorSensor2);            
  }
}