/**
 * @summary Data query and timer companion for the heater controller script
 * @author Mika Aronen, https://github.com/Mika9000
 *
 * Schedule code from: https://github.com/ALLTERCO/shelly-script-examples/blob/main/register-scheduled-script.js
 * 
 **/

let CONFIG = {
  endpointlist: [
    //{keyname: 'solar', url: 'https://vision.gef.fi/api/v1/plant/yourapikeyhere/' }, //GEF Vision
    {keyname: 'netproduction', url: 'http://192.168.2.104/meter/' },  //Nanogrid AIR
    {keyname: 'heater', url: 'http://192.168.2.11/emeter/0' }, //Shelly EM
    {keyname: 'cheap', url: 'http://api.spot-hinta.fi/JustNowRank/3'}
  ],
  
  kvsControlKey: 'readsetcompleted',
  controlScriptUrl: 'http://192.168.2.20/script/2/controlcommand',  //Control scipt's url, script id and endpoint name
  
  dayBegins: '08:00',           //Control wakes up expecting full solar power
  partialPowerBegins: '12:00',  //Partial power level is in use
  priceControlBegins: '17:00',  //Cheap energy hours are monitored
  forcedHeatingBegins: '05:00', //Heating is forced on regardless of energy price
  
  heaterPhaseMultiplier: 3,     //Heater uses 3 phases, only 1 is measured
  invalidReading: 9999,         //Greater than any value ever could be
  
  schedule: {
    kvsKey: "Reader-Schedule-" + JSON.stringify(Shelly.getCurrentScriptId()),
    timespec: "0 */5 * * * *",  //Run at 5 minute intervals
    id: -1 
  }
};

const VERSION = {
  number: '1.0',
  date: '250527',
};

const CMD_AUTO =0;
const CMD_OFF = 1;

let minutebase = {};
var valuelist = {};
var endpointcount = 0;
var completedcount=0;
var priceperiod=0;
var started=0;
var stopped=0;

function registerIfNotRegistered() {
  console.log("Reader start: Schedule check");
  Shelly.call(
    "KVS.Get",
    { key: CONFIG.schedule.kvsKey },
    function (result, error_code, error_message) {
      //we are not registered yet
      if (error_code !== 0) {
        installSchedule();
        return;
      }
      CONFIG.schedule.id = result.value;
      //check if the schedule was deleted and reinstall
      Shelly.call("Schedule.List", {}, function (result) {
        let i = 0;
        for (i = 0; i < result.jobs.length; i++) {
          if (result.jobs[i].id === CONFIG.schedule.id) return;
        }
        installSchedule();
      });
    }
  );
}

function SetKvsValue(key,value) {
  Shelly.call("KVS.Set", {
    key: key,
    value: value,
  });
}

function installSchedule() {
  console.log("Reader start: Installing schedule");

  Shelly.call(
    "Schedule.Create",
    {
      enable: true,
      timespec: CONFIG.schedule.timespec,
      calls: [
        {
          method: "script.eval",
          params: {
            id: Shelly.getCurrentScriptId(),
            code: "ReadStart()",  //Function that this schedule calls
          },
        },
      ],
    },
    function (result) {
      //save record that we are registered
      SetKvsValue(CONFIG.schedule.kvsKey, result.id);
    }
  );
}


//Call heater control script and send readings
function CallControl() {
  let urlprms='readersends=1';
    
  const keys = Object.keys(valuelist);
  keys.forEach( function(key) {
    if (valuelist[key]) { //Pass only parameters having a value
      urlprms += "&" + key + "=" + valuelist[key];
    }
  });

  console.log( 'Reader: Call Control with ' + urlprms);

  Shelly.call(
    "http.get",
    { url: CONFIG.controlScriptUrl + '?' + urlprms },
    function (response, error_code, error_message) {
      if (error_code !== 0) {
        console.log('Reader: Control response ' + JSON.stringify(error_code) + ' ' + error_message);
      } else {
        console.log('Reader: OK from Control');
      }
    }
  );
}


//Handle time and timed events
function Clock() {
  minutebase.systime = MinuteTime( Shelly.getComponentStatus("sys").time );

  let scripttime = minutebase.systime - minutebase.daybegins;  //Current time in script's own time zone
  if (scripttime < 0) scripttime += (24*60);

  valuelist.low = (scripttime >= minutebase.lowstart) ? 1 : 0;
  valuelist.force = (scripttime >= minutebase.forcestart) ? 1 : 0;
  priceperiod = (scripttime >= minutebase.pricestart) ? 1 : 0;

  if (!started && minutebase.systime >= minutebase.daybegins) {
    //New day
    valuelist.starting = 1; //Tell control to start a new day
    valuelist.cheap=0;
    started = 1;
    console.log('Reader: Start new day!');
    return;
  
  } else if (started && minutebase.systime < minutebase.daybegins) { 
    //Midnight
    started = 0;
  }
  
  valuelist.starting = 0;
}

//Convert time string to minutes
function MinuteTime(timestr) {
  let hrs = JSON.parse(timestr.slice(0,2));
  let mins = JSON.parse(timestr.slice(3));
  return hrs * 60 + mins;
}

//Combined callback function for all api calls
function QueryResponse(res, error_code, error_msg, keyname) {
  let result = valuelist[keyname]; //Use previous value in case call was skipped
        
  if (error_code !== 0) {
    console.log("Reader: Invalid response from " + keyname + ": " + JSON.stringify(error_code) + " " + error_msg);
    
  } else {
    if (res.code) console.log("Reader: OK from " + keyname);
    if (res.code === 200) {  
      let st = JSON.parse(res.body);
      
      if (keyname=="heater") {
        //Water heater power consumption. Value expected: Watts, positive sign
        result = parseInt(st.power * CONFIG.heaterPhaseMultiplier); //Shelly EM, with a multiplier to form a correct reading
        if (result<0) result = 0;
        
      } else if (keyname=="solar") {
        //Solar power reading. Value expected: Watts, positive sign
        result = parseInt(st.power.production);  //GEF Vision solar panel API
            
      } else if (keyname=="netproduction") {
        //Net power reading, like from HAN port. Value expected: Watts, positive sign when production exceeds household's consumption.
        result = parseInt((st.activePowerOut-st.activePowerIn)*1000); //CTek, calculate net production and convert kW to W
        
      } else if (keyname=="cheap") {
        //Is electricity cheap. Value expected: Response code 200 (OK) if cheap
        result = 1;
      }
    } else {
      //Is electricity not cheap. Value expected: Response code 400 (Bad request) if not cheap
      if (keyname=="cheap" && res.code === 400) result = 0;
    }
  }

  valuelist[keyname] = result;

  if (++completedcount == endpointcount) CallControl(); //All queries handled, call control
}


//Prevent bombing / block unnecessary calls to endpoints
function IsPermitted(keyname) {
  let permit=true; //By default call is permitted

  if (keyname=="cheap") {
    //SPOT prices are updated every 15 mins, no use to get price status more often
    if (!priceperiod || (minutebase.systime % 15)) permit=false;

  } else if (keyname=="solar") {
    //Lengthen solar panel query interval if previous reading was not even close to the required level 
    let power = valuelist[keyname];
    
    //If price monitoring period is active, double the interval because it's evening and panel output isn't going to rise
    let factor = (priceperiod) ? 2 : 1;
  
    if ((power<100 && (minutebase.systime % (30*factor))) || 
        (power<1000 && power>99 && (minutebase.systime % (15*factor))))
      permit=false;
      
  }

  if (!permit) console.log("Reader: " + keyname + " query skipped");

  return permit;
}

//Actual operating logic
function ReaderBrains (result, error_code, error_msg, ud) {  
  Clock();
  
  if (result) {
    let controlval = parseInt(result.value); //Command value from kvs bank
    if (valuelist.starting) controlval = CMD_AUTO; //Ignore value (substitute with auto) if new day is starting
          
    if (controlval === CMD_OFF) {
      if (stopped) {
        //Heating is complete or has been manually stopped: no need to fetch readings or call control
        console.log('Reader: Sleeping...');
      
      } else {
        //Heating was just stopped. In case it was done manually, call control once more to make sure it also notices the command value
        stopped=1;
        console.log('Reader: Found KVS command Stop: Finishing heating...');
        CallControl();
      }
      return;
    
    } else {
      stopped=0;
    }
  } else {
    //Control key doesn't exist, create it to allow proper operation
    SetKvsValue(CONFIG.kvsControlKey, CMD_AUTO);
    console.log('Reader: Created missing KVS key');
  }

  //Query values from endpoints, after last one is handled pass them to the control script
  console.log("Reader: Running queries");
  
  completedcount=0; //Reset query counter

  CONFIG.endpointlist.forEach( function(endpoint) {
    if (IsPermitted(endpoint.keyname)) {
      Shelly.call("HTTP.GET", { url: endpoint.url, timeout:60, ssl_ca:"*" }, QueryResponse, endpoint.keyname);
    } else {
      QueryResponse({}, 0, '', endpoint.keyname); //Call is skipped, call response function directly with empty values
    }
  });
}

// --- The function called by schedule ---
function ReadStart() {
  Shelly.call(
    "KVS.Get",
    { key: CONFIG.kvsControlKey },
    ReaderBrains
  );
}

console.log('Reader v' + VERSION.number + ' ' + VERSION.date);

//Convert clock times to more manageable minutes, use new day start time as time zone
minutebase.daybegins = MinuteTime(CONFIG.dayBegins);

minutebase.lowstart = MinuteTime(CONFIG.partialPowerBegins) - minutebase.daybegins;
if (minutebase.lowstart < 0) minutebase.lowstart += (24*60);

minutebase.forcestart = MinuteTime(CONFIG.forcedHeatingBegins) - minutebase.daybegins;
if (minutebase.forcestart < 0) minutebase.forcestart += (24*60);

minutebase.pricestart = MinuteTime(CONFIG.priceControlBegins) - minutebase.daybegins;
if (minutebase.pricestart < 0) minutebase.pricestart += (24*60);

//Count endpoints and set their previous value to not null
CONFIG.endpointlist.forEach( function(endpoint) {
  valuelist[endpoint.keyname] = 0;
  endpointcount++;
});

registerIfNotRegistered(); //Set up schedule
