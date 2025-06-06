/*
 * @summary Shelly script for controlling electric water heater in a solar powered household
 * @author Mika Aronen, https://github.com/Mika9000
 *
 * See the readme.md
 *
 */

let CONFIG = {
  heatingTime: 180,   //Max. heating time (minutes)
  powerFull: 3500,    //Power output matching heater's nominal power consumption
  powerPartial: 100,  //Lowered power setting
  
  //baseConsumption: 500,  //Use when power reading is not a net yield but just the solar power generated
  poweroffLevel: 1,       //Heater power consumption detection limit
  invalidReading: 9999,   //Greater than any reading ever could be
    
  homeEndpoint: '', //http://192.168.2.14/cgi-bin/mittari_logger.cgi, //Leave empty '' if not in use
  kvsControlKey: 'readsetcompleted'
};

const VERSION = {
  number: '1.0',
  date: '250527',
};

const CMD_AUTO = 0;
const CMD_OFF = 1;
const CMD_ON = 2;

let heater = {
  switchstate: false,
  cmdStop: false,
  cmdHeat: false,
  onTime: 0
};

let readings = {};

let minutebase = {
  time: 0,
  prevtime: 0,
};


//Get switch state
function GetSwitch() {
  let oSwitch = Shelly.getComponentStatus("switch", 0);
  return oSwitch.output;
}


//Set switch
function SetSwitch(state) {
  Shelly.call("switch.set", {
    id: 0,
    on: state
  });
  
  heater.switchstate = state;
}


//Save value into KVS bank
function SetKvsValue(kvskey,value) {
  Shelly.call("KVS.Set", {
    key: kvskey,
    value: value
  });
  console.log('Control: Set KVS ' + kvskey + '=' + JSON.stringify(value) );
}


//Convert time string to minutes
function MinuteTime(timestr) {
  let hours = JSON.parse(timestr.slice(0,2));
  let minutes = JSON.parse(timestr.slice(3));
  return hours * 60 + minutes;
}


//Send report
function SendMessage(message) {
  console.log('Control: ' + message);
  
  if (!CONFIG.homeEndpoint) return;
  if (readings.heaterConsumption === CONFIG.invalidReading) readings.heaterConsumption = 0;

  let postData = {
    url: CONFIG.homeEndpoint,
    body: {
      whoami: 'Control ' + VERSION.number + ' ' + VERSION.date,
      unixtime: Shelly.getComponentStatus("sys").unixtime,
      message: message,
      heater: heater,
      readings: readings,
      remaining: (CONFIG.heatingTime - heater.onTime)
    }
  };

  Shelly.call(
    "HTTP.POST",
    postData,
    function (response, error_code, error_message) {
      if (error_code !== 0) {
        console.log('Control: SendMessage: ' + JSON.stringify(error_code) + ' ' + error_message);
      } else if (response.code !== 200) {
        console.log('Control: SendMessage: ' + CONFIG.homeEndpoint + ', HTTP response ' + JSON.stringify(response.code) );
      }
    }
  );
}


//Handle time and start of a new day
function Clock() {
  let systime = Shelly.getComponentStatus("sys").time;
  minutebase.prevtime = minutebase.time; //last run
  minutebase.time = MinuteTime(systime); //current time
    
  if (readings.dayStarting) {
    //New day: Reset everything
    heater.onTime = 0;
    SetKvsValue(CONFIG.kvsControlKey, CMD_AUTO);
    SetSwitch(false);  //Make sure heating is stopped
    return true;
  }
  
  return false;
}


//How do we heat?
function HeaterBrains() {
  let msg;
  let availablePower = readings.netProduction + readings.heaterConsumption; //Heater may already be running, add power it consumes back to the available power
  let requiredPower = (readings.loweredstate) ? CONFIG.powerPartial : CONFIG.powerFull;
    
  if (availablePower > requiredPower && !heater.cmdStop) {
    //Uuh, baby
    SetSwitch(true);
    msg = 'Heating (' + JSON.stringify(requiredPower) + '+' + JSON.stringify(availablePower-requiredPower) + 'W)';

  } else {
    //Check conditions for secondary heating
    let yay = (readings.isCheap || readings.forcedstate || heater.cmdHeat) ? true : false; //Things allowing
    let nay = (heater.cmdStop) ? true : false; //Things preventing
    
    SetSwitch(yay && !nay);
    
    //Brain-work done, rest just prepares a report how the heating is going...
    if (readings.dayStarting) msg = 'Morning! Starting up... ';
    if (!msg && heater.cmdStop) msg = 'Heating paused.';
    if (!msg) msg = (yay && !nay) ? 'Heating' : 'Not heating (' + JSON.stringify(availablePower-requiredPower) + 'W below limit)';
    
    if (yay && !nay) {
      if (readings.forcedstate) msg += ', time based';
      if (readings.isCheap) msg += ', price based';
      if (heater.cmdHeat) msg += ', manual mode';
    }    
  }
  
  SendMessage(msg);
}


//Decipher kvs command value
function SetCommandState(commandval) {
  if (commandval === CMD_OFF) {
    //Stop heating
    if (!heater.cmdStop) {
      heater.cmdStop = true;
      heater.cmdHeat = false;
      console.log('Control: Use KVS command Stop');
    }

  } else if (commandval === CMD_ON) {
    //Turn heating on
    if (!heater.cmdHeat) {
      heater.cmdStop = false;
      heater.cmdHeat = true;
      console.log('Control: Use KVS command Run');
    }
    
  } else if (heater.cmdStop || heater.cmdHeat) {
    //Switch to default (auto) mode
    heater.cmdStop = false;
    heater.cmdHeat = false;
    console.log('Control: Use KVS command Resume auto');
  }
}


//To heat or not to heat, that is the question
function Heater (result, error_code, error_msg) {
  let msg;
  let newday = Clock(); //Current time, and status has a new day started
  
  if (result) { //KVS call response
    let commandval = parseInt(result.value);
    if (newday) commandval = CMD_AUTO;
    SetCommandState(commandval);
  }
    
  heater.switchstate = GetSwitch(); //Get the real physical state of the switch
  
  if (heater.switchstate) { //Update elapsed heating time
    let timehelper = minutebase.time - minutebase.prevtime;
    if (timehelper<0) timehelper += (24*60);
    heater.onTime += timehelper; 
  }
  
  //Is heating complete (time is up or thermostat has opened)?
  if (heater.onTime >= CONFIG.heatingTime || (heater.switchstate && !readings.heaterConsumption) ) {
    if (heater.switchstate) {
      //Was completed just now, finish heating
      console.log('Control: Heating completed');
      msg = 'Heating complete!';
      if (!readings.heaterConsumption) msg += ' Thermostat has opened. Time remaining ' + JSON.stringify(CONFIG.heatingTime - heater.onTime) + ' minutes.';

      SetSwitch(false);
      heater.onTime = CONFIG.heatingTime;
      SetCommandState(CMD_OFF);
      SetKvsValue(CONFIG.kvsControlKey, CMD_OFF);
      
    } else {
      //Heartbeat
      msg = 'Heating complete...';
    }
    SendMessage(msg);
    
  } else {
    //Heating in progress...
    HeaterBrains();
  }
}


//Start by asking KVS control key value
function GetCommandStatus() {
  Shelly.call(
    "KVS.Get",
    { key: CONFIG.kvsControlKey },
    Heater
  );
}


// Parse query parameters
function GetQueryParams(querystr) {
  let result = {};
  let params = querystr.split('&');
              
  params.forEach(function(param) {
    let val = param.split('=');
    result[val[0]] = parseInt(val[1]);  //Incoming values are integers
  });
  
  return result;
}

// --- This handles the 'controlcommand' endpoint call ---
function Control(request,response) {
  response.body = 'Ok';
  response.code = 200;
  response.send();
  
  if (request && request.query) {
    let valuelist = GetQueryParams(request.query);
  
    //Readings the reader has read
    console.log('Control: Received reader command');
    readings.heaterConsumption = (valuelist.heater && valuelist.heater>=CONFIG.poweroffLevel) ? valuelist.heater : 0;
    readings.isCheap = (valuelist.cheap) ? valuelist.cheap : 0;
    readings.dayStarting = (valuelist.starting) ? valuelist.starting : 0;
    readings.loweredstate = (valuelist.low) ? valuelist.low : 0;
    readings.forcedstate = (valuelist.force) ? valuelist.force : 0;

    //Available power
    if (valuelist.netproduction) {
      readings.netProduction = valuelist.netproduction;
    } else if (valuelist.solar) {
      readings.netProduction = valuelist.solar - readings.heaterConsumption - CONFIG.baseConsumption; //Subtract heater and base consumption to make a net reading
    } else {
      readings.netProduction = CONFIG.invalidReading;
    }
         
    //Start the control cycle
    GetCommandStatus();
     
  }
}

//"Main"
SendMessage('Heater control v' + VERSION.number + ' ' + VERSION.date);

// Register Control endpoint
HTTPServer.registerEndpoint('controlcommand', Control);
console.log("Control start: Http endpoint 'controlcommand' registered");
