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
const gpio = require('onoff').Gpio;
const version = require('./package.json').version;
const localFolderName = () => {const path = require('path'); return path.basename(__dirname);};
const plugInModule = localFolderName();
const accessoryName = "smartgaragedoor";
const accessoryInfo  = {developer:`Homebridge Open Source Project`, product:`Homebridge ${accessoryName} - Version ${version}`, randomnum:Math.floor((Math.random() * 10000) + 1)};
//door request source
const doorRequestSources = [ "apple homekit", "garagedoor openner" ];
const [homekit, garageOpenner] = doorRequestSources;
//external door events
const doorStatsEvents  = [ "openClose", "obstructed", "interruptedrequests" ];
const [openClose, obstructed, interruptedrequests] = doorStatsEvents;
//internal switch operations
const doorSwitchOperations  = [ "startop", "executeop" , "stopop", "reverseop"];
const [startop, executeop, stopop, reverseop ] = doorSwitchOperations;
//door sensor indication of physical door state
const doorSensorPositions = [ "open", "closed" ];
const [openDoor, closedDoor] = doorSensorPositions;
//internal state of door sensor monitoring
const doorSensorInterruptActions  = [ "activate", "cancel" ];
const [activateInterrupt, cancelInterrupt] = doorSensorInterruptActions;
//internal parameter setting for onOff GPIO interrupts
const onOffEdgeInterruptSettings = [ "none", "falling", "rising", "both" ];
const [ none, falling, rising, both ] = onOffEdgeInterruptSettings;
// garage door switch management objects 
const doorSwitch  = {GPIO:null, onOff:null, pressTimeInMs:null, moveTimeInSec:null, 
                     interruptActiveRequest:{ count:0, authorized:null, newRequest:null, suspend:false, timerId:null, timeOutInMs:2000 }, //stop accepting new requests after 2 secounds
                     relaySwitch:{ configValue:null, writeValue:null}};
// garage door sensor object factory                                                                                                                        
const sensorObj   =() => {return {GPIO:null, onOff:null, position:null,
                                  interrupt:{ count:0,handler:null },
                                  actuator:{ value:null,doorStateMatch:null,doorStateNoMatch:null }}}
// garage door sensor management objects                                                                                                                                                           
const doorSensor  = sensorObj();
const doorSensor2 = sensorObj();

const doorState   = {timerId:null, homeKitRequest:false, operationInterrupted:false, moveTimeInMs:null, last:null, current:null, target:null, obstruction:false};
const doorLog     = {logger:null, accessory:'', name:''};
const doorStats   = {open:{requestSource:'', time:null}, close:{requestSource:'', time:null}, obstruction:{startTime:null, endTime:null}};
const homeBridge  = {Service:null, Characteristic:null, CurrentDoorState:null, TargetDoorState:null, ObstructionDetected:null};

const fatalError  = { Missing_Required_Config:{
                            error:1,
                            text:`Missing Required Configuration Info - `},
                      Invalid_Config_Info:{
                            error:2,
                            text:`Invalid Configuration - `},
                      Invalid_GPIO:{
                            error:3,
                            text:`Invalid GPIO Pin - `},      
                      GPIO_conflict:{
                            error:4,
                            text:`Duplicate GPIO Pin detected for both switch and sensor(s) `},
                      Sensor_Position_Requirement:{
                            error:5,
                            text:`Primary door sensor position must be [ ${closedDoor} ] when secondary door sensor is configured`}, 
                      Invalid_Section:{
                            error:6,
                            text:`Invalid configuration section - `},
                      Door_Switch_Write_Error:{
                            error:7,
                            text: `Door Switch Write Error (OnOff) - `},
                      Door_Sensor_Read_Error:{
                            error:8,
                            text: `Door Sensor Read Error (OnOff) - `},
                      Door_Switch_OnOff_Error:{
                            error:9,
                            text: `Door Switch OnOff Error (setup) - `},      
                      Door_Sensor_OnOff_Error:{
                            error:10,
                            text: `Door Sensor OnOff Error (setup) - `},
                      Internal_Error:{
                            error:11,
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
const getCaller = (stack)              => {//get calling method / function name
                                           const reDot = /[.]/;
                                           return (stack.search(reDot) == -1 ? stack : stack.split(".")[1]);}

const stopAccessory = (exitCode, msg)  => {// log and terminate execution                                        
                                            logEvent(terminateEvent,`${getCaller(new Error().stack.split("\n")[2].trim().split(" ")[1])} - ${(msg != null ? exitCode.text + msg : exitCode.text)}`);  
                                            throw process.exit(1);}

const logEvent = (event, msg)          => { //logging function for all events
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
                                            //log message 
                                            const log  = doorLog.logger;
                                            const door = doorLog.name;
                                            const accessoryName = doorLog.accessory;
                                            if (event == traceEvent) //get name of the method being traced
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
    //array used to validate GPIO pins used by switch and sesnor(s) are unique
    let GPIO_Pins_Configured         = []; 
    // functions to convert object keys and variable names into strings
    const objNameToString = (obj)   => Object.keys(obj)[0];
    const varToUpperCase  = (myVar) => {return (myVar != null ? new String(myVar).toUpperCase().trim() : myVar);}
    const varToLowerCase  = (myVar) => {return (myVar != null ? new String(myVar).toLowerCase().trim() : myVar);}
    const doorswitch                 = objNameToString({doorSwitch});
    const doorsensor                 = objNameToString({doorSensor});
    const doorsensor2                = objNameToString({doorSensor2});
    // external functions used in constructor
    const {inRange}                  = require('lodash');
    const {writeFileSync,existsSync} = require('fs');
    // functions used to validate config info and construct objects for garage door management
    const switchSensorName = (id)    => {   switch (id) {
                                              case doorswitch:   return "Switch          ";
                                              case doorsensor:   return "Primary Sensor  ";
                                              case doorsensor2:  return "Secondary Sensor";
                                              default:           return "Internal switchSensorName Error";}} 
                                            
    const hasObject = ( configObj, sectionName, key, value ) =>{
                                            if (!Object.hasOwn(configObj,key))
                                                return false;

                                            if (typeof value === 'object')
                                                return true;

                                            const errMsg =`configuration parameter [${key}] in ${sectionName} section needs to an object`;
                                            stopAccessory(fatalError.Invalid_Config_Info, errMsg)}
   
    const setValue = ( configInfo, defaultValue ) => {return (configInfo == null ? defaultValue : configInfo)}

    const validateConfigKeyWord = (configkeyWord,key,keyWords) =>{
                                            if (configkeyWord != null && !keyWords.includes(configkeyWord)){
                                                const errMsg = `${key} : [ ${configkeyWord} ] - valid keywods are [ ${keyWords} ]`;
                                                stopAccessory(fatalError.Invalid_Config_Info, errMsg)}}

    const validateConfigSection = (configObj,sectionName,validKeys) => {                                  
                                            const configParam = Object.keys(configObj);
                                            let len = configParam.length;
                                            let index = 0;
                                            while (len){
                                              if (!validKeys.includes(configParam[index])){
                                                  const errMsg = `unknown configuration parameter [ ${configParam[index]} ] in ${sectionName} section`;
                                                  stopAccessory(fatalError.Invalid_Config_Info, errMsg)}
                                            ++index;
                                            --len}}
                                              
    const validateConfigSwitchValue = (configvalue,key,minValue,maxValue) => {
                                            if (!Number.isInteger(configvalue) || !inRange(configvalue,minValue,(maxValue+1))) {
                                                // log invalid config.json key word number
                                                const errMsg = `Invalid Configuration Option for ${key} : [ ${configvalue} ] is invalid - valid number range is ${minValue} to ${maxValue}`;
                                                stopAccessory(fatalError.Invalid_Config_Info, errMsg)}}

    const checkSensorConfig = ( expectedSensors ) => {
                                            const configuredSensors = GPIO_Pins_Configured.length-1; //subtract relay GPIO to get number of sensors
                                            if ( expectedSensors != null && expectedSensors != configuredSensors ){
                                                  const errMsg = `expecting sensors [ ${expectedSensors} ] does not match configured sensors [ ${configuredSensors} ]`;
                                                  logEvent(warnEvent,errMsg);}}                                            

    const checkForDuplicateGPIOpins = () => {      
                                            let len = GPIO_Pins_Configured.length;
                                            let index = 0;
                                            GPIO_Pins_Configured.sort();
                                            while (len > 1 && index < len){
                                              if (GPIO_Pins_Configured[index] == GPIO_Pins_Configured[index+1]){
                                                  const errMsg = `GPIO pin [ ${GPIO_Pins_Configured[index]} ] has been specified more than once`;
                                                  stopAccessory(fatalError.GPIO_conflict, errMsg)}
                                            ++index;
                                            --len}}

    const gpioInuse =(GPIO,unexportGPIO) => { //check availability of GPIO pin                                         
                                            const GPIOexportPath = '/sys/class/gpio/gpio';
                                            const GPIOunexportPath = '/sys/class/gpio/unexport';
                                            const GPIOfile = GPIOexportPath + GPIO + '/';
                                            if (unexportGPIO && existsSync( GPIOfile )) 
                                                writeFileSync(GPIOunexportPath, `${GPIO}`); // free GPIO pin for use          
                                            return (existsSync( GPIOfile ))}

    const validateGPIOpin = (GPIO,sectionName) => {
                                            const validGPIOpins = [4,5,6,12,13,16,17,18,19,20,21,22,23,24,25,26,27];
                                            const GPIOmsgHdr = `[ GPIO ${GPIO} ] `;

                                            if (!Number.isInteger(GPIO)) {
                                                const errMsg = `not an integer or it is specified as a string`;
                                                stopAccessory(fatalError.Invalid_GPIO, GPIOmsgHdr+errMsg)}

                                            if (!validGPIOpins.includes(GPIO)) {
                                                const errMsg = `not a valid GPIO pin for this accessory - valid GPIO pins [ ${validGPIOpins} ]`;
                                                stopAccessory(fatalError.Invalid_GPIO, GPIOmsgHdr+errMsg)}
                                                
                                            let gpio_was_inuse = gpioInuse(GPIO);    
                                            if (gpio_was_inuse && gpioInuse(GPIO,true)) {
                                                const errMsg = `already inuse`;
                                                stopAccessory(fatalError.Invalid_GPIO, GPIOmsgHdr+errMsg)}
                                          
                                            if (gpio_was_inuse)
                                                logEvent(warnEvent,`${switchSensorName(sectionName)} ${GPIOmsgHdr} was being used by another process and has been exported into this process`)}     
                                              
    const setGPIO = (GPIO,sectionName) => {// Validate GPIO config info 
                                            if (GPIO == null){
                                                const errMsg = ` - GPIO in section ${sectionName}`;
                                                stopAccessory(fatalError.Missing_Required_Config, errMsg)}
                                            validateGPIOpin(GPIO, sectionName);
                                            GPIO_Pins_Configured.push(GPIO);
                                            return GPIO}     
                                               
    const setDeviceSignal = (connectionlValue,paramText) => {                                                                                                
                                            // set door sensor activation and relay switch value based on connector ...    
                                            // default is  NO (Normally Open....return 1 
                                            // alternative connector NC (Normally Closed..return 0 
                                            const deviceSignal = [ "NO", "NC" ];
                                            const [normallyOpen] = deviceSignal;  
                                            const deviceSignalValue  = {NO:1,NC:0};                                                               
                                            const connection = setValue(varToUpperCase(connectionlValue),normallyOpen)
                                            validateConfigKeyWord(connection,paramText,deviceSignal);
                                            return deviceSignalValue [connection]}
                                                 
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

    const configureDoorSensor = (sectionName,configsSensorInfo,doorSensorInfo,doorPosition) =>{ 
                                            // validate door sensor config          
                                            doorSensorInfo.GPIO = setGPIO(configsSensorInfo.GPIO,sectionName); 
                                            // set door sensor configuration info with user or default settings
                                            doorSensorInfo.actuator.value = setDeviceSignal(configsSensorInfo.actuator, objKeySymbol(doorSensorInfo).actuator);
                                            // set door sensor position and actuator value door states
                                            [ doorSensorInfo.position,doorSensorInfo.actuator.doorStateMatch, doorSensorInfo.actuator.doorStateNoMatch ] 
                                                                                = setActutatorDoorStates(doorPosition, objKeySymbol(doorSensorInfo).position);} 

    const setInterruptActiveRequest = (interruptActiveRequestValue,paramText) =>{
                                            const interruptActiveRequestSettings = ["yes","no","stop"];
                                            const [yes,no,stop] = interruptActiveRequestSettings;
                                            const interruptActiveRequest = setValue(varToLowerCase(interruptActiveRequestValue),stop); //default stop
                                            validateConfigKeyWord(interruptActiveRequest,paramText,interruptActiveRequestSettings);
                                            return [(interruptActiveRequest == no ? false : true ),(interruptActiveRequest == yes ? true : false )];}

    const configureDoorSwitch = (sectionName,configSwitchInfo,doorSwitchInfo) =>{// validate door switch configuration info
                                            // validate and save GPIO in array to check for duplicates
                                            doorSwitchInfo.GPIO                    = setGPIO(configSwitchInfo.GPIO,sectionName);
                                            // validate doorSwitch configuration info with user or default settings 
                                            doorSwitchInfo.pressTimeInMs           = setValue(configSwitchInfo.pressTimeInMs,1500);
                                            validateConfigSwitchValue(doorSwitchInfo.pressTimeInMs,objKeySymbol(doorSwitchInfo).pressTimeInMs,1000,2000);
                                            doorSwitchInfo.moveTimeInSec           = setValue(configSwitchInfo.moveTimeInSec,12);
                                            validateConfigSwitchValue(doorSwitchInfo.moveTimeInSec,objKeySymbol(doorSwitchInfo).moveTimeInSec,10,15);
                                            doorSwitchInfo.relaySwitch.writeValue  = doorSwitchInfo.relaySwitch.configValue
                                                                                   = setDeviceSignal(configSwitchInfo.relaySwitch, objKeySymbol(doorSwitchInfo).relaySwitch);
                                            [ doorSwitchInfo.interruptActiveRequest.authorized, doorSwitchInfo.interruptActiveRequest.newRequest ] 
                                                                                   = setInterruptActiveRequest(configSwitchInfo.interruptActiveRequest,
                                                                                                              objKeySymbol(doorSwitchInfo).interruptActiveRequest);}
                                                                
    const activateGPIO = (GPIO, direction, edge, options = {}) => {
                                            logEvent(traceEvent, `[ GPIO = ${GPIO} ] [ direction = ${direction} ] [ edge = ${edge} ] [ options entries = ${(options != null ? Object.entries(options) : 'None passed')}]`); 
                                            try { return new gpio(GPIO,direction,edge,options);
                                            } catch(error){  
                                                const errMsg = `Attempt to activate GPIO ${GPIO} - onoff Error = ${error}]`;
                                                stopAccessory(fatalError.Door_Switch_OnOff_Error,errMsg);
                                            }}                                       
    //start of plugin processing                                                                                
    logEvent(startupEvent,`Plugin Module ${plugInModule} Version ${version} - Optional Event Logging [Trace=${traceLog.enabled} Info=${infoLog.enabled} Stats=${statsLog.enabled}]`);
    //ensure 1:1 mapping of accessory to bridge
    if (doorSwitch.GPIO != null){
      const errMsg = `configure a seperate bridge for [ ${varToUpperCase(config.name)} ]`;
      stopAccessory(fatalError.Internal_Error,errMsg);
    }
    logEvent(traceEvent,`config entries ${Object.entries(config)} keys ${Object.keys(config)}`);                              
    //defensive programming check
    if (config.accessory != accessoryName){ 
        const errMsg = `config acessory name [ ${config.accessory} ] does not match expected name [ ${accessoryName} ]`;
        stopAccessory(fatalError.Internal_Error,errMsg);
    }
    if (!hasObject(config, objNameToString({config}), doorswitch, config.doorSwitch))
        stopAccessory(fatalError.Missing_Required_Config,`${doorswitch}`);
    //get door switch config info   
    const doorSwitchKeySymbol = objKeySymbol(doorSwitch);
    const validDoorSwitchParams = [doorSwitchKeySymbol.GPIO, doorSwitchKeySymbol.pressTimeInMs, doorSwitchKeySymbol.moveTimeInSec, doorSwitchKeySymbol.relaySwitch, doorSwitchKeySymbol.interruptActiveRequest];
    validateConfigSection(config.doorSwitch, doorswitch, validDoorSwitchParams);
    configureDoorSwitch(doorswitch, config.doorSwitch, doorSwitch);
                                         
    if (hasObject(config, objNameToString({config}), doorsensor, config.doorSensor)){
        //get primary door sensor config info
        const doorSensorKeySymbol = objKeySymbol(doorSensor);
        const validDoorSensorParams = [doorSensorKeySymbol.GPIO, doorSensorKeySymbol.actuator, doorSensorKeySymbol.position, doorsensor2];
        validateConfigSection(config.doorSensor, doorsensor, validDoorSensorParams);
        configureDoorSensor(doorsensor, config.doorSensor, doorSensor, config.doorSensor.position);

        if (hasObject(config.doorSensor, doorsensor, doorsensor2, config.doorSensor.doorSensor2)){
            //when 2 door sensors are configured...the primary door sensor position 
            //must be 'closed' which is the default when position is not specified
            if (doorSensor.position == openDoor)
                stopAccessory(fatalError.Sensor_Position_Requirement);
            //use primary door sensor config info as a superset for secondary sensor config validation
            const filterdoorSensor2 = {keys:[...validDoorSensorParams],itemsToRemove:[]};
            filterdoorSensor2.itemsToRemove.push(doorSensorKeySymbol.position,doorsensor2);
            const removeItem = (item) => {return !filterdoorSensor2.itemsToRemove.includes(item)}
            //remove 'position' from doorSensor2 valid config info
            const validdoorSensor2Keys = filterdoorSensor2.keys.filter(removeItem);
            //get secondary door sensor config info
            validateConfigSection(config.doorSensor.doorSensor2, doorsensor2, validdoorSensor2Keys);
            configureDoorSensor(doorsensor2, config.doorSensor.doorSensor2, doorSensor2, openDoor);
            }

        setInterruptHandler();    
      }

    //check GPIO's are unique 
    checkForDuplicateGPIOpins();
    //defensive programming check - sensors expects should match configured
    checkSensorConfig(config.sensors);

    //convert physical door move time from sec to ms
    doorState.moveTimeInMs =  doorSwitch.moveTimeInSec * 1000;
   
    // door switch configured...open GPIO for door switch, log door switch configuration info
    doorSwitch.onOff = activateGPIO(doorSwitch.GPIO, 
                                    switchDirection(doorSwitch.relaySwitch.configValue), 
                                    none, 
                                    {activeLow: switchSignal(doorSwitch.relaySwitch.configValue)});

    logEvent(startupEvent,`${switchSensorName(doorswitch)} [ GPIO: ${doorSwitch.GPIO} ] - [ Switch is active ${switchDirection(doorSwitch.relaySwitch.configValue)} ]`);
    logEvent(startupEvent,`${switchSensorName(doorswitch)} switch activation time : ${doorSwitch.pressTimeInMs} ms`);
    logEvent(startupEvent,`${switchSensorName(doorswitch)} OPEN / CLOSE time: ${doorSwitch.moveTimeInSec} seconds`);
             
    const interruptActiveRequestConditions = () => {return (doorSwitch.interruptActiveRequest.authorized ? `ACCEPTED and current request will be stopped ${doorSwitch.interruptActiveRequest.newRequest ? `and new request EXECUTED` :``} `: `REJECTED`)};
    logEvent(startupEvent,`${switchSensorName(doorswitch)} when a door request is already in progress and new request is received it will be ${interruptActiveRequestConditions()}`);
          
    const configuredSensors = (garageDoorHasSensor(doorSensor2) ? `Primary and Secondary Sensors are` : `Primary Sensor   is`);
    const logCurrentDoorState = () => {
                                  logEvent(startupEvent,`${(!garageDoorHasSensor(doorSensor) ? `No door sensor so assume door`:`${configuredSensors} indicating door`)} `+
                                                        `${doorStateText(doorState.current)}`);}                                                                                  

    if (garageDoorHasSensor(doorSensor)) {   // door sensor configured ...open GPIO for door sensor, log door sensor configuration info
        logEvent(startupEvent,`${configuredSensors} configured: to alert on OPEN, CLOSE ${(garageDoorHasSensor(doorSensor2) ? ', STOPPED' :'')} and obstacle detection events`);

        //startup logging door sensor info
        const logSensorStartupinfo = (sensor,id) => {
                                  logEvent(startupEvent,`${switchSensorName(id)} [ GPIO: ${sensor.GPIO} ] - [ Interrupt on ${sensor.actuator.value ? `Active High` : `Active low`} ]`);
                                  logEvent(startupEvent,`${switchSensorName(id)} can determine door is completely ${sensor.position.toUpperCase()}`);
                                  logEvent(startupEvent,`${switchSensorName(id)} on sensor match door is ${doorStateText(sensor.actuator.doorStateMatch)} `+
                                                        `- on no match door is ${doorStateText(sensor.actuator.doorStateNoMatch)}`);} 
        //activate primary door sensor
        doorSensor.onOff = activateGPIO(doorSensor.GPIO, 
                                        'in', 
                                        none );

        logSensorStartupinfo(doorSensor,doorsensor);

        if (garageDoorHasSensor(doorSensor2)){ 
            //activate secondary door sensor
            doorSensor2.onOff = activateGPIO(doorSensor2.GPIO, 
                                             'in', 
                                             none );

            logSensorStartupinfo(doorSensor2,doorsensor2);}

        //get cuurent door state info
        [doorState.target,doorState.obstruction,doorState.current] = this.setDoorStateInfo(doorSensor); 
        logCurrentDoorState();
     
        if (doorState.target != _currentDoorState .CLOSED)
            this.collectDoorStats(doorState.current,doorState.obstruction);

        this.activateDoorStateInterrupt(doorState.current); //set up door sensor(s) interrupt monitoring 
    }else{
        //no door sensor switch only...so assume door is closed
        doorState.target = doorState.current = _currentDoorState .CLOSED;
        logCurrentDoorState();
    }    
  }
                     
  getServices(){
    logEvent(traceEvent);
    // configure garage door accessory for homebridge
    this.garageDoorService = new homeBridge.Service.AccessoryInformation();      
    this.garageDoorService
        .setCharacteristic(homeBridge.Characteristic.Manufacturer, accessoryInfo.developer)
        .setCharacteristic(homeBridge.Characteristic.Model, accessoryInfo.product)
        .setCharacteristic(homeBridge.Characteristic.SerialNumber, accessoryInfo.randomnum);

    this.garageDoorOpener = new homeBridge.Service.GarageDoorOpener(doorLog.name);

    this.currentDoorState = this.garageDoorOpener.getCharacteristic(homeBridge.CurrentDoorState);
    this.currentDoorState
        .onGet(this.getCurrentState.bind(this));
          
    this.targetDoorState = this.garageDoorOpener.getCharacteristic(homeBridge.TargetDoorState);
    this.targetDoorState
        .onSet(this.setTargetDoorState.bind(this))
        .onGet(this.getTargetDoorState.bind(this));
          
    this.obstructionDetected = this.garageDoorOpener.getCharacteristic(homeBridge.ObstructionDetected);
    this.obstructionDetected
        .onGet(this.getObstructionDetected.bind(this));       

    return [this.garageDoorService, this.garageDoorOpener];
  }

  cancelAllEvents(buttonPushed){
    logEvent(traceEvent,`${(buttonPushed ? `- but not the interrupt active request timer`: `all timers and interrupt monitors`)}`);
    if (!buttonPushed) //kill multiple request timer
        doorSwitch.interruptActiveRequest.timerId  = killTimer(doorSwitch.interruptActiveRequest.timerId);
    doorState.timerId  = killTimer( doorState.timerId);
    if (garageDoorHasSensor(doorSensor))
        this.setAllSensorInterrupts(cancelInterrupt);
  }

  processRequestActionTimer(){
    doorSwitch.interruptActiveRequest.suspend = true;
    doorSwitch.interruptActiveRequest.timerId = null;
    logEvent(traceEvent,`active request interrupting suspending = [ ${doorSwitch.interruptActiveRequest.suspend} ]`);
  }

  async getObstructionDetected(){
    logEvent(traceEvent,`[ door obstruction = ${doorState.obstruction} ]`);
    return doorState.obstruction;
  }
    
  async getCurrentState(){
    logEvent(traceEvent,`[ current door state = ${doorStateText(doorState.current)} ]`);
    return doorState.current;
  }

  async getTargetDoorState(){
    logEvent(traceEvent,`[ current target door state = ${doorStateText(doorState.target)} ]`);
    return doorState.target;
  }

  async setTargetDoorState(targetDoorState){
    const setRequestActionTimer = () => { 
                                logEvent(traceEvent,`new interrupt request - ${doorSwitch.interruptActiveRequest.authorized ? `set timer` : 'no timer'}`);
                                return (doorSwitch.interruptActiveRequest.authorized ? 
                                                    scheduleTimerEvent( doorSwitch.interruptActiveRequest.timerId, 
                                                                        this.processRequestActionTimer.bind(this), 
                                                                        doorSwitch.interruptActiveRequest.timeOutInMs ) : null)}
    const newRequestAction = () => {
                                if (!doorSwitch.interruptActiveRequest.count) 
                                    doorSwitch.interruptActiveRequest.timerId = setRequestActionTimer();

                                ++doorSwitch.interruptActiveRequest.count;

                                logEvent(traceEvent,`[ override request = ${doorSwitch.interruptActiveRequest.authorized} ] [ source = ${doorRequestSource()} ] `+
                                                    `[ currrent request = ${doorStateText(doorState.current)}] [ new request = ${doorStateText(targetDoorState)} ]`+
                                                    `[ interrupted active request count = ${doorSwitch.interruptActiveRequest.count}]`+
                                                    `[ interrupt active request suspending = [ ${doorSwitch.interruptActiveRequest.suspend} ]`);

                                if(!doorSwitch.interruptActiveRequest.authorized || doorSwitch.interruptActiveRequest.suspend){ // not configured for multiple requests..so disregard new request
                                    logEvent(alertEvent,`Disregarding new request ${doorStateText(targetDoorState)} - currently processing ${doorStateText(doorState.current)} request`);
                                    return false
                                }else{ // configured for multiple requests...cancel any outstanding timer or sensor interrupt monitoring
                                    logEvent(alertEvent,`Stopping current ${doorStateText(doorState.current)} ${ doorSwitch.interruptActiveRequest.newRequest ? `- starting new ${doorStateText(targetDoorState)} request` : ``}`);
                                    return true; } } 
  
    logEvent(traceEvent, `[ current door state = ${doorStateText(doorState.current)} ] [ target door state = ${doorStateText(targetDoorState)} ] `+
                         `[ homeKitRequest - ${doorState.homeKitRequest} ]`);

    if (doorState.homeKitRequest) {                          
        doorState.operationInterrupted = newRequestAction();// check if the new request should be rejected or processed
        if (!doorState.operationInterrupted ) return; } 
    
    // disregarding a request for interrupting or receiveing multiple requests to interrupt may cause 
    // the expected door state to no longer be in sync with the actual door state thus causing a
    // request for the door to be open or closed when it is already in that state...so just return                     
    if (!doorState.homeKitRequest && (doorState.current == targetDoorState)) {
        logEvent(alertEvent,`new request ${doorStateText(targetDoorState)} - door already is ${doorStateText(doorState.current)} - no door move required`);
        return;}
                              
    doorState.homeKitRequest = true;    
    doorState.target         = targetDoorState; // Set expected current door state
    const _currentDoorState  = homeBridge.CurrentDoorState;
    doorState.current        = (doorState.target == _currentDoorState.OPEN) ? _currentDoorState.OPENING : _currentDoorState.CLOSING;
    this.garageSwitch((doorState.operationInterrupted ? stopop : startop )); 
    this.updateCurrentDoorState(doorState.current);
    return;
  }

  updateCurrentDoorState(currentDoor,obstruction){
    logEvent(infoEvent,`Door is ${doorStateText(currentDoor)} ${(obstruction ? `and obstructed ` : ``)}from ${doorRequestSource()}`);
    this.currentDoorState.updateValue(currentDoor);
    if (obstruction != null)
        this.obstructionDetected.updateValue(obstruction);
  }

  garageSwitch(operation){
    logEvent(traceEvent, `${operation.toUpperCase()} [ GPIO = ${doorSwitch.GPIO} ]`);         
    const button = (op,nextAction,timeOut,timerId) => {
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
        this.cancelAllEvents(true);// stop listening for door sensor interrupts since an interrupt will occur when the button is pushed
        doorState.timerId = button(operation,
                                  this.garageSwitch.bind(this,executeop),
                                  doorSwitch.pressTimeInMs,
                                  doorState.timerId);
      break;
      case executeop:
        doorState.timerId = button(operation,
                                  this.processDoorTimer.bind(this),
                                  doorState.moveTimeInMs,
                                  doorState.timerId);
                                  
        if (garageDoorHasSensor(doorSensor))
            this.activateDoorStateInterrupt( doorState.current);//use both sensor and timer to determine when door move has completed                             
      break;
      case stopop: //this will stop the garagdoor motor
        this.cancelAllEvents(true);// stop listening for door sensor interrupts since an interrupt will occur when the button is pushed
        doorState.timerId = button(operation,
                                   this.garageSwitch.bind(this,reverseop),
                                   doorSwitch.pressTimeInMs,
                                   doorState.timerId);
      break;
      case reverseop:
        doorState.timerId = button(operation,
                                  ( doorSwitch.interruptActiveRequest.newRequest ? 
                                    this.garageSwitch.bind(this,startop) :  //execute the new open/close request                                
                                    this.processDoorTimer.bind(this) ),     //stop the current open/close request
                                  doorSwitch.pressTimeInMs,
                                  doorState.timerId);
      break;
      default: 
        const errMsg = `invalid operation [${operation}]`;
        stopAccessory(fatalError.Internal_Error,errMsg);
      break;
    }       
  }

  processDoorTimer(){
    logEvent(traceEvent, `[ GPIO = ${doorSensor.GPIO} ]`);
    let currentDoorOpenClosed,doorObstruction,currentDoorState;
    this.cancelAllEvents(false);
    if (garageDoorHasSensor(doorSensor)){
        [currentDoorOpenClosed,doorObstruction,currentDoorState] = this.setDoorStateInfo(doorSensor);
    }else{
        doorObstruction  = false;
        currentDoorOpenClosed = currentDoorState = doorState.target;
    }
    this.updateTargetDoorState(currentDoorOpenClosed,doorObstruction,currentDoorState);
  }

  updateTargetDoorState(currentDoorOpenClosed,doorObstruction,currentDoorState){
    logEvent(traceEvent, `[ source = ${doorRequestSource()} ] [ request = ${doorStateText(doorState.target)} ] [ sensor state = ${doorStateText(currentDoorState)} ] `+ 
                         `[ door state = ${doorStateText(currentDoorOpenClosed)} ][ door operation interrupted = ${doorState.operationInterrupted}]`);
    
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
    doorState.current     = currentDoorState;
    doorState.target      = currentDoorOpenClosed;
    doorState.obstruction = doorObstruction; 
    this.targetDoorState.updateValue(doorState.target);
    this.updateCurrentDoorState(doorState.current,doorState.obstruction);
    
    if (garageDoorHasSensor(doorSensor)){
        this.collectDoorStats(doorState.target,doorState.obstruction); // collect door stats information
        this.activateDoorStateInterrupt(doorState.current); //rearm door sensor interrupts
    }
    doorState.homeKitRequest = false;
    //physical door swich may be in an unkown state if requests were issued from both iphone and traditional garagedoor switch..so always reset it
    resetSwitchDirection();
    resetSwitchActiveLow();
    doorSwitch.relaySwitch.writeValue = doorSwitch.relaySwitch.configValue;                             
    doorState.operationInterrupted = false; 
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
                                    // Log event   
                                    logEvent(statsEvent,doorStatMsg);
                                }
                                // reset door event stats
                                doorStats.open.requestSource = doorStats.close.requestSource = '';
                                doorStats.open.time = doorStats.close.time = null;
                              break;
                              case obstructed:
                                doorStatMsg = `Door Obstructed for ${totalSecs(doorStats.obstruction.endTime, doorStats.obstruction.startTime)} seconds`;
                                // Log event  
                                logEvent(statsEvent,doorStatMsg);
                                // reset door stats
                                doorStats.obstruction.startTime = doorStats.obstruction.endTime = null;
                              break;
                              case interruptedrequests:
                                const interruptActiveRequestConditions = () => {return (doorSwitch.interruptActiveRequest.authorized ? `stop current ${doorSwitch.interruptActiveRequest.newRequest ? `request and execute new` :``} `: `reject new`)};
                                doorStatMsg = `Door service received ${doorSwitch.interruptActiveRequest.count} - action set to ${interruptActiveRequestConditions()}request`;
                                // Log event  
                                logEvent(statsEvent,doorStatMsg);
                                // reset door switch interrupt active request count and suspend flag
                                doorSwitch.interruptActiveRequest.count = 0;
                                doorSwitch.interruptActiveRequest.suspend = false;
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
            logDoorStats(openClose); } //log total door open time
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
        logDoorStats(obstructed); }//log total door obstruction time
    
     if (doorSwitch.interruptActiveRequest.count)
         logDoorStats(interruptedrequests);  //log totalnew requests received while procesing last door request
  }
 
  getGarageDoorSensor(sensor,sensorValue){
    const readSensor = () => {try { return sensor.onOff.readSync();
                                  } catch(error){
                                          const errMsg = `Attempt to read door sensor failed - [GPIO = ${sensor.GPIO} - Read Error = ${error}]`;
                                          stopAccessory(fatalError.Door_Sensor_Read_Error,errMsg);};} 

    const doorGPIOvalue = (sensorValue == null ? readSensor() : sensorValue);   
    // translate door sensor value to OPEN or CLOSED door state
    const currentDoorState = (doorGPIOvalue == sensor.actuator.value) ? sensor.actuator.doorStateMatch: sensor.actuator.doorStateNoMatch;
    logEvent(traceEvent, `[ GPIO = ${sensor.GPIO} ] [ actuator value = ${doorGPIOvalue} ] `+
                         `[ door state = ${doorStateText(currentDoorState)} ]`);
    return currentDoorState;
  }

  activateDoorStateInterrupt(doorstate) {
    const _currentDoorState  = homeBridge.CurrentDoorState;
    logEvent(traceEvent,`[ current door state = ${doorStateText(doorstate)} [ last door state = ${doorStateText(doorState.last)} ]]`);
    
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
                                  return (sensor.actuator.value ? rising : falling);} //reverse interrupt edge setting when sesnor does not matches current doorstate                          

    const activatePrimarySensor = (sensor) => {
                              setInterruptSignal(sensor,setPrimaryEdgeSignal(sensor));
                              this.setGarageDoorInterrupt(sensor,activateInterrupt);}

    const setDualSensorEdgeSignal = (sensor) => {
                              if (doorState.last == _currentDoorState.STOPPED){ 
                                      return both
                              } else  return setPrimaryEdgeSignal(sensor)}                          
    
    const activateBothSensors = (sensor1,sensor2) => {                        
                              setInterruptSignal(sensor1,setDualSensorEdgeSignal(sensor1));
                              this.setGarageDoorInterrupt(sensor1,activateInterrupt);
                              if (doorState.last == _currentDoorState.STOPPED || doorstate == _currentDoorState.STOPPED){
                                  setInterruptSignal(sensor2,setDualSensorEdgeSignal(sensor2));
                                  this.setGarageDoorInterrupt(sensor2,activateInterrupt);}}
                                  
    const twoSensors = garageDoorHasSensor(doorSensor2);
                            
    switch(doorstate) {
      case _currentDoorState.OPEN:  
      case _currentDoorState.OPENING:
        if (!twoSensors && (doorSensor.position == openDoor || doorstate ==  _currentDoorState.OPEN)){
            activatePrimarySensor(doorSensor);  
            return;}

        if(twoSensors){
            activateBothSensors(doorSensor2,doorSensor);
            return}    

      break;
      case _currentDoorState.CLOSED:
      case _currentDoorState.CLOSING:
        if (!twoSensors && (doorSensor.position == closedDoor || doorstate ==  _currentDoorState.CLOSED)){
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
        const errMsg = `invalid door state [${doorStateText(doorstate)} expecting OPENING or CLOSING]`;
        stopAccessory(fatalError.Internal_Error,errMsg);
      break; 
      }
    logEvent(traceEvent,`[ no interrupt activation ]`);
  }

  setAllSensorInterrupts(interruptAction){
    this.setGarageDoorInterrupt(doorSensor,interruptAction);// activate or cancel listening for door sensor interrupts
    if (garageDoorHasSensor(doorSensor2))
        this.setGarageDoorInterrupt(doorSensor2,interruptAction);// activate or cancel listening for door sensor2 interrupts
  }

  setGarageDoorInterrupt(sensor,interruptAction){
    logEvent(traceEvent,`[ request ${interruptAction} GPIO = ${sensor.GPIO} ] `+
                        `[ queued interrupts = ${sensor.interrupt.count} ]`);

    if (interruptAction == activateInterrupt  && !sensor.interrupt.count){
        try {
          sensor.onOff.watch(sensor.interrupt.handler); //wait for door sensor value to change
        } catch (error) {
          const errMsg = `Attempt to monitor interrupt (watch)) failed [ GPIO = ${sensor.GPIO} Error = ${error} ]`;
          stopAccessory(fatalError.Door_Sensor_OnOff_Error,errMsg);
        }
        ++sensor.interrupt.count; //increment watch count
    }else if (interruptAction == cancelInterrupt && sensor.interrupt.count > 0) {
        try {
          sensor.onOff.unwatchAll(); //unwatch all to ensure no interrupts
        } catch (error) {
          const errMsg = `Attempt to cancel all interrupt monitoring (unwatch)) failed [ GPIO = ${sensor.GPIO} Error = ${error} ]`;
          stopAccessory(fatalError.Door_Sensor_OnOff_Error,errMsg);
        }
         --sensor.interrupt.count; //decrement watch count
    }
    logEvent(traceEvent,`[ result ${interruptAction} GPIO = ${sensor.GPIO} ] `+
                        `[ queued listener(s) = ${sensor.interrupt.count} ]`);
  }

  setDoorStateInfo(sensor,sensorValue){
    const _currentDoorState = homeBridge.CurrentDoorState;
    logEvent(traceEvent,`[ GPIO = ${sensor.GPIO} - sensor = ${sensorValue == null ? 0 : sensorValue} ]`);
    const garageDoorState =() => {
                                const primaryDoorState  = this.getGarageDoorSensor(doorSensor);

                                logEvent(traceEvent,`primary door sensor [ GPIO = ${doorSensor.GPIO} ] [ door state = ${doorStateText(primaryDoorState)} ]`);
  
                                if (!garageDoorHasSensor(doorSensor2)  || (primaryDoorState == doorSensor.actuator.doorStateMatch)) 
                                    return [primaryDoorState,primaryDoorState];
  
                                //2 sensors...primary indicated the door is open...check if secondary sensor agrees
                                const secondaryDoorState = this.getGarageDoorSensor(doorSensor2);
  
                                logEvent(traceEvent,`secondary door sensor [ GPIO = ${doorSensor2.GPIO} ] [ door state = ${doorStateText(secondaryDoorState)} ]`);
  
                                if (secondaryDoorState == doorSensor2.actuator.doorStateMatch){
                                      return [secondaryDoorState,secondaryDoorState];
                                }else return [_currentDoorState.STOPPED,_currentDoorState.OPEN];}
    
    const [currentDoorState,currentDoorOpenClosed] = garageDoorState();
    
    const doorObstruction = (!doorState.operationInterrupted && 
                                ((currentDoorState == _currentDoorState.STOPPED )|| 
                                 (doorRequestSource() == homekit && currentDoorState != doorState.target && doorState.last != _currentDoorState.STOPPED)));
    doorState.last = currentDoorState;  //save last door state for helping to assist in determiing interrupt arming and obstacle detection for next operation
    
    logEvent(traceEvent,`[ GPIO = ${sensor.GPIO} ] [ door sensor = ${doorStateText(currentDoorOpenClosed)} ] `+
                        `[ door obstruction = ${doorObstruction} ] [ door state = ${doorStateText(currentDoorState)} ]`);
    // garage door is open or closed
    return [currentDoorOpenClosed,doorObstruction,currentDoorState];
  }

  processDoorInterrupt(sensor,sensorValue){
    // clear any pending homekit timeout and then update the door state
    logEvent(traceEvent,`[ GPIO = ${sensor.GPIO} ] [ source = ${doorRequestSource()} ]`);
    this.cancelAllEvents(false);
    const [currentDoorOpenClosed,doorObstruction,currentDoorState] = this.setDoorStateInfo(sensor,sensorValue);
    this.updateTargetDoorState(currentDoorOpenClosed,doorObstruction,currentDoorState); 
  }

  doorMoveEvent(sensor,sensorValue,err){
    const _currentDoorState = homeBridge.CurrentDoorState;
    const monitorDoorMove = (sensor,currentDoorOpeningClosing) => {
                            logEvent(traceEvent,`[ door state = ${doorStateText(currentDoorOpeningClosing)} ]`);
                            this.updateCurrentDoorState(currentDoorOpeningClosing);
                            const completeDoorOpenClosed =this.processDoorInterrupt.bind(this,sensor)
                            doorState.timerId = scheduleTimerEvent(doorState.timerId,completeDoorOpenClosed,doorState.moveTimeInMs);}

    const currentDoorState = this.getGarageDoorSensor(sensor,sensorValue);
    const requestSource = doorRequestSource();
    logEvent(traceEvent, `[ source = ${requestSource} ][ GPIO = ${sensor.GPIO} ] [ door state = ${doorStateText(currentDoorState)} ]`+
                         `[ sensor = ${sensorValue} ] [ err = ${err} ] [ sensor door position = ${sensor.position}]`);
    if (requestSource == garageOpenner && garageDoorHasSensor(doorSensor2)) {
        switch (sensor.position){
          case  openDoor: //secondary sensor...check primary sensor to confirm door is closing

            if (currentDoorState == _currentDoorState.CLOSED && this.getGarageDoorSensor(doorSensor) == _currentDoorState.OPEN){
                this.activateDoorStateInterrupt(_currentDoorState.CLOSING);  
                monitorDoorMove(sensor,_currentDoorState.CLOSING);
                return;}

          break;
          case  closedDoor: //primary sensor...check secondary sensor to confirm door is opening

            if (currentDoorState == _currentDoorState.OPEN && this.getGarageDoorSensor(doorSensor2) == _currentDoorState.CLOSED){
                this.activateDoorStateInterrupt(_currentDoorState.OPENING);  
                monitorDoorMove(sensor,_currentDoorState.OPENING);
                return;}

          break;
          default:
            const errMsg = `invalid sensor position [${sensor.position}]`;
            stopAccessory(fatalError.Internal_Error,errMsg);
          break;  
          }
    }       
    this.processDoorInterrupt(sensor,sensorValue,err); //door is either OPEN, CLOSED or STOPPED
  }

  resetGarageDoorInterrupt(sensor){
    logEvent(traceEvent,`[ last door state = ${doorStateText(doorState.last)} ]`);
    const _currentDoorState  = homeBridge.CurrentDoorState;
    if (doorState.last == _currentDoorState.STOPPED){
        this.setAllSensorInterrupts(cancelInterrupt)
    }else
        this.setGarageDoorInterrupt(sensor,cancelInterrupt);
  }

  processPrimarySensorInterrupt(err,doorSensorValue){ 
    logEvent(traceEvent,`[ GPIO = ${doorSensor.GPIO} ] [ actuator = ${doorSensor.actuator.value} ] [ sensor value = ${doorSensorValue} ]`);
    this.resetGarageDoorInterrupt(doorSensor);
    this.doorMoveEvent(doorSensor,doorSensorValue,err)
  }

  processSecondarySensorInterrupt(err,doorSensorValue){ 
    logEvent(traceEvent,`[ GPIO = ${doorSensor2.GPIO} ] [ actuator = ${doorSensor2.actuator.value} ] [ sensor value = ${doorSensorValue} ]`);
    this.resetGarageDoorInterrupt(doorSensor2);
    this.doorMoveEvent(doorSensor2,doorSensorValue,err);            
  }
}