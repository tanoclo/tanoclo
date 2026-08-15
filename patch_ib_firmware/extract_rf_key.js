/**
 * @file extract_rf_key.js
 * @brief Tado Radio Protocol Extraction Utility.
 * 
 * Scans Bridge configuration firmware binary images to locate the 'BI..TF' magic signature
 * (hex: 42 49 00 00 54 46). Decodes home ID offsets, physical EUI address sequences,
 * and extracts the 16-byte AES-CCM Network Key used for secure radio frames encryption.
 */

const fs = require('fs');
const path = require('path');

/**
 * Tado Radio Protocol Extraction Tool
 * 
 * Extracts encryption keys and addressing metadata from Bridge firmware.
 */

function extractRfKey(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const buf = fs.readFileSync(filePath);

    // Pattern: Magic 'BI..TF' (42 49 00 00 54 46)
    const magic = Buffer.from([0x42, 0x49, 0x00, 0x00, 0x54, 0x46]);
    const magicOffset = buf.indexOf(magic);

    if (magicOffset === -1) {
        // Fallback to known offset if signature is missing or corrupted.
        // 0x4006 is the standard hardcoded offset of the 'BI..TF' magic signature inside the
        // Internet Bridge configuration page (which resides at the beginning of flash page 4, starting at 0x4000).
        const fixedMagicOffset = 0x4006;
        if (buf.length > fixedMagicOffset + magic.length && buf.slice(fixedMagicOffset, fixedMagicOffset + magic.length).equals(magic)) {
            extractFromOffset(buf, fixedMagicOffset);
        } else {
            console.error("Could not find Internet Bridge configuration signature.");
            process.exit(1);
        }
        return;
    }

    extractFromOffset(buf, magicOffset);
}

function extractFromOffset(buf, offset) {
    try {
        // The configuration page is a 128-byte block
        // Offset -6 is the absolute start of the page
        const configStart = offset - 6;
        if (configStart < 0 || configStart + 58 > buf.length) {
            console.error(`Error: configuration block at offset ${offset} is out of bounds (file size: ${buf.length})`);
            process.exit(1);
        }
        const homeId = buf.readUInt32LE(configStart);
        const serial = buf.readUInt32LE(offset + 8);
        const rfKey = buf.slice(offset + 12, offset + 12 + 16);

        // Tado OUI (IEEE vendor prefix)
        const realOUI = Buffer.from([0x02, 0x1B, 0xC5]);

        const homeIdBytes = [
            homeId & 0xFF,
            (homeId >> 8) & 0xFF,
            (homeId >> 16) & 0xFF,
            (homeId >> 24) & 0xFF
        ];

        const physicalEui = buf.slice(configStart + 50, configStart + 58);

        console.log("====================================================");
        console.log("   TADO RADIO PROTOCOL PARAMETERS EXTRACTION");
        console.log("====================================================");
        console.log(`Source Binary : ${path.basename(process.argv[2])}`);
        console.log(`Radio Home ID (Internal) : ${homeId} (0x${homeId.toString(16).toUpperCase()})`);
        console.log(`Physical EUI  : ${physicalEui.toString('hex').toUpperCase().match(/.{2}/g).join(':')}`);
        console.log(`Serial Number : ${serial}`);
        console.log("----------------------------------------------------");
        console.log(`AES-CCM NetKey: ${rfKey.toString('hex').toUpperCase()}`);
        console.log("----------------------------------------------------");
        console.log(`Global OUI    : ${realOUI.toString('hex').match(/.{2}/g).join(':').toUpperCase()}`);
        console.log("====================================================");

    } catch (e) {
        console.error("Error parsing configuration block:", e.message);
    }
}

if (process.argv.length < 3) {
    console.log("Usage: node extract_rf_key.js <bridge_binary>");
    process.exit(1);
}

extractRfKey(process.argv[2]);
