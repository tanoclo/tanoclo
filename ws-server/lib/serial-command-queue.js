/**
 * @file lib/serial-command-queue.js
 * @brief Run asynchronous command handlers in arrival order per resource.
 */

'use strict';

class SerialCommandQueue {
    constructor() {
        this.tails = new Map();
    }

    /**
     * @template T
     * @param {string} scope Commands sharing this resource wait for each other.
     * @param {() => T|PromiseLike<T>} action Complete asynchronous handler.
     * @returns {Promise<T>} The action result, including failures for the caller to report.
     */
    run(scope, action) {
        const previous = this.tails.get(scope) || Promise.resolve();
        const result = previous.then(() => action());
        // A failed command must not poison later commands. Keep the original
        // result separate so the subscriber can still report that failure.
        const tail = result.then(() => {}, () => {}).finally(() => {
            if (this.tails.get(scope) === tail) this.tails.delete(scope);
        });
        this.tails.set(scope, tail);
        return result;
    }
}

/**
 * Match the home/zone/device identifiers used by the command handler. Numeric
 * aliases such as 01 and 1 must share a queue because they address the same row.
 * Other topics retain their exact identity without changing input validation.
 *
 * @param {string} topic MQTT topic.
 * @returns {string} Queue resource identity.
 */
function commandScope(topic) {
    const parts = topic.split('/');
    if (parts[2] !== 'h') return topic;
    const homeId = parseInt(parts[3], 10);
    if (isNaN(homeId)) return topic;
    if (parts[4] === 'set') return 'h:' + homeId;
    if (parts[4] === 'z') {
        const zoneId = parseInt(parts[5], 10);
        return isNaN(zoneId) ? topic : 'h:' + homeId + ':z:' + zoneId;
    }
    return ['h', homeId, parts[4], parts[5]].join(':');
}

module.exports = { SerialCommandQueue, commandScope };
