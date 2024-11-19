import { EventEmitter } from 'node:events';
import os from 'node:os';

import Queue from './Queue.mjs';
import { resolve } from 'node:path';

const nproc = os.cpus().length;

/**
 * 暂时没实现多线程后台处理的线程池，先写下原型
 */
class WorkerPool extends EventEmitter {
  _concurrency;
  _workers;

  constructor(num) {
    super();

    this._concurrency = num || (nproc / 2) | 0;
    if (this._concurrency >= nproc) {
      this._concurrency = (nproc / 2) | 0;
    }

    if (this._concurrency === 0) {
      this._concurrency = 1;
    }

    this._workers = new Queue([], nproc);
  }

  size() {
    return this._workers.size();
  }

  spawn(src) {
    const code = `
    import cheerio from "cheerio";
  
    ${src.toString()}

    process.exit(0)
    `;

    const self = this;

    return new Promise((resolve, reject) => {
      let worker;
      worker = new Worker(code, { eval: true, type: 'module' });
      worker.on('exit', (code) => {
        if (code === 0) {
          resolve(undefined);
        } else {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      worker.on('data', (data) => {
        if (data) {
          resolve(data);
        }
      });

      self._workers.push(worker);
    });
  }

  run() {
    return;
  }
}
