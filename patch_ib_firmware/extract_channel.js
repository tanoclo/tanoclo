#!/usr/bin/env node
/**
 * @file extract_channel.js
 * @brief Tado RF Channel Extractor utility.
 * 
 * Scans configuration partitions (active: 0x102000, backup: 0x103000) inside external
 * SPI flash dump binary images to locate and extract the RF channel configuration (Property ID 0x016A).
 * Decodes the channel integer value and prints it in hex format.
 */
const fs = require('fs');
const path = require('path');

function printUsage() {
    console.log('Usage: node extract_channel.js <path_to_spi_flash_dump.bin>');
    console.log('Example: node extract_channel.js unmodded_spi.bin');
}
// Parse arguments
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
}
const filePath = path.resolve(args[0]);
if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found at "${filePath}"`);
    process.exit(1);
}
let fileBuffer;
try {
    fileBuffer = fs.readFileSync(filePath);
} catch (err) {
    console.error(`Error reading file: ${err.message}`);
    process.exit(1);
}
// Ensure the file is large enough to contain the configuration partitions
const MIN_REQUIRED_SIZE = 0x103000 + 0x1000;
if (fileBuffer.length < MIN_REQUIRED_SIZE) {
    console.warn(`Warning: File size (${fileBuffer.length} bytes) is smaller than standard 2MB SPI dump (${MIN_REQUIRED_SIZE} bytes).`);
}
function findChannelInPartition(offset) {
    let ptr = offset;
    const end = Math.min(offset + 0x1000, fileBuffer.length);

    while (ptr < end - 3) {
        const fid = fileBuffer.readUInt16LE(ptr);
        const len = fileBuffer.readUInt8(ptr + 2);

        if (fid === 0xffff || fid === 0x0000) {
            break; // Partition termination marker
        }

        if (ptr + 3 + len > end) {
            break; // Corrupted entry boundary
        }

        if (fid === 0x016A) { // Property Index 362 (RF Channel)
            if (len >= 1) {
                return fileBuffer.readUInt8(ptr + 3);
            }
        }

        ptr += 3 + len;
    }
    return null;
}
const activeChannel = findChannelInPartition(0x102000);
const backupChannel = findChannelInPartition(0x103000);
if (activeChannel !== null) {
    console.log(`\nActive RF Channel found: ${activeChannel} (0x${activeChannel.toString(16).toUpperCase().padStart(2, '0')})`);
    if (backupChannel !== null && backupChannel !== activeChannel) {
        console.log(`Backup RF Channel found: ${backupChannel} (0x${backupChannel.toString(16).toUpperCase().padStart(2, '0')})`);
    }
} else if (backupChannel !== null) {
    console.log(`\nActive partition empty, but Backup RF Channel found: ${backupChannel} (0x${backupChannel.toString(16).toUpperCase().padStart(2, '0')})`);
} else {
    console.log('\nRF Channel configuration (FID 0x016A) not found in the SPI flash configuration partitions.');
    console.log('Ensure this is a valid external SPI flash dump containing dynamic configurations.');
    process.exit(1);
}
