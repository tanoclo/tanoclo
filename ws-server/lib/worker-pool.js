/**
 * @file lib/worker-pool.js
 * @brief Thread worker pool coordinating CPU-intensive decryption tasks.
 */

'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

class WorkerPool {
    constructor() {
        this.workerPath = path.join(__dirname, 'packet-worker.js');
        this.poolSize = Math.max(1, os.cpus().length - 1);
        this.workers = [];
        this.activeWorkers = new Set();
        this.taskQueue = [];
        this.nextTaskId = 1;
        this.pendingTasks = new Map(); // taskId -> { resolve, reject }
        this.workerTaskMap = new Map(); // Worker -> Set<taskId>
        this.workerData = null;
        this.initialized = false;
    }

    init(workerData = {}, log = null) {
        if (this.initialized) return;
        this.workerData = workerData;
        this._log = log || ((level, msg) => console.log(`[WorkerPool] [${level.toUpperCase()}] ${msg}`));
        
        this._log('info', `Initializing pool with ${this.poolSize} workers...`);
        for (let i = 0; i < this.poolSize; i++) {
            this.createWorker();
        }
        this.initialized = true;
    }

    createWorker() {
        const worker = new Worker(this.workerPath, {
            workerData: this.workerData
        });

        worker.on('message', (message) => {
            const { taskId, ok, result, error } = message;
            const pending = this.pendingTasks.get(taskId);
            if (pending) {
                this.pendingTasks.delete(taskId);
                this.activeWorkers.delete(worker);
                const workerTasks = this.workerTaskMap.get(worker);
                if (workerTasks) workerTasks.delete(taskId);
                if (ok) {
                    pending.resolve(result);
                } else {
                    pending.reject(new Error(error));
                }
                this.processQueue();
            }
        });

        worker.on('error', (err) => {
            if (this._log) this._log('error', `Worker error: ${err.message}`);
            this.handleWorkerFailure(worker, err);
        });

        worker.on('exit', (code) => {
            if (code !== 0 && this.initialized) {
                if (this._log) this._log('error', `Worker stopped with exit code ${code}`);
            }
            this.workers = this.workers.filter(w => w !== worker);
            this.activeWorkers.delete(worker);
            
            // Re-create worker to maintain pool size, with crash rate limiting
            if (this.initialized) {
                const now = Date.now();
                this._crashTimestamps = (this._crashTimestamps || []).filter(t => now - t < 10000);
                this._crashTimestamps.push(now);
                if (this._crashTimestamps.length > 3) {
                    if (this._log) this._log('error', `Worker crash rate exceeded (${this._crashTimestamps.length} crashes in 10s). Pausing worker recreation for 30s.`);
                    setTimeout(() => {
                        this._crashTimestamps = [];
                        if (this.initialized) this.createWorker();
                    }, 30000);
                } else {
                    this.createWorker();
                }
            }
        });

        this.workers.push(worker);
    }

    handleWorkerFailure(worker, err) {
        this.workers = this.workers.filter(w => w !== worker);
        this.activeWorkers.delete(worker);

        // Only reject tasks assigned to the crashed worker
        const crashedTasks = this.workerTaskMap.get(worker) || new Set();
        for (const taskId of crashedTasks) {
            const pending = this.pendingTasks.get(taskId);
            if (pending) {
                pending.reject(new Error(`Worker crashed: ${err ? err.message : 'unknown error'}`));
                this.pendingTasks.delete(taskId);
            }
        }
        this.workerTaskMap.delete(worker);

        // Recreate the failed worker
        this.createWorker();
        
        // Process any new tasks that may have queued
        this.processQueue();
    }

    run(taskType, data) {
        if (!this.initialized) {
            return Promise.reject(new Error('WorkerPool is not initialized'));
        }
        return new Promise((resolve, reject) => {
            const taskId = this.nextTaskId++;
            // Queue timeout: reject if task waits > 10s without being picked up
            const queueTimer = setTimeout(() => {
                const idx = this.taskQueue.findIndex(t => t.taskId === taskId);
                if (idx !== -1) {
                    this.taskQueue.splice(idx, 1);
                    this.pendingTasks.delete(taskId);
                    reject(new Error('WorkerPool queue timeout: all workers saturated'));
                }
            }, 10000);
            this.pendingTasks.set(taskId, {
                resolve: (val) => { clearTimeout(queueTimer); resolve(val); },
                reject: (err) => { clearTimeout(queueTimer); reject(err); }
            });
            this.taskQueue.push({ taskId, taskType, data });
            this.processQueue();
        });
    }

    processQueue() {
        while (this.taskQueue.length > 0) {
            // Find an idle worker
            const idleWorker = this.workers.find(w => !this.activeWorkers.has(w));
            if (!idleWorker) return;

            const task = this.taskQueue.shift();
            this.activeWorkers.add(idleWorker);
            if (!this.workerTaskMap.has(idleWorker)) {
                this.workerTaskMap.set(idleWorker, new Set());
            }
            this.workerTaskMap.get(idleWorker).add(task.taskId);
            idleWorker.postMessage(task);
        }
    }

    // Helper functions mapping to the tasks
    async coapParse(data) {
        const parsed = await this.run('coap_parse', data);
        if (parsed) {
            if (parsed.token) {
                parsed.token = Buffer.from(parsed.token);
            }
            if (parsed.payload) {
                parsed.payload = Buffer.from(parsed.payload);
            }
            if (parsed.options) {
                for (const opt of parsed.options) {
                    if (opt.value) {
                        opt.value = Buffer.from(opt.value);
                    }
                }
            }
        }
        return parsed;
    }

    async coapSerialize(msg) {
        const res = await this.run('coap_serialize', msg);
        return Buffer.from(res);
    }

    async tlvDecode(data) {
        return this.run('tlv_decode', data);
    }

    async tlvEncodeFromFields(fields) {
        const res = await this.run('tlv_encode_fields', fields);
        return Buffer.from(res);
    }

    async shutdown() {
        this.initialized = false;
        // Reject all pending tasks so callers don't hang
        for (const [taskId, pending] of this.pendingTasks) {
            pending.reject(new Error('WorkerPool shutting down'));
        }
        for (const worker of this.workers) {
            await worker.terminate();
        }
        this.workers = [];
        this.activeWorkers.clear();
        this.pendingTasks.clear();
        this.workerTaskMap.clear();
        this.taskQueue = [];
    }
}

// Export a singleton instance
module.exports = new WorkerPool();
