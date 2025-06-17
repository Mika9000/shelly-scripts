# Shelly Plug Energy Meter

Synopsis: A script to use Shelly Plug as an energy meter. The color of the light indicates how much solar energy is available.

Inspired by [Shelly Plug S Spot Price Illuminator](https://github.com/shellykauppa/plug-s-spot-illuminator)

This script takes a reading from an energy meter and sets the color of the plug to show the amount of energy available. When there is a huge amount of unused power, the light pulses green. When the amount decreases due to increased load or decreasing panel output, it first turns solid green, then yellowish green when the amount is only hundreds of watts, and finally orange when the yield is approaching zero. If the power reading used is a net power, the meter can also show the amount of energy consumed from the grid. It then turns orange-red when more is consumed than produced, red when consumption has increased more, and finally pulsing red when consumption is really high.

# Hardware and API requirements

The following is needed:

- Shelly plug, any version shoud work that supports scripting (developed &amp; tested with Plug S G3) 
- API for fetching the amount of available power. It can be the solar panel system&apos;s API, a Shelly energy meter, a HAN port reader, etc.

API must be queryable with a simple HTTP GET method.

# Script configuration

The **CONFIG** element at the beginning of the script contains settings that are configurable by the user.

Example values are taken from my own setup which has a HAN port reader on the electricity meter and a 6kW solar panel setup producing energy.

## **CONFIG** parameters

Example:

```javascript
const CONFIG = {
  energymeterAPI: 'http://192.168.2.121/meter/',
  baseConsumption: 0, //Set suitable value here if energy reading is not a net yield
  
  readinterval: 60, //seconds
  blinkinterval: 2,

  brightlight: 100, //Light normal brightness
  dimlight: 50,     //Blinking light's dimmed phase

  powerColors: [
    { reading: -3500, color: [0,100,12], blink: true },  //Bluish green
    { reading: -1500, color: [12,100,0], blink: false }, //Green
    { reading: -100, color: [100,69,0], blink: false },  //Greenish yellow
    { reading: 100, color: [100,31,0], blink: false },   //Orange
    { reading: 1000, color: [100,12,0], blink: false },  //Reddish orange
    { reading: 3500, color: [100,0,0], blink: false },   //Red
    { reading: 9999, color: [100,0,6], blink: true },    //Bright red
    { reading: 10001, color: [31,31,31], blink: false }  //White, error/wait
  ]
  
};
```

**energymeterAPI**

API endpoint that returns the energy reading (Watts)

If the reading is not a net yield, but only the amount of electricity produced, a suitable base consumption value can be set to **baseConsumption** parameter, which is subtracted from the reading obtained to reflect a more realistic amount of power available.

Note: Value is a net consumption, meaning that the sign is negative when the energy consumed is less than the amount of solar energy produced.

This example uses a HAN port reader (CTEK Nanogrid Air) attached to the electricity meter&apos;s port that monitors real time power usage and production. If yours is same you only need to set the IP address. Otherwise, you must change the url and alter the part in the function **QueryResponse** where the response is handled.

Nanogrid&apos;s interface has two fields containing power values, *activePowerOut* and *activePowerIn*, and they are in kilowatts. How this response is handled in the queryResponse function:

`result = parseInt((st.activePowerIn - st.activePowerOut)*1000); //Nanogrid, calculate net consumption and convert kW to W`

queryRespose function also includes an example of how to use a solar panel reading. *power.production* is the source field used in the example, and it will likely need to be changed. Notice how the sign is changed and the **baseConsumption** value is added to the reading:

`//result = -1 * parseInt(st.power.production) + CONFIG.baseConsumption; //For solar panel reading`

**baseConsumption**

Household&apos;s average energy consumption (Watts). This value is added to the energy meter reading to represent a more realistic situation. Only use this setting if the energy reading is not a net yield.

**readinterval**

How often new power reading is obtained and light color updated (seconds)

Be polite, if the API you&apos;re getting readings from isn&apos;t yours, consider what would be an appropriate time interval to call it.

**blinkinterval**

Frequency how fast the light is pulsating (seconds). Do not set to awfully fast, as the command execution takes time and they may collide with each other.

**brightlight**

Brightness of the light when fully lit (scale 0-100)

**dimlight**

Brightness of the light when it is set to pulsate and it is in the dimmed phase (scale 0-100)

**powerColors**

A list of power readings and their corresponding colors, and whether the light is blinking or not. The color value is a standard Shelly Plug rgb color matrix, where each individual color component has a scale of 0–100.

The list is checked from top to bottom, and when the measured power is lower than the power value in a row, the values ​​of that row are used.

The list can be edited freely, items can be added or removed. The only things to notice are that the power readings must be in ascending order, highest consumption last, and that the last item (value 10001) is reserved for startup and error condition, which turns the light white. If you have power values greater than this, increase this item&apos;s value so that it still is the last one, and change the **PLEASEWAIT** constant in the code (default value: 10000) to match it.

# Running

Check that the script is configured correctly and persistent mode is set, and start it. The plug should illuminate and first go white and then change color to match the current power reading.

The script uses two timers. One is used to get the power reading and set the color, the other to pulse the light if blinking of the selected color is enabled. 

