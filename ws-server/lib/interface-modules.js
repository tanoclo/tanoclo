/**
 * @file lib/interface-modules.js
 * @brief Catalogue of STM32 interface module families and bus capabilities (field_015d).
 * 
 * Sourced from STM32 firmware interface catalogue at 0x08007f28.
 */

'use strict';

const MODULE_FAMILIES = {
    OPENTHERM: {
        family: 'OPENTHERM',
        familyName: 'OpenTherm',
        isDigitalBus: true,
        isOpenTherm: true,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'returnTemperature', 'controlSetpoint',
            'modulationPercentage', 'flameActive', 'flameCurrentUa',
            'waterPressureBar', 'dhwTargetTemperature', 'dhwMeasuredTemperature',
            'dhwFlowRateLpm', 'outsideTemperature', 'exhaustTemperature',
            'burnerStarts', 'chPumpStarts', 'dhwBurnerStarts', 'chBurnerStarts',
            'burnerHoursTotal', 'burnerHoursCh', 'burnerHoursDhw',
            'maxChFlowTemperature', 'dhwSetpointUpperBound',
            'dhwStorageTank', 'dhwInstantaneous', 'oemFaultCode', 'oemDiagnosticCode'
        ]
    },
    EBUS_A: {
        family: 'EBUS_A',
        familyName: 'eBus A',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'returnTemperature', 'controlSetpoint',
            'modulationPercentage', 'flameActive', 'waterPressureBar',
            'burnerStarts', 'burnerHoursTotal', 'oemFaultCode', 'oemDiagnosticCode'
        ]
    },
    EBUS_B: {
        family: 'EBUS_B',
        familyName: 'eBus B',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'returnTemperature', 'controlSetpoint',
            'modulationPercentage', 'flameActive', 'waterPressureBar'
        ]
    },
    EBUS_C: {
        family: 'EBUS_C',
        familyName: 'eBus C',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'returnTemperature', 'controlSetpoint',
            'modulationPercentage', 'flameActive', 'waterPressureBar'
        ]
    },
    KM: {
        family: 'KM',
        familyName: 'KM-Bus',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'controlSetpoint', 'modulationPercentage',
            'flameActive', 'burnerStarts', 'burnerHoursTotal'
        ]
    },
    HT_BUS: {
        family: 'HT_BUS',
        familyName: 'HT-Bus',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'controlSetpoint', 'modulationPercentage',
            'flameActive', 'burnerStarts', 'burnerHoursTotal'
        ]
    },
    EMS: {
        family: 'EMS',
        familyName: 'EMS',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'returnTemperature', 'controlSetpoint',
            'modulationPercentage', 'flameActive', 'waterPressureBar',
            'dhwTargetTemperature', 'dhwMeasuredTemperature',
            'burnerStarts', 'burnerHoursTotal'
        ]
    },
    BSB: {
        family: 'BSB',
        familyName: 'BSB',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'controlSetpoint', 'modulationPercentage', 'flameActive'
        ]
    },
    SCOM: {
        family: 'SCOM',
        familyName: 'SCOM',
        isDigitalBus: true,
        isOpenTherm: false,
        isModulating: true,
        isRelay: false,
        potentialMetrics: [
            'flowTemperature', 'controlSetpoint', 'modulationPercentage', 'flameActive'
        ]
    },
    ANALOG_RELAY: {
        family: 'ANALOG_RELAY',
        familyName: 'Analog (On/Off Relay)',
        isDigitalBus: false,
        isOpenTherm: false,
        isModulating: false,
        isRelay: true,
        potentialMetrics: [
            'flameActive', 'operatingMode', 'circuitDemand'
        ]
    },
    VALVE: {
        family: 'VALVE',
        familyName: 'Radiator Valve (VA02)',
        isDigitalBus: false,
        isOpenTherm: false,
        isModulating: false,
        isRelay: false,
        potentialMetrics: []
    },
    WIRELESS_SENSOR: {
        family: 'WIRELESS_SENSOR',
        familyName: 'Wireless Temperature Sensor',
        isDigitalBus: false,
        isOpenTherm: false,
        isModulating: false,
        isRelay: false,
        potentialMetrics: []
    },
    TEST_STUB: {
        family: 'TEST_STUB',
        familyName: 'Test Stub',
        isDigitalBus: false,
        isOpenTherm: false,
        isModulating: false,
        isRelay: false,
        potentialMetrics: []
    },
    GENERIC: {
        family: 'GENERIC',
        familyName: 'Unconfigured / Generic',
        isDigitalBus: false,
        isOpenTherm: false,
        isModulating: false,
        isRelay: false,
        potentialMetrics: []
    }
};

const MODULE_MAP = new Map([
    // OpenTherm
    [71, MODULE_FAMILIES.OPENTHERM],

    // eBus A (0 is firmware default, also drives relay on 1,5,6,7,9)
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

    // KM (Buderus/Junkers)
    [20, MODULE_FAMILIES.KM],
    [22, MODULE_FAMILIES.KM],
    [23, MODULE_FAMILIES.KM],
    [24, MODULE_FAMILIES.KM],
    [50, MODULE_FAMILIES.KM],

    // HT-Bus (Junkers/Bosch)
    [41, MODULE_FAMILIES.HT_BUS],
    [43, MODULE_FAMILIES.HT_BUS],
    [44, MODULE_FAMILIES.HT_BUS],

    // EMS (Buderus/Nefit)
    [120, MODULE_FAMILIES.EMS],

    // BSB
    [100, MODULE_FAMILIES.BSB],
    [110, MODULE_FAMILIES.BSB],
    [111, MODULE_FAMILIES.BSB],
    [123, MODULE_FAMILIES.BSB],

    // SCOM (De Dietrich)
    [31, MODULE_FAMILIES.SCOM],
    [32, MODULE_FAMILIES.SCOM],

    // Analog (on/off potential-free / switched-live relay)
    [3, MODULE_FAMILIES.ANALOG_RELAY],
    [10, MODULE_FAMILIES.ANALOG_RELAY],
    [11, MODULE_FAMILIES.ANALOG_RELAY],
    [12, MODULE_FAMILIES.ANALOG_RELAY],
    [30, MODULE_FAMILIES.ANALOG_RELAY],
    [40, MODULE_FAMILIES.ANALOG_RELAY],
    [42, MODULE_FAMILIES.ANALOG_RELAY],
    [60, MODULE_FAMILIES.ANALOG_RELAY],
    [61, MODULE_FAMILIES.ANALOG_RELAY],

    // Valve (VA02 internal actuator)
    [112, MODULE_FAMILIES.VALVE],

    // Wireless Temperature Sensor
    [200, MODULE_FAMILIES.WIRELESS_SENSOR],

    // Test Stub
    [202, MODULE_FAMILIES.TEST_STUB]
]);

/**
 * Looks up interface module information for a given 015d integer ID.
 * 
 * @param {number|string|null|undefined} moduleId
 * @returns {Object} Interface module metadata
 */
function getInterfaceModuleInfo(moduleId) {
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

/**
 * Checks if module ID belongs to a digital modulating bus (e.g. OpenTherm, eBus, EMS).
 * 
 * @param {number|string} moduleId
 * @returns {boolean}
 */
function isModulatingBus(moduleId) {
    return getInterfaceModuleInfo(moduleId).isModulating;
}

/**
 * Checks if module ID is OpenTherm.
 * 
 * @param {number|string} moduleId
 * @returns {boolean}
 */
function isOpenTherm(moduleId) {
    return getInterfaceModuleInfo(moduleId).isOpenTherm;
}

/**
 * Checks if module ID is an Analog Relay.
 * 
 * @param {number|string} moduleId
 * @returns {boolean}
 */
function isRelay(moduleId) {
    return getInterfaceModuleInfo(moduleId).isRelay;
}

/**
 * Metric to FID column mapping for validation against ingested records.
 */
const METRIC_TO_COLUMN_MAP = {
    flowTemperature: 'field_044c',
    returnTemperature: 'field_044d',
    controlSetpoint: 'field_0450',
    modulationPercentage: 'field_0452',
    flameActive: 'field_0457',
    flameCurrentUa: 'field_0458',
    waterPressureBar: 'field_0462',
    dhwTargetTemperature: 'field_045b',
    dhwMeasuredTemperature: 'field_045a',
    dhwFlowRateLpm: 'field_045e',
    outsideTemperature: 'field_044f',
    exhaustTemperature: 'field_044e',
    burnerStarts: 'field_0463',
    chPumpStarts: 'field_0464',
    dhwBurnerStarts: 'field_0464',
    chBurnerStarts: 'field_0465',
    burnerHoursTotal: 'field_0466',
    burnerHoursCh: 'field_0467',
    burnerHoursDhw: 'field_0468',
    maxChFlowTemperature: 'field_046f',
    dhwSetpointUpperBound: 'field_0471',
    dhwStorageTank: 'field_046c',
    dhwInstantaneous: 'field_046d'
};

/**
 * Computes active supported metrics by intersecting protocol potential
 * with actual non-sentinel values present in the database record.
 * 
 * @param {number|string|null} moduleId
 * @param {Object} hvacRow - heating_systems row or merged measurement row
 * @returns {string[]} Array of supported metric keys
 */
function computeSupportedMetrics(moduleId, hvacRow = {}) {
    const modInfo = getInterfaceModuleInfo(moduleId);
    const potential = modInfo.potentialMetrics || [];
    const supported = [];

    for (const metric of potential) {
        const col = METRIC_TO_COLUMN_MAP[metric];
        if (!col) {
            // Non-FID metric (like operatingMode or circuitDemand)
            supported.push(metric);
            continue;
        }

        const val = hvacRow[col];
        if (val === undefined || val === null) continue;

        const numVal = Number(val);
        // Exclude sentinel values
        if (numVal === 65535 || numVal === 4294967295 || numVal > 70000000) {
            continue;
        }

        supported.push(metric);
    }

    return supported;
}

module.exports = {
    MODULE_FAMILIES,
    MODULE_MAP,
    getInterfaceModuleInfo,
    isModulatingBus,
    isOpenTherm,
    isRelay,
    computeSupportedMetrics
};
