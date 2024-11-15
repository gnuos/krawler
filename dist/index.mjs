import { EventEmitter } from 'node:events';
import mime from 'mime-types';
import got from 'got';
import Redis from 'ioredis';
import { load } from 'cheerio';
import zlib from 'node:zlib';

class Url {
  _url;
  _statusCode;
  _errorCode;
  _errorMessage;

  /**
   * Represents a URL, that is either waiting to be crawled or has already
   * been crawled. It also contains some state information, i.e. whether or not
   * the page was crawled, status code, etc.
   *
   * @param {Object|string} opts Options about this URL. Can also be string URL.
   */
  constructor(opts) {
    if (typeof opts === 'string') {
      opts = {
        url: opts
      };
    }

    this._url = opts.url;
    this._statusCode = opts.statusCode ? opts.statusCode : null;
    this._errorCode = opts.errorCode ? opts.errorCode : null;
    this._errorMessage = opts.errorMessage ? opts.errorMessage : null;
  }

  /**
   * Get the string that uniquely identifies this record; typically the URL.
   * This will ensure that the object is replaced when added to a \UrlList.
   *
   * @return {string} Unique identifier
   */
  getUniqueId() {
    return this._url;
  }

  /**
   * Get the string URL that is to be requested.
   *
   * @return {string} URL.
   */
  getUrl() {
    return this._url;
  }

  /**
   * Get the error code of the the crawl.
   *
   * @return {string|null} String error code, or null if no error.
   */
  getErrorCode() {
    return this._errorCode;
  }

  /**
   * Return the status code of the crawl.
   *
   * @return {number|null} Status code, or null if crawl hasn't completed.
   */
  getStatusCode() {
    return this._statusCode;
  }

  /**
   * Return the error message of the URL.
   *
   * @return {string} Error message string.
   */
  getErrorMessage() {
    if (typeof this._errorMessage === 'string') {
      return this._errorMessage.substring(0, 1000);
    }

    return null;
  }
}

class CustomError extends Error {
  message;

  constructor(message) {
    super(message);
    this.message = message;
    Error.captureStackTrace(this, this.constructor);
  }
}

function makeError (name) {
  const errFactory = CustomError;
  errFactory.prototype.name = name;

  return errFactory;
}

var error = {
  HttpError: makeError('HttpError'),
  RequestError: makeError('RequestError'),
  HandlersError: makeError('HandlersError')
};

class FifoUrlList {
  _list;
  _listIndexesByUniqueId;
  _nextIndex;

  /**
   * A simple queue for \Url objects that holds the queue in-memory and works
   * in a first-in, first-out fashion. Note that all \Url, even those that
   * are "popped", are kept in-memory because they store crawl state info, too.
   */
  constructor() {
    this._list = [];
    this._listIndexesByUniqueId = {};
    this._nextIndex = 0;
  }

  /**
   * Insert a \Url object into the queue. Resolves even if record currently
   * exists.
   *
   * @param  {Url} url     \Url object
   * @return {Promise}     Returns the inserted object with a promise.
   */
  async insertIfNotExists(url) {
    var uniqueId, currentIndex;

    uniqueId = url.getUniqueId();
    currentIndex = this._listIndexesByUniqueId[uniqueId];

    if (typeof currentIndex === 'undefined') {
      this._pushUrlToList(url);
    }

    return url;
  }

  /**
   * Insert a new URL, or update it if it already exists. This method is used
   * to update the state of a crawl.
   *
   * @param  {Url} url     \Url object
   * @return {Promise}     Returns the inserted object with a promise.
   */
  async upsert(url) {
    var uniqueId,
      self = this;

    uniqueId = url.getUniqueId();
    await this.insertIfNotExists(url);

    let currentIndex;

    currentIndex = self._listIndexesByUniqueId[uniqueId];
    self._list[currentIndex] = url;

    return url;
  }

  /**
   * Insert a URL that isn't already in the list, i.e. update the list array
   * and the lookup object.
   *
   * @param  {Url} url    \Url object
   * @return {number}     Index of the record that has been inserted.
   */
  _pushUrlToList(url) {
    var listLength, uniqueId;

    listLength = this._list.length;
    uniqueId = url.getUniqueId();
    this._list[listLength] = url;
    this._listIndexesByUniqueId[uniqueId] = listLength;

    return listLength;
  }

  /**
   * Get the next URL that should be crawled. In this list, URLs are crawled
   * in a first-in, first-out fashion. They are never crawled twice, even if the
   * first request failed.
   *
   * @return {Promise} Returns the next \Url to crawl with a promise.
   */
  async getNextUrl() {
    let item;

    if (this._nextIndex >= this._list.length) {
      throw new RangeError('The list has been exhausted.');
    }

    item = this._list[this._nextIndex];
    this._nextIndex++;

    return item;
  }
}

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

const DEFAULT_DELAY_HALF_LIFE_MS = 3600 * 1000;
const DEFAULT_EXPIRY_TIME_MS = 30 * 86400 * 1000;
const DEFAULT_INITIAL_RETRY_TIME_MS = 3600 * 1000;
const LOCK_TIME_MS = 60 * 1000;

class RedisUrlList {
  _delayHalfLifeMs;
  _expiryTimeMs;
  _initialRetryTimeMs;
  _redis;

  /**
   * A Redis backed queue that features retry logic and equal distribution between
   * hosts.
   *
   * @param {Object} opts Options
   */
  constructor(opts) {
    this._delayHalfLifeMs = opts.delayHalfLifeMs || DEFAULT_DELAY_HALF_LIFE_MS;
    this._expiryTimeMs = opts.expiryTimeMs || DEFAULT_EXPIRY_TIME_MS;
    this._initialRetryTimeMs = opts.initialRetryTimeMs || DEFAULT_INITIAL_RETRY_TIME_MS;
    this._redis = new Redis(opts.redis);
    this._redis.defineCommand('zaddwithdelay', {
      numberOfKeys: 3,
      lua:
        '\n' +
        'local key = KEYS[1]\n' +
        'local delayKey = KEYS[2]\n' +
        'local lastupdateKey = KEYS[3]\n' +
        'local member = ARGV[1]\n' +
        'local nowTime = tonumber(ARGV[2])\n' +
        'local halflife = tonumber(ARGV[3])\n' +
        'local getDelayRes\n' +
        'local currentDelay = 0\n' +
        'local newDelay\n' +
        'local currentLastUpdate = nowTime\n' +
        'local diff\n' +
        "local rankRes = redis.call('zrank', key, member)\n" +
        'if (rankRes == false) then\n' +
        "\tgetDelayRes = redis.call('get', delayKey)\n" +
        '\tif (getDelayRes ~= false) then\n' +
        '\t\tcurrentDelay = tonumber(getDelayRes)\n' +
        "\t\tcurrentLastUpdate = tonumber(redis.call('get', lastupdateKey))\n" +
        '\tend\n' +
        '\tdiff = nowTime - currentLastUpdate\n' +
        '\tnewDelay = currentDelay * math.exp(math.log(0.5) / halflife * diff) + 1\n' +
        "\tredis.call('set', delayKey, newDelay)\n" +
        "\tredis.call('set', lastupdateKey, nowTime)\n" +
        "\treturn redis.call('zadd', key, newDelay, member)\n" +
        'end\n' +
        'return 0'
    });
    this._redis.defineCommand('zaddreseterrors', {
      numberOfKeys: 3,
      lua:
        '\n' +
        'local key = KEYS[1]\n' +
        'local errorsKey = KEYS[2]\n' +
        'local errorKey = KEYS[3]\n' +
        'local crawlTime = tonumber(ARGV[1])\n' +
        'local member = ARGV[2]\n' +
        "local hdelRes = redis.call('hdel', errorKey, 'numErrors', 'statusCode', 'errorCode', 'errorMessage')\n" +
        'if (hdelRes ~= 0) then\n' +
        "\tredis.call('srem', errorsKey, errorKey)\n" +
        'end\n' +
        "return redis.call('zadd', key, crawlTime, member)"
    });
    this._redis.defineCommand('zaddwithretrydelay', {
      numberOfKeys: 3,
      lua:
        '\n' +
        'local key = KEYS[1]\n' +
        'local errorsKey = KEYS[2]\n' +
        'local errorKey = KEYS[3]\n' +
        'local nowTime = tonumber(ARGV[1])\n' +
        'local member = ARGV[2]\n' +
        'local initialRetryTime = tonumber(ARGV[3])\n' +
        'local statusCode = ARGV[4]\n' +
        'local errorCode = ARGV[5]\n' +
        'local errorMessage = ARGV[6]\n' +
        "local numErrors = redis.call('hincrby', errorKey, 'numErrors', 1)\n" +
        "redis.call('hset', errorKey, 'statusCode', statusCode)\n" +
        "redis.call('hset', errorKey, 'errorCode', errorCode)\n" +
        "redis.call('hset', errorKey, 'errorMessage', errorMessage)\n" +
        "redis.call('sadd', errorsKey, errorKey)\n" +
        'local crawlTime = nowTime + initialRetryTime * 2 ^ (numErrors - 1)\n' +
        "return redis.call('zadd', key, crawlTime, member)"
    });
    this._redis.defineCommand('zrangebyscoreandlock', {
      numberOfKeys: 1,
      lua:
        '\n' +
        'local key = KEYS[1]\n' +
        'local fromTime = ARGV[1]\n' +
        'local toTime = ARGV[2]\n' +
        'local lockTimeMs = ARGV[3]\n' +
        "local zrangebyscoreRes = redis.call('zrangebyscore', key, fromTime, toTime, 'LIMIT', 0, 1)\n" +
        'if (zrangebyscoreRes[1] ~= nil) then\n' +
        "\tredis.call('zadd', key, toTime + lockTimeMs, zrangebyscoreRes[1])\n" +
        'end\n' +
        'return zrangebyscoreRes'
    });
  }

  /**
   * Add URL to queue if it doesn't already exist. If it is a new URL, it is
   * given a delay based on number of URLs that have been crawled in the past.
   * This delay decays according to the `delayHalfLifeMs` option. This ensures
   * that, if we crawl a website's sitemaps, we don't get stuck in crawling those
   * URLs first.
   *
   * @param  {Url} url     Url object.
   * @return {Promise}     Promise resolves when URL added to queue.
   */
  async insertIfNotExists(url) {
    return await this.insertIfNotExistsBulk([url]);
  }

  async insertIfNotExistsBulk(urls) {
    const self = this;

    const result = await this._redis
      .pipeline(
        urls.map(function (url) {
          let urlObj;
          let hostname = 'OTHER';

          urlObj = new URL(url.getUrl());

          if (urlObj && urlObj.hostname) {
            hostname = urlObj.hostname;
          }

          return [
            'zaddwithdelay',
            'scheduledcrawls',
            'hostdelay:' + hostname,
            'hostlastupdate:' + hostname,
            url.getUrl(),
            new Date().getTime(),
            self._delayHalfLifeMs
          ];
        })
      )
      .exec();

    result.forEach(function (commandRes) {
      if (commandRes[0] !== null) {
        throw commandRes[0];
      }
    });

    return result;
  }

  /**
   * Update the URL record, delaying it by an exponentially increasing factor if
   * the crawl failed.
   *
   * @param  {Url} url     Url object.
   * @return {Promise}     Promise resolved once updated.
   */
  async upsert(url) {
    let nextCrawlTimeMs;

    if (url.getErrorCode() === null) {
      nextCrawlTimeMs = new Date(new Date().getTime() + this._expiryTimeMs).getTime();

      return await this._redis.zaddreseterrors(
        'scheduledcrawls',
        'errors',
        'error:' + url.getUrl(),
        nextCrawlTimeMs,
        url.getUrl()
      );
    } else {
      return await this._redis.zaddwithretrydelay(
        'scheduledcrawls',
        'errors',
        'error:' + url.getUrl(),
        new Date().getTime(),
        url.getUrl(),
        this._initialRetryTimeMs,
        url.getStatusCode(),
        url.getErrorCode(),
        url.getErrorMessage()
      );
    }
  }

  /**
   * Get the next URL to be crawled.
   *
   * @return {Promise} Resolves with the \Url for the next crawl.
   */
  async getNextUrl() {
    const res = this._redis.zrangebyscoreandlock('scheduledcrawls', '-inf', new Date().getTime(), LOCK_TIME_MS);

    if (!res[0]) {
      throw new RangeError('The list has been exhausted.');
    }

    return new Url({
      url: res[0]
    });
  }
}

function htmlLinkParser (opts) {
  if (!opts) {
    opts = {};
  }

  if (!opts.urlFilter) {
    opts.urlFilter = function () {
      return true;
    };
  }

  return async function (context) {
    var $;

    $ = context.$ || load(context.body);
    context.$ = $;

    return $('a[href], link[href][rel=alternate], area[href]')
      .map(function () {
        let $this, targetHref, absoluteTargetUrl, urlObj, protocol, hostname;

        $this = $(this);
        targetHref = $this.attr('href');
        absoluteTargetUrl = new URL(targetHref, context.url);
        urlObj = new URL(absoluteTargetUrl);
        protocol = urlObj.protocol;
        hostname = urlObj.hostname;

        if (protocol !== 'http:' && protocol !== 'https:') {
          return null;
        }

        // Restrict links to a particular group of hostnames.
        if (typeof opts.hostnames !== 'undefined') {
          if (opts.hostnames.indexOf(hostname) === -1) {
            return null;
          }
        }

        return urlObj;
      })
      .get()
      .filter(function (url) {
        return opts.urlFilter(url, context.url);
      });
  };
}

const nullFilter = function (a) {
  // Some of the maps() might have returned null, so we filter
  // those out here.
  return a !== null;
};

/**
 * This handler parses XML format sitemaps, and extracts links from them,
 * including links to other sitemaps.
 *
 * Sitemap files can also be served as gz files (with an actual
 * application/x-gzip). Unfortunately, that means we have to open up the file
 * to see what is inside.
 *
 * @return {Array} Array of links discovered in the sitemap.
 */
function sitemapsParser (opts) {
  if (!opts) {
    opts = {};
  }

  if (!opts.urlFilter) {
    opts.urlFilter = function () {
      return true;
    };
  }

  if (typeof opts.gzipContentTypes === 'string') {
    opts.gzipContentTypes = [opts.gzipContentTypes];
  } else if (!Array.isArray(opts.gzipContentTypes)) {
    opts.gzipContentTypes = ['application/x-gzip', 'application/gzip'];
  }

  return async function (context) {
    let xmlBuf;

    // If sitemap has come in compressed state, we must uncompress it!
    if (opts.gzipContentTypes.indexOf(context.contentType) > -1) {
      zlib.gunzip(context.body, (err, buf) => {
        if (err) {
          throw err;
        }

        xmlBuf = buf;
      });
    } else {
      xmlBuf = context.body;
    }

    let sitemapUrls, urlUrls, linkUrls;

    let $ = context.$ || load(xmlBuf);
    context.$ = $;

    // We map over the array rather than using Cheerio's map, because it is
    // a lot faster. It's important when we are dealing with very large
    // sitemaps.
    sitemapUrls = $('sitemapindex > sitemap > loc')
      .get()
      .map(function (el) {
        const match = el.children.filter(function (child) {
          return child.type === 'text';
        });

        return match ? match.data : null;
      })
      .filter(nullFilter)
      .filter(opts.urlFilter);

    urlUrls = $('urlset > url > loc')
      .get()
      .map(function (el) {
        const match = el.children.filter(function (child) {
          return child.type === 'text';
        });

        return match ? match[0].data : null;
      })
      .filter(nullFilter)
      .filter(opts.urlFilter);

    linkUrls = $('urlset > url > xhtml\\:link[href][rel=alternate]')
      .get()
      .map(function (el) {
        return el.attribs.href ? el.attribs.href : null;
      })
      .filter(nullFilter)
      .filter(opts.urlFilter);

    return sitemapUrls.concat(urlUrls).concat(linkUrls);
  };
}

export { Crawler, htmlLinkParser as HtmlLinkParser, RedisUrlList, sitemapsParser as SitemapsParser, Url };
