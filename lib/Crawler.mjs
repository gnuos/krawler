import { EventEmitter } from 'node:events';
import mime from 'mime-types';
import got from 'got';

import Url from './Url.mjs';
import error from './error/index.mjs';
import FifoUrlList from './FifoUrlList.mjs';

const DEFAULT_INTERVAL = 100;
const DEFAULT_CONCURRENT_REQUESTS_LIMIT = 4;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; krawler/1.0)';

class Crawler extends EventEmitter {
  _urlList;
  _interval;
  _handlers;
  _userAgent;
  _gotOptions;
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

    this._handlers = [];
    this._outstandingRequests = 0;
    this._urlList = opts.urlList || new FifoUrlList();
    this._interval = opts.interval || DEFAULT_INTERVAL;
    this._concurrentLimit = opts.concurrentLimit || DEFAULT_CONCURRENT_REQUESTS_LIMIT;
    this._userAgent = opts.userAgent || DEFAULT_USER_AGENT;
    this._gotOptions = opts.gotOptions || {};
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
   * Start the crawler. Pages will be crawled according to the configuration
   * provided to the Crawler's constructor.
   *
   * @return {Boolean} True if crawl started; false if crawl already running.
   */
  async start() {
    let concurrentRequestsLimit, i;

    // TODO can only start when there are no outstanding requests.

    if (this._started) {
      return false;
    }

    concurrentRequestsLimit = this.getConcurrentRequestsLimit();
    this._started = true;

    for (i = 0; i < concurrentRequestsLimit; i++) {
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

  addHandler(contentType, handler) {
    // if this method is called as addHandler(\Function), that means the
    // handler will deal with all content types.
    if (arguments.length === 1) {
      return this.addHandler('*', arguments[0]);
    }

    this._handlers.push({
      contentType: contentType,
      handler: handler
    });

    return true;
  }

  /**
   * Check if we are allowed to send a request and, if we are, send it. If we
   * are not, reschedule the request for NOW + INTERVAL in the future.
   */
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
      const url = urlObj.getUrl();

      // We keep track of number of outstanding requests. If this is >= 1, the
      // queue is still subject to change -> so we do not wish to declare
      // urllistcomplete until those changes are synced with the \UrlList.
      self._outstandingRequests++;

      try {
        const resultUrl = await self._processUrl(url);
        return urlList.upsert(resultUrl);
      } finally {
        self._outstandingRequests--;
      }
    } catch (err) {
      if (err instanceof RangeError) {
        self.emit('urllistempty');

        if (self._outstandingRequests === 0) {
          self.emit('urllistcomplete');
        }
      }
    } finally {
      // We must schedule the next check. Note that _scheduleNextTick only ever
      // gets called once and once only PER CALL to _crawlTick.
      self._scheduleNextTick();
    }
  }

  /**
   * Start the crawl process for a specific URL.
   *
   * @param  {string} url   The URL to crawl.
   * @return {Promise}      Promise of result URL object.
   */
  async _processUrl(url) {
    let self = this,
      response,
      urlList;

    const curUrl = url;
    urlList = this.getUrlList();
    this.emit('crawlurl', url);

    // perform url download
    let _response, contentType, statusCode, location, links;
    try {
      _response = await this._downloadUrl(url, false);
    } catch (err) {
      if (err.statusCode && err.statusCode > 400 && err.statusCode < 500) {
        self.emit('httpError', err, url);

        throw err;
      } else {
        self.emit('handlersError', err);
        const e = new error.HandlersError('A handlers error occured. ' + err.message);

        throw e;
      }
    }

    response = _response;
    contentType = response.headers['content-type'] || mime.lookup(curUrl);
    statusCode = response.statusCode;
    location = response.headers.location;

    // If this is a redirect, we follow the location header.
    // Otherwise, we get the discovered URLs from the content handlers.
    if (statusCode >= 300 && statusCode < 400) {
      self.emit('redirect', curUrl, location);
      links = [new URL(location, curUrl)];
    } else {
      try {
        links = await self._fireHandlers(contentType, response.body, curUrl);
        self.emit('links', curUrl, links);

        if (typeof urlList.insertIfNotExistsBulk === 'undefined') {
          links.map((link) => {
            urlList.insertIfNotExists(
              new Url({
                url: link
              })
            );
          });
        } else {
          urlList.insertIfNotExistsBulk(
            links.map(function (link) {
              return new Url({
                url: link
              });
            })
          );
        }

        const newUrl = new Url({
          url: url,
          errorCode: null,
          statusCode: response.statusCode
        });

        self.emit(
          'crawledurl',
          newUrl.getUrl(),
          newUrl.getErrorCode(),
          newUrl.getStatusCode(),
          newUrl.getErrorMessage()
        );

        return newUrl;
      } catch (err) {
        switch (err.constructor) {
          case error.HttpError: {
            self.emit('httpError', err, url);

            return new Url({
              url: curUrl,
              errorCode: 'HTTP_ERROR',
              statusCode: err.statusCode
            });
          }
          case error.RequestError: {
            return new Url({
              url: curUrl,
              errorCode: 'REQUEST_ERROR',
              errorMessage: err.message
            });
          }
          case error.HandlersError: {
            return new Url({
              url: curUrl,
              errorCode: 'HANDLERS_ERROR',
              errorMessage: err.message
            });
          }
          default: {
            return new Url({
              url: curUrl,
              errorCode: 'OTHER_ERROR',
              errorMessage: err.message
            });
          }
        }
      }
    }
  }

  /**
   * Fire any matching handlers for a particular page that has been crawled.
   *
   * @param  {string} contentType Content type, e.g. "text/html; charset=utf8"
   * @param  {string} body        Body content.
   * @param  {string} url         Page URL, absolute.
   * @return {Promise}            Promise returning an array of discovered links.
   */
  async _fireHandlers(contentType, body, url) {
    contentType = contentType.replace(/;.*$/g, '');

    const ctx = {
      body: body,
      url: url,
      contentType: contentType
    };

    let arr = [];

    for (const handlerObj of this._handlers) {
      let handlerContentType = handlerObj.contentType,
        handlerFun = handlerObj.handler,
        match = false;

      if (handlerContentType === '*') {
        match = true;
      } else if (Array.isArray(handlerContentType) && handlerContentType.indexOf(contentType) > -1) {
        match = true;
      } else if ((contentType + '/').indexOf(handlerContentType + '/') === 0) {
        match = true;
      }

      if (!match) {
        continue;
      }

      let subArr = await handlerFun(ctx);
      if (subArr instanceof Array) {
        arr = arr.concat(subArr);
      }
    }

    return arr;
  }

  /**
   * Download a particular URL. Generally speaking, we do not want to follow
   * redirects, because we just add the destination URLs to the queue and crawl
   * them later.
   *
   * @param  {string} url             URL to fetch.
   * @param  {Boolean} followRedirect True if redirect should be followed.
   * @return {Promise}                Promise of result.
   */
  async _downloadUrl(url, followRedirect) {
    let defaultOptions = {
      headers: {
        Accept: '*',
        'User-Agent': this.getUserAgent(url)
      },
      followRedirect: Boolean(followRedirect)
    };

    const requestOptions = Object.assign({}, defaultOptions, this.getRequestOptions());

    let response;
    try {
      response = await got.get(url, requestOptions);
      return response;
    } catch (err) {
      if (err.response.statusCode >= 400) {
        const e = new error.HttpError('HTTP status code is ' + err.response.statusCode);
        e.statusCode = err.response.statusCode;

        throw e;
      } else {
        const e = new error.RequestError('A request error occured. ' + err.message);
        throw e;
      }
    }
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
}

export default Crawler;
