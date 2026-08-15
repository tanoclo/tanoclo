/**
 * @file lib/packet-worker.js
 * @brief Background worker thread parsing incoming packets queues.
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const coap = require('./coap');
const tlv = require('./tlv');

// Initialize TLV with database-loaded labels once during worker startup
if (workerData && workerData.labels) {
    tlv.init(workerData.labels);
}

parentPort.on('message', (task) => {
    const { taskId, taskType, data } = task;

    try {
        let result;
        switch (taskType) {
            case 'coap_parse': {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                const parsed = coap.parse(buf);
                if (!parsed.ok) {
                    throw new Error(`CoAP parse error: ${parsed.err}`);
                }
                result = {
                    ok: true,
                    ver: parsed.ver,
                    type: parsed.type,
                    tkl: parsed.tkl,
                    code: parsed.code,
                    mid: parsed.mid,
                    token: parsed.token, // Buffer
                    options: parsed.options,
                    payload: parsed.payload // Buffer
                };
                break;
            }
            case 'coap_serialize': {
                const serialized = coap.serialize(data);
                result = serialized; // Buffer
                break;
            }
            case 'tlv_decode': {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                const decoded = tlv.decode(buf);
                result = decoded;
                break;
            }
            case 'tlv_encode_fields': {
                const encoded = tlv.encodeFromFields(data);
                result = encoded; // Buffer
                break;
            }
            default:
                throw new Error(`Unknown task type: ${taskType}`);
        }

        // Send response back to main thread
        parentPort.postMessage({ taskId, ok: true, result });
    } catch (err) {
        parentPort.postMessage({ taskId, ok: false, error: err.message });
    }
});
