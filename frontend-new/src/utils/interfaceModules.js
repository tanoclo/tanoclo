/**
 * @file utils/interfaceModules.js
 * @brief Frontend catalogue of STM32 interface module families (field_015d).
 * 
 * Maps interface module IDs to bus families, labels, and supported capabilities.
 */

export const MODULE_FAMILIES = {
  OPENTHERM: {
    family: 'OPENTHERM',
    familyName: 'OpenTherm',
    badgeColor: 'var(--primary)',
    badgeBg: 'rgba(59, 130, 246, 0.1)',
    isDigitalBus: true,
    isOpenTherm: true,
    isModulating: true,
    isRelay: false,
    description: 'Digital bidirectional modulating bus with flow temperature control and detailed telemetry.'
  },
  EBUS_A: {
    family: 'EBUS_A',
    familyName: 'eBus A',
    badgeColor: '#10b981',
    badgeBg: 'rgba(16, 185, 129, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'Vaillant / digital modulating eBus interface.'
  },
  EBUS_B: {
    family: 'EBUS_B',
    familyName: 'eBus B',
    badgeColor: '#10b981',
    badgeBg: 'rgba(16, 185, 129, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'eBus variant B modulating interface.'
  },
  EBUS_C: {
    family: 'EBUS_C',
    familyName: 'eBus C',
    badgeColor: '#10b981',
    badgeBg: 'rgba(16, 185, 129, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'eBus variant C modulating interface.'
  },
  KM: {
    family: 'KM',
    familyName: 'KM-Bus',
    badgeColor: '#8b5cf6',
    badgeBg: 'rgba(139, 92, 246, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'Buderus / Junkers KM digital bus interface.'
  },
  HT_BUS: {
    family: 'HT_BUS',
    familyName: 'HT-Bus',
    badgeColor: '#ec4899',
    badgeBg: 'rgba(236, 72, 153, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'Junkers / Bosch HT digital bus interface.'
  },
  EMS: {
    family: 'EMS',
    familyName: 'EMS',
    badgeColor: '#06b6d4',
    badgeBg: 'rgba(6, 182, 212, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'Buderus / Nefit / Bosch EMS digital bus interface.'
  },
  BSB: {
    family: 'BSB',
    familyName: 'BSB',
    badgeColor: '#f59e0b',
    badgeBg: 'rgba(245, 158, 11, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'Brötje / Siemens BSB digital bus interface.'
  },
  SCOM: {
    family: 'SCOM',
    familyName: 'SCOM',
    badgeColor: '#14b8a6',
    badgeBg: 'rgba(20, 184, 166, 0.1)',
    isDigitalBus: true,
    isOpenTherm: false,
    isModulating: true,
    isRelay: false,
    description: 'De Dietrich SCOM digital bus interface.'
  },
  ANALOG_RELAY: {
    family: 'ANALOG_RELAY',
    familyName: 'Analog (On/Off Relay)',
    badgeColor: 'var(--warning)',
    badgeBg: 'rgba(234, 179, 8, 0.1)',
    isDigitalBus: false,
    isOpenTherm: false,
    isModulating: false,
    isRelay: true,
    description: 'Potential-free or switched-live relay contact. Boiler modulates via internal water thermistor; flow temperature is set on the boiler panel.'
  },
  VALVE: {
    family: 'VALVE',
    familyName: 'Radiator Valve (VA02)',
    badgeColor: 'var(--text-secondary)',
    badgeBg: 'rgba(156, 163, 175, 0.1)',
    isDigitalBus: false,
    isOpenTherm: false,
    isModulating: false,
    isRelay: false,
    description: 'Internal actuator motor for Smart Radiator Thermostats.'
  },
  WIRELESS_SENSOR: {
    family: 'WIRELESS_SENSOR',
    familyName: 'Wireless Temperature Sensor',
    badgeColor: 'var(--info)',
    badgeBg: 'rgba(14, 165, 233, 0.1)',
    isDigitalBus: false,
    isOpenTherm: false,
    isModulating: false,
    isRelay: false,
    description: 'Stand-alone wireless temperature and humidity sensor without direct boiler wiring.'
  },
  GENERIC: {
    family: 'GENERIC',
    familyName: 'Generic / Unconfigured',
    badgeColor: 'var(--text-muted)',
    badgeBg: 'rgba(156, 163, 175, 0.1)',
    isDigitalBus: false,
    isOpenTherm: false,
    isModulating: false,
    isRelay: false,
    description: 'Generic interface module.'
  }
};

const MODULE_MAP = new Map([
  [71, MODULE_FAMILIES.OPENTHERM],

  // eBus A
  [0, MODULE_FAMILIES.EBUS_A],
  [1, MODULE_FAMILIES.EBUS_A],
  [5, MODULE_FAMILIES.EBUS_A],
  [6, MODULE_FAMILIES.EBUS_A],
  [7, MODULE_FAMILIES.EBUS_A],
  [9, MODULE_FAMILIES.EBUS_A],
  [80, MODULE_FAMILIES.EBUS_A],
  [83, MODULE_FAMILIES.EBUS_A],

  // eBus B
  [121, MODULE_FAMILIES.EBUS_B],

  // eBus C
  [4, MODULE_FAMILIES.EBUS_C],
  [122, MODULE_FAMILIES.EBUS_C],

  // KM
  [20, MODULE_FAMILIES.KM],
  [22, MODULE_FAMILIES.KM],
  [23, MODULE_FAMILIES.KM],
  [24, MODULE_FAMILIES.KM],
  [50, MODULE_FAMILIES.KM],

  // HT-Bus
  [41, MODULE_FAMILIES.HT_BUS],
  [43, MODULE_FAMILIES.HT_BUS],
  [44, MODULE_FAMILIES.HT_BUS],

  // EMS
  [120, MODULE_FAMILIES.EMS],

  // BSB
  [100, MODULE_FAMILIES.BSB],
  [110, MODULE_FAMILIES.BSB],
  [111, MODULE_FAMILIES.BSB],
  [123, MODULE_FAMILIES.BSB],

  // SCOM
  [31, MODULE_FAMILIES.SCOM],
  [32, MODULE_FAMILIES.SCOM],

  // Analog Relay
  [3, MODULE_FAMILIES.ANALOG_RELAY],
  [10, MODULE_FAMILIES.ANALOG_RELAY],
  [11, MODULE_FAMILIES.ANALOG_RELAY],
  [12, MODULE_FAMILIES.ANALOG_RELAY],
  [30, MODULE_FAMILIES.ANALOG_RELAY],
  [40, MODULE_FAMILIES.ANALOG_RELAY],
  [42, MODULE_FAMILIES.ANALOG_RELAY],
  [60, MODULE_FAMILIES.ANALOG_RELAY],
  [61, MODULE_FAMILIES.ANALOG_RELAY],

  // Valve
  [112, MODULE_FAMILIES.VALVE],

  // Wireless Sensor
  [200, MODULE_FAMILIES.WIRELESS_SENSOR]
]);

export function getInterfaceModuleInfo(moduleId) {
  if (moduleId === null || moduleId === undefined || moduleId === '') {
    return { id: null, ...MODULE_FAMILIES.GENERIC };
  }
  const id = Number(moduleId);
  const info = MODULE_MAP.get(id);
  if (!info) {
    return { id, ...MODULE_FAMILIES.GENERIC };
  }
  return { id, ...info };
}
