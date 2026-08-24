/**
 * @file lib/reassembler.js
 * @brief 6LoWPAN fragmentation reassembly engine with dynamic header expansion.
 */

'use strict';

const coapParser = require('./coap');

function parseTimestampToSeconds(ts) {
    if (!ts || ts === 'Unknown') return null;
    const parts = ts.split(':');
    if (parts.length !== 3) return null;
    const hrs = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    const secs = parseInt(parts[2], 10);
    if (isNaN(hrs) || isNaN(mins) || isNaN(secs)) return null;
    return hrs * 3600 + mins * 60 + secs;
}

function findCoapOffsetInFrag1(decrypted) {
    if (decrypted.length <= 13) return -1;
    const offset = coapParser.findCoapOffset(decrypted.subarray(9));
    return offset !== -1 ? offset + 9 : -1;
}

class SixLoWPANReassembler {
    constructor() {
        this.datagrams = new Map();
        this.completedTags = new Map();
    }

    /**
     * Process a decrypted payload (which may be unfragmented, FRAG1, or FRAGN).
     * 
     * @param {Buffer} decrypted - Plaintext payload
     * @param {string} timestamp - Timestamp string
     * @returns {object} Result descriptor
     */
    process(decrypted, timestamp) {
        if (!decrypted || decrypted.length <= 8) {
            return { type: 'unfragmented', data: decrypted };
        }

        const dispatch = decrypted[8];
        const isFrag1 = (dispatch & 0xF8) === 0xC0;
        const isFragn = (dispatch & 0xF8) === 0xE0;

        if (!isFrag1 && !isFragn) {
            return { type: 'unfragmented', data: decrypted };
        }

        if (decrypted.length < 12) {
            return { type: 'unfragmented', data: decrypted };
        }

        const size = ((decrypted[8] & 0x07) << 8) | decrypted[9];
        const tag = (decrypted[10] << 8) | decrypted[11];

        // Filter out duplicate fragments for recently completed datagrams
        const now = Date.now();
        if (this.completedTags.has(tag)) {
            const completedTime = this.completedTags.get(tag);
            if (now - completedTime < 10000) {
                return { type: 'duplicate_fragment', tag };
            } else {
                this.completedTags.delete(tag);
            }
        }

        // 10-second tag freshness check
        const currentSecs = parseTimestampToSeconds(timestamp);
        if (this.datagrams.has(tag)) {
            const dg = this.datagrams.get(tag);
            if (currentSecs !== null && dg.lastSecs !== null) {
                let diff = currentSecs - dg.lastSecs;
                if (diff < 0) diff += 86400; // Midnight rollover
                if (diff > 10) {
                    this.datagrams.delete(tag);
                }
            }
        }

        if (!this.datagrams.has(tag)) {
            this.datagrams.set(tag, {
                size,
                tag,
                fragments: new Map(),
                lines: [],
                lastSecs: currentSecs,
                senderShort: decrypted.subarray(0, 2),
                prefix: decrypted[2],
                completed: false,
                expansion: 40, // default fallback
                compressedSize: size - 40,
                hasExactExpansion: false,
                createdAt: Date.now()
            });
        }

        const dg = this.datagrams.get(tag);
        dg.lastSecs = currentSecs;

        let compressedOffset = 0;
        let payload;
        let fragType;

        if (isFrag1) {
            fragType = 'FRAG1';
            compressedOffset = 0;
            payload = decrypted.subarray(12); // after FRAG1 header
            dg.frag1_decrypted = decrypted;

            // Calculate precise expansion dynamically
            const coapOffset = findCoapOffsetInFrag1(decrypted);
            if (coapOffset !== -1) {
                const preciseExpansion = 48 - (coapOffset - 12);
                if (preciseExpansion !== dg.expansion || !dg.hasExactExpansion) {
                    const oldExpansion = dg.expansion;
                    dg.expansion = preciseExpansion;
                    dg.compressedSize = size - preciseExpansion;
                    dg.hasExactExpansion = true;

                    // Re-key existing FRAGN fragments using the new correct expansion
                    const oldFragments = Array.from(dg.fragments.entries());
                    dg.fragments.clear();
                    for (const [oldOffset, fragPayload] of oldFragments) {
                        if (oldOffset === 0) {
                            dg.fragments.set(0, fragPayload);
                        } else {
                            const uncompressedOffset = oldOffset + oldExpansion;
                            const newOffset = uncompressedOffset - preciseExpansion;
                            dg.fragments.set(newOffset, fragPayload);
                        }
                    }

                    for (const line of dg.lines) {
                        if (line.type === 'FRAGN') {
                            const uncompressedOffset = line.offset + oldExpansion;
                            line.offset = uncompressedOffset - preciseExpansion;
                        }
                    }
                }
            }
        } else {
            fragType = 'FRAGN';
            if (decrypted.length < 13) {
                return { type: 'unfragmented', data: decrypted };
            }
            const uncompressedOffset = decrypted[12] * 8;
            compressedOffset = uncompressedOffset - dg.expansion;
            payload = decrypted.subarray(13); // after FRAGN header
        }

        dg.fragments.set(compressedOffset, payload);
        dg.lines.push({ timestamp, type: fragType, offset: compressedOffset, length: payload.length });

        const completeBuffer = this.checkComplete(tag);
        const progress = this.getProgress(tag);
        const missingParts = this.getMissingParts(dg);

        if (completeBuffer) {
            dg.completed = true;
            this.datagrams.delete(tag);
            this.completedTags.set(tag, Date.now());

            // Housekeeping for completedTags cache
            if (this.completedTags.size > 200) {
                const cutoff = Date.now() - 30000;
                for (const [t, ts] of this.completedTags.entries()) {
                    if (ts < cutoff) {
                        this.completedTags.delete(t);
                    }
                }
            }

            // Prepend original senderShort (2 bytes) and prefix (1 byte)
            const finalBuffer = Buffer.concat([dg.senderShort, Buffer.from([dg.prefix]), completeBuffer]);

            return {
                type: 'complete',
                tag,
                size,
                data: finalBuffer,
                dgInfo: dg,
                progress
            };
        } else {
            return {
                type: 'incomplete',
                tag,
                size,
                offset: compressedOffset,
                length: payload.length,
                fragType,
                progress,
                missingParts
            };
        }
    }

    checkComplete(tag) {
        const dg = this.datagrams.get(tag);
        if (!dg) return null;

        const sortedOffsets = Array.from(dg.fragments.keys()).sort((a, b) => a - b);
        let currentOffset = 0;
        const pieces = [];

        for (const offset of sortedOffsets) {
            const fragData = dg.fragments.get(offset);
            const fragEnd = offset + fragData.length;

            if (offset <= currentOffset && fragEnd > currentOffset) {
                const skip = currentOffset - offset;
                pieces.push(fragData.subarray(skip));
                currentOffset = fragEnd;
            } else if (fragEnd <= currentOffset) {
                continue;
            } else {
                break;
            }
        }

        const targetSize = dg.compressedSize;
        if (currentOffset >= targetSize) {
            let combined = Buffer.concat(pieces);
            if (combined.length > targetSize) {
                combined = combined.subarray(0, targetSize);
            }
            return combined;
        }
        return null;
    }

    getProgress(tag) {
        const dg = this.datagrams.get(tag);
        if (!dg) return null;

        let receivedBytes = 0;
        const offsets = Array.from(dg.fragments.keys()).sort((a, b) => a - b);
        for (const offset of offsets) {
            receivedBytes += dg.fragments.get(offset).length;
        }

        const targetSize = dg.compressedSize;
        return {
            receivedBytes,
            totalSize: targetSize,
            offsets,
            percent: Math.min(100, Math.round((receivedBytes / targetSize) * 100))
        };
    }

    getMissingParts(dg) {
        const missing = [];
        if (!dg.fragments.has(0)) {
            missing.push('FRAG1 (offset 0)');
        }
        let currentOffset = 0;
        const sortedOffsets = Array.from(dg.fragments.keys()).sort((a, b) => a - b);
        for (const offset of sortedOffsets) {
            if (offset > currentOffset) {
                missing.push(`Gap [offset ${currentOffset} to ${offset}]`);
            }
            currentOffset = offset + dg.fragments.get(offset).length;
        }
        const targetSize = dg.compressedSize;
        if (currentOffset < targetSize) {
            missing.push(`End tail [offset ${currentOffset} to ${targetSize}]`);
        }
        return missing.join(', ') || 'None';
    }

    cleanup() {
        const now = Date.now();
        for (const [tag, dg] of this.datagrams.entries()) {
            if (now - dg.createdAt > 30000) {
                this.datagrams.delete(tag);
            }
        }
    }
}

module.exports = SixLoWPANReassembler;
