/**
 * @file src/utils/swrKeys.js
 * @brief Declares cache key generation paths for SWR data mutations.
 * 
 * Centralizes request endpoints mapping parameters (homeId, zoneId, date stamps) to resource URIs.
 */

export const SWR_KEYS = {
  // Home level
  homeInfo: (homeId) => `/homes/${homeId}/info`,
  homeState: (homeId) => `/homes/${homeId}/state`,
  homeDetails: (homeId) => `/homes/${homeId}/details`,
  weather: (homeId) => `/homes/${homeId}/weather`,
  climateQuality: (homeId) => `/homes/${homeId}/climateQuality`,
  timezone: (homeId) => `/homes/${homeId}/tanoclo/timezone`,
  
  // Zones & states
  zones: (homeId) => `/homes/${homeId}/zones`,
  zoneStates: (homeId) => `/homes/${homeId}/zoneStates`,
  zoneState: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/state`,
  defaultOverlay: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/defaultOverlay`,
  zoneControl: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/control`,
  
  // Schedules
  activeTimetable: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/schedule/activeTimetable`,
  timetableBlocks: (homeId, zoneId, timetableId) => `/homes/${homeId}/zones/${zoneId}/schedule/timetables/${timetableId}/blocks`,

  // Devices & Hardware
  devices: (homeId) => `/homes/${homeId}/devices`,
  deviceDetails: (homeId, deviceId) => `/homes/${homeId}/devices/${deviceId}`,
  deviceRaw: (homeId, deviceId) => `/homes/${homeId}/tanoclo/devices/${deviceId}/raw`,
  batteryDevices: (homeId) => `/homes/${homeId}/batteryDevices`,
  batteryDevicesRaw: (homeId) => `/homes/${homeId}/tanoclo/devices/battery`,
  bridge: (homeId) => `/homes/${homeId}/tanoclo/bridge`,
  
  // Users & Mobile
  users: (homeId) => `/homes/${homeId}/users`,
  mobileDevice: (homeId, deviceId) => `/homes/${homeId}/mobileDevices/${deviceId}`,
  mobileDevices: (homeId) => `/homes/${homeId}/mobileDevices`,

  // Heating system specific
  runningTimes: (homeId) => `/homes/${homeId}/runningTimes`,
  runningTimesQuery: (homeId, from, to, aggregate) => `/homes/${homeId}/runningTimes?from=${from}&to=${to}&aggregate=${aggregate}`,
  dayReport: (homeId, zoneId, date) => `/homes/${homeId}/tanoclo/zones/${zoneId}/dayReport?date=${date}`,
  standardDayReport: (homeId, zoneId, date) => `/homes/${homeId}/zones/${zoneId}/dayReport?date=${date}`,
  boilerRaw: (homeId) => `/homes/${homeId}/tanoclo/boiler/raw`,
  circuits: (homeId) => `/homes/${homeId}/tanoclo/circuits`,
  heatingSystem: (homeId) => `/homes/${homeId}/heatingSystem`,
  boilerDetails: (homeId) => `/homes/${homeId}/heatingSystem/boiler`,
  heatingCircuits: (homeId) => `/homes/${homeId}/heatingCircuits`,
  supplyTempOptimization: (homeId) => `/homes/${homeId}/supplyTemperatureOptimization`,
};
