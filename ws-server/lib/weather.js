/**
 * @file lib/weather.js
 * @brief Local weather conditions and solar metrics provider.
 */

'use strict';

const db = require('./db');
const { getLogger } = require('./logger');
const log = getLogger('weather');

/**
 * Maps WMO weather codes to Tado weather states
 * @param {number} code 
 * @returns {string}
 */
function mapWmoCodeToTado(code) {
    const mapping = {
        0: 'SUNNY',
        1: 'SUNNY',
        2: 'CLOUDY_PARTLY',
        3: 'CLOUDY',
        45: 'FOGGY',
        48: 'FOGGY',
        51: 'DRIZZLE',
        53: 'DRIZZLE',
        55: 'DRIZZLE',
        56: 'DRIZZLE',
        57: 'DRIZZLE',
        61: 'RAINY_SCATTERED',
        63: 'RAINY',
        65: 'RAINY',
        66: 'RAIN_SNOW',
        67: 'RAIN_SNOW',
        71: 'SNOW_SCATTERED',
        73: 'SNOW',
        75: 'SNOW',
        77: 'SNOW',
        80: 'RAINY_SCATTERED',
        81: 'RAINY',
        82: 'RAINY',
        83: 'RAIN_SNOW_SCATTERED',
        84: 'RAIN_SNOW_SCATTERED',
        85: 'SNOW_SCATTERED',
        86: 'SNOW',
        95: 'THUNDERSTORM',
        96: 'THUNDERSTORM',
        99: 'THUNDERSTORM'
    };

    return mapping[code] ?? 'CLOUDY';
}

/**
 * Maps US AQI to Tado levels
 */
function mapAqiToTado(aqi) {
    if (aqi <= 50) return 'GOOD';
    if (aqi <= 100) return 'FAIR';
    if (aqi <= 150) return 'MODERATE';
    if (aqi <= 200) return 'POOR';
    return 'VERY_POOR';
}

/**
 * Maps pollen count to Tado levels
 */
function mapPollenToTado(count) {
    if (count === 0 || count == null) return 'NONE';
    if (count <= 15) return 'LOW';
    if (count <= 50) return 'MODERATE';
    if (count <= 200) return 'HIGH';
    return 'VERY_HIGH';
}

/**
 * Fetches and updates weather for a specific home
 */
async function updateHomeWeather(homeId, lat, lon) {
    try {
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,shortwave_radiation&timezone=auto`;
        const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen`;

        log('debug', `Fetching weather & AQI for Home ${homeId} (${lat}, ${lon})`);

        const [wRes, aRes] = await Promise.all([fetch(weatherUrl), fetch(aqiUrl)]);
        if (!wRes.ok || !aRes.ok) {
            throw new Error(`HTTP error! Weather: ${wRes.status}, AQI: ${aRes.status}`);
        }

        const wData = await wRes.json();
        const aData = await aRes.json();

        if (!wData.current || !aData.current) {
            throw new Error('Invalid weather/AQI component response');
        }

        const current = wData.current;
        const temp = parseFloat(current.temperature_2m);
        const code = parseInt(current.weather_code, 10);
        const solar = parseFloat(current.shortwave_radiation ?? 0);
        const state = mapWmoCodeToTado(code);
        const solarIntensity = Math.min(100, Math.round(solar / 10));

        const aqiVal = aData.current.us_aqi;
        const aqiLevel = mapAqiToTado(aqiVal);

        const pollen = {
            grass: mapPollenToTado(aData.current.grass_pollen),
            birch: mapPollenToTado(aData.current.birch_pollen),
            ragweed: mapPollenToTado(aData.current.ragweed_pollen),
            olive: mapPollenToTado(aData.current.olive_pollen)
        };

        await db.saveHomeWeather(homeId, temp, solarIntensity, state, aqiVal, JSON.stringify(pollen));
        log('info', `Updated data for Home ${homeId}: ${temp}°C, ${state}, AQI: ${aqiLevel} (${aqiVal})`);

        return true;
    } catch (err) {
        log('error', `Update weather error for Home ${homeId}: ${err.message}`);
        return false;
    }
}

let _dailyRequests = 0;
let _dailyResetDate = new Date().toISOString().split('T')[0];

/**
 * Updates weather for all homes with valid coordinates
 */
async function updateAllHomesWeather() {
    const today = new Date().toISOString().split('T')[0];
    if (today !== _dailyResetDate) {
        _dailyRequests = 0;
        _dailyResetDate = today;
    }

    try {
        const homes = await db.getHomesWithLocation();
        log('info', `Starting weather update for ${homes.length} homes`);

        for (const home of homes) {
            if (_dailyRequests >= 9000) { // Limit to 9000 to keep a safe buffer from 10k limit
                log('warn', 'Daily Open-Meteo request limit approaching, skipping remaining homes');
                break;
            }
            await updateHomeWeather(home.id, home.latitude, home.longitude);
            _dailyRequests += 2; // Two API calls (weather + AQI) per home update
            
            // Introduce a short delay between requests if we have multiple homes
            if (homes.length > 5) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        log('info', 'Weather update cycle complete');
    } catch (err) {
        log('error', `updateAllHomesWeather error: ${err.message}`);
    }
}

module.exports = {
    updateHomeWeather,
    updateAllHomesWeather
};
