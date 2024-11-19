import { EventEmitter } from 'node:events';
import { FlatCache } from 'flat-cache';
import mime from 'mime-types';
import got from 'got';

import Url from './Url.mjs';
import FifoUrlList from './FifoUrlList.mjs';
import { HttpError, RequestError, HandlersError } from './Error.mjs';

const DEFAULT_DEPTH = 1;
// 默认发请求的间隔是0.1秒
const DEFAULT_INTERVAL = 100;
const DEFAULT_CONCURRENT_REQUESTS_LIMIT = 5;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; krawler/1.0)';

class Crawler extends EventEmitter {
  _depth;
  _urlList;
  _interval;
  _handlers;
  _pageCache;
  _userAgent;
  _gotOptions;
  _followRedirect;
  _concurrentLimit;
  _outstandingRequests;

  /**
   * Object represents an instance of a crawler, i.e. a HTTP client that
   * automatically crawls webpages according to the settings passed to it.
   *
   * @param {Object} [opts] Object of configuration options.
   */
  constructor(opts) {
    if (typeof opts === 'undefined') {
      opts = {};
    }

    super();

    this._handlers = new Map();
    this._outstandingRequests = 0;

    this._depth = opts.depth || DEFAULT_DEPTH;

    /*
     * 提供给Got库的请求参数，例如method，headers，retry
     * 具体参数需要参考Got库的文档
     * https://github.com/sindresorhus/got/blob/main/documentation/2-options.md
     */
    this._gotOptions = opts.gotOptions || {};
    this._urlList = opts.urlList || new FifoUrlList();
    this._interval = opts.interval || DEFAULT_INTERVAL;
    this._userAgent = opts.userAgent || DEFAULT_USER_AGENT;
    this._followRedirect = opts.followRedirect || true;
    this._concurrentLimit = opts.concurrentLimit || DEFAULT_CONCURRENT_REQUESTS_LIMIT;

    this._pageCache = new FlatCache({ ttl: '1d' });

    this.on('url_queue_complete', function () {
      console.log('所有链接已经爬完');

      this.stop();
      this._pageCache.save();
    });
  }

  getPageCache() {
    return this._pageCache;
  }

  /**
   * Returns the instance of a \UrlList object that is being used. Unless
   * specified to the constructor, this will be \FifoUrlList type
   *
   * @return {UrlList} Instance of \UrlList type object.
   */
  getUrlList() {
    return this._urlList;
  }

  /**
   * Get the interval setting, that is the number of milliseconds that the
   * crawler waits before performing another request.
   *
   * @return {number} Interval in milliseconds.
   */
  getInterval() {
    return this._interval;
  }

  /**
   * Get the maximum number of requests that can be in progress at any one time.
   *
   * @return {number} Maximum number of requests
   */
  getConcurrentRequestsLimit() {
    return this._concurrentLimit;
  }

  /**
   * Get the user agent that is used to make requests.
   *
   * @return {string} User agent
   */
  getUserAgent(url) {
    if (typeof this._userAgent === 'function') {
      return this._userAgent(url);
    }

    return this._userAgent;
  }

  /**
   * Custom options to be passed to the request library.
   *
   * @return {Object} Object of request options to be merged with the defaults.
   */
  getRequestOptions() {
    return this._gotOptions;
  }

  /**
   * 初始化种子地址，目前只支持HTTP和HTTPS协议的链接，会做URL格式的检验
   *
   * @param {String|Array} uri
   */
  async initSeed(uri) {
    const self = this;
    if (typeof uri === 'undefined') {
      throw new Error('初始化种子链接必须至少添加一个');
    }

    if (uri instanceof Array) {
      uri.forEach((i) => {
        self.initSeed(uri);
      });
    } else if (typeof uri === 'string') {
      if (URL.canParse(uri) && (uri.indexOf('https:/') === 0 || uri.indexOf('http:/') === 0)) {
        const _seed = new Url({ url: uri });
        this.getUrlList().insertIfNotExists(_seed);
      } else {
        throw new HttpError('链接不是正常的URL格式');
      }
    } else {
      throw new HttpError('链接不是正常的URL格式');
    }
  }

  setHandler(contentType, handler) {
    // if this method is called as addHandler(\Function), that means the
    // handler will deal with all content types.
    if (arguments.length === 1) {
      return this.setHandler('*', arguments[0]);
    }

    const self = this;

    if (Array.isArray(contentType)) {
      contentType.forEach(function (ctype) {
        self.setHandler(ctype, handler);
      });
    }

    this._handlers.set(contentType, handler);

    return true;
  }

  /**
   * Download a particular URL. Generally speaking, we do not want to follow
   * redirects, because we just add the destination URLs to the queue and crawl
   * them later.
   *
   * @param  {Url} url             URL to fetch.
   * @return {Promise}                Promise of result.
   */
  async _downloadUrl(url) {
    let defaultOptions = {
      method: 'GET',
      headers: {
        Accept: '*',
        'User-Agent': this.getUserAgent(url) // 可以给userAgent传入一个生成函数用来随机生成
      },
      followRedirect: Boolean(this._followRedirect)
    };

    if (typeof url.getParent() !== 'undefined') {
      defaultOptions.headers['Referer'] = url.getParent();
    }

    const requestOptions = Object.assign({}, defaultOptions, this.getRequestOptions());

    const client = got.extend(requestOptions);

    let response;
    try {
      response = await client(encodeURI(url.getUrl()));
      return response;
    } catch (err) {
      if (err.response.statusCode >= 400) {
        const e = new HttpError('HTTP status code is ' + err.response.statusCode);
        e.statusCode = err.response.statusCode;

        throw e;
      } else {
        const e = new RequestError('A request error occured. ' + err.message);
        throw e;
      }
    }
  }

  async _appendLinks(links, prevUrl) {
    const self = this;
    const urlList = self.getUrlList();

    try {
      if (typeof urlList.insertIfNotExistsBulk === 'undefined') {
        await links.map((link) => {
          urlList.insertIfNotExists(
            new Url({
              url: link,
              parent: prevUrl
            })
          );
        });
      } else {
        await urlList.insertIfNotExistsBulk(
          await links.map(function (link) {
            return new Url({
              url: link,
              parent: prevUrl
            });
          })
        );
      }
    } catch (err) {
      self.emit('other_error', err);

      // 无论链接放进队列是否成功都减小爬取深度
      this._depth--;

      return new Url({
        url: prevUrl.getUrl(),
        errorCode: 'OTHER_ERROR',
        parent: prevUrl.getParent(),
        errorMessage: err.message
      });
    }

    // 链接放进队列之后缩小爬取深度
    this._depth--;

    return prevUrl;
  }

  /**
   * 这个方法只用于处理下载页面的异常报错，专门分离出IO类型的异步任务
   *
   * @param  {string} url   The URL to crawl.
   * @return {Promise}      Promise of result URL object.
   */
  async _processUrl(urlObj) {
    const self = this;

    const curUrl = urlObj.getUrl();
    this.emit('crawl_url', curUrl);

    // perform url download
    let _response;
    try {
      _response = await this._downloadUrl(urlObj);
    } catch (err) {
      switch (err.constructor) {
        case HttpError: {
          self.emit('http_error', err, curUrl);

          return new Url({
            url: curUrl,
            errorCode: 'HTTP_ERROR',
            parent: urlObj.getParent(),
            statusCode: err.statusCode
          });
        }
        case RequestError: {
          self.emit('request_error', err);

          return new Url({
            url: curUrl,
            errorCode: 'REQUEST_ERROR',
            parent: urlObj.getParent(),
            errorMessage: err.message
          });
        }
      }
    }

    return this._handleResponse(
      new Url({
        url: curUrl,
        errorCode: null,
        parent: urlObj.getParent(),
        statusCode: _response.statusCode
      }),
      _response
    );
  }

  /**
   * 把处理页面内容的逻辑分离出来，以后可以用来增加对结构化数据的处理
   *
   * @param {Url} newUrl
   * @param {Response} response
   * @returns {Url}
   */
  async _handleResponse(newUrl, response) {
    let contentType, statusCode, links, handlerFunc;

    contentType = response.headers['content-type'] || mime.lookup(newUrl.getUrl());
    statusCode = response.statusCode;
    const location = response.headers.location;

    // If this is a redirect, we follow the location header.
    // Otherwise, we get the discovered URLs from the content handlers.
    if (statusCode >= 300 && statusCode < 400) {
      self.emit('redirect', newUrl.getUrl(), location);
      links = [new URL(location, newUrl.getUrl())];
    } else {
      contentType = contentType.replace(/;.*$/g, '');
      if (typeof this._handlers.get('*') !== 'undefined') {
        handlerFunc = this._handlers.get('*');
      } else if (this._handlers.get(contentType)) {
        handlerFunc = this._handlers.get(contentType);
      } else {
        for (const k of this._handlers.keys()) {
          if (k.indexOf(contentType) > -1 || (contentType + '/').indexOf(k + '/') === 0) {
            handlerFunc = this._handlers.get(k);
            break;
          }
        }
      }

      if (typeof handlerFunc === 'undefined') {
        return newUrl;
      }

      // 放进缓存为以后的异步处理做准备，用链接的SHA256哈希值做索引
      this.getPageCache().set(newUrl.getUniqueId(), response);
      const ctx = { url: newUrl.getUrl(), contentType: contentType, body: response.body };
      try {
        links = await handlerFunc(ctx);
        self.emit('links', newUrl.getUrl(), links);
      } catch (err) {
        if (err.constructor == HandlersError) {
          self.emit('handlers_error', err);

          return new Url({
            url: newUrl.getUrl(),
            errorCode: 'HANDLERS_ERROR',
            parent: newUrl.getParent(),
            errorMessage: err.message
          });
        } else {
          throw err;
        }
      }

      // 如果爬的当前页面不是重定向地址，并且爬取深度最后只剩 1 了，当前页面就是最后一层了
      // 爬取深度为 1 的时候，队列也基本清空了
      if (this._depth === 1) {
        return newUrl;
      }
    }

    return this._appendLinks(links, newUrl);
  }

  /**
   * Get the \Date that we are allowed to send another request. If we haven't
   * already sent a request, this will return the current date.
   *
   * @return {Date} Date of next request.
   */
  _getNextRequestDate() {
    var interval, lastRequestDate, nextRequestDate;

    interval = this.getInterval();
    lastRequestDate = this._lastRequestDate;

    if (!lastRequestDate) {
      nextRequestDate = new Date();
    } else {
      nextRequestDate = new Date(lastRequestDate.getTime() + interval);
    }

    return nextRequestDate;
  }

  /**
   * Work out when we are allowed to send another request, and schedule a call
   * to _crawlTick.
   */
  _scheduleNextTick() {
    let nextRequestDate,
      nowDate,
      delayMs,
      self = this;

    nextRequestDate = this._getNextRequestDate();
    nowDate = new Date();
    delayMs = Math.max(0, nextRequestDate - nowDate);

    setTimeout(async function () {
      await self._crawlTick();
    }, delayMs);
  }

  async _crawlTick() {
    let urlList,
      nextRequestDate,
      nowDate,
      self = this;

    // Crawling has stopped, so don't start any new requests
    if (!this._started) {
      return;
    }

    urlList = this.getUrlList();
    nextRequestDate = this._getNextRequestDate();
    nowDate = new Date();

    // Check if we are allowed to send the request yet. If we aren't allowed,
    // schedule the request for LAST_REQUEST_DATE + INTERVAL.
    if (nextRequestDate - nowDate > 0) {
      this._scheduleNextTick();

      return;
    }

    // lastRequestDate must always be set SYNCHRONOUSLY! This is because there
    // will be multiple calls to _crawlTick.
    this._lastRequestDate = nowDate;

    try {
      const urlObj = await urlList.getNextUrl();

      // We keep track of number of outstanding requests. If this is >= 1, the
      // queue is still subject to change -> so we do not wish to declare
      // url_queue_complete until those changes are synced with the \UrlList.
      self._outstandingRequests++;

      try {
        const resultUrl = await self._processUrl(urlObj);
        self.emit(
          'crawled_url',
          resultUrl.getUrl(),
          resultUrl.getErrorCode(),
          resultUrl.getStatusCode(),
          resultUrl.getErrorMessage()
        );

        return urlList.upsert(resultUrl);
      } finally {
        self._outstandingRequests--;
      }
    } catch (err) {
      if (err instanceof RangeError) {
        self.emit('url_queue_empty');

        if (self._outstandingRequests === 0) {
          self.emit('url_queue_complete');
        }
      }
    } finally {
      // We must schedule the next check. Note that _scheduleNextTick only ever
      // gets called once and once only PER CALL to _crawlTick.
      self._scheduleNextTick();
    }
  }

  /**
   * Start the crawler. Pages will be crawled according to the configuration
   * provided to the Crawler's constructor.
   *
   * @return {Boolean} True if crawl started; false if crawl already running.
   */
  async start() {
    // TODO can only start when there are no outstanding requests.
    if (this._started) {
      return false;
    }

    const concurrentRequestsLimit = this.getConcurrentRequestsLimit();
    this._started = true;

    for (let i = 0; i < concurrentRequestsLimit; i++) {
      await this._crawlTick();
    }

    return true;
  }

  /**
   * Prevent crawling of any further URLs.
   */
  stop() {
    this._started = false;
  }
}

export default Crawler;
