# Node.js Web Crawler

这是对 [Supercrawler](https://github.com/brendonboshell/supercrawler) 项目的重构甚至重写了一下，为的是用ESM风格写出更好维护的代码，并且对并发能力做一下扩展，更新了对应依赖库的版本，把比较旧的request库换成了got库，去除了robots.txt和sqlite3的依赖


## 原项目的介绍

Supercrawler is a Node.js web crawler. It is designed to be highly configurable and easy to use.

When Supercrawler successfully crawls a page (which could be an image, a text document or any other file), it will fire your custom content-type handlers. Define your own custom handlers to parse pages, save data and do anything else you need.

## Features

* **Link Detection**. Supercrawler will parse crawled HTML documents, identify
  links and add them to the queue.
* **Robots Parsing**. Supercrawler will request robots.txt and check the rules
  before crawling. It will also identify any sitemaps.
* **Sitemaps Parsing**. Supercrawler will read links from XML sitemap files,
  and add links to the queue.
* **Concurrency Limiting**. Supercrawler limits the number of requests sent out
  at any one time.
* **Rate limiting**. Supercrawler will add a delay between requests to avoid
  bombarding servers.
* **Exponential Backoff Retry**. Supercrawler will retry failed requests after 1 hour, then 2 hours, then 4 hours, etc. To use this feature, you must use the database-backed or Redis-backed crawl queue.
* **Hostname Balancing**. Supercrawler will fairly split requests between
different hostnames. To use this feature, you must use the Redis-backed crawl queue.

## How It Works

**Crawling** is controlled by the an instance of the `Crawler` object, which acts like a web client. It is responsible for coordinating with the *priority queue*, sending requests according to the concurrency and rate limits, checking the robots.txt rules and despatching content to the custom *content handlers* to be processed. Once started, it will automatically crawl pages until you ask it to stop.

The **Priority Queue** or **UrlList** keeps track of which URLs need to be crawled, and the order in which they are to be crawled. The Crawler will pass new URLs discovered by the content handlers to the priority queue. When the crawler is ready to crawl the next page, it will call the `getNextUrl` method. This method will work out which URL should be crawled next, based on implementation-specific rules. Any retry logic is handled by the queue.

The **Content Handlers** are functions which take content buffers and do some further processing with them. You will almost certainly want to create your own content handlers to analyze pages or store data, for example. The content handlers tell the Crawler about new URLs that should be crawled in the future. Supercrawler provides content handlers to parse links from HTML pages, analyze robots.txt files for `Sitemap:` directives and parse sitemap files for URLs.

---

## 开始使用

第一步，安装这个库

```sh
npm install https://github.com/gnuos/krawler --save

# or

yarn add https://github.com/gnuos/krawler
```

第二步，创建一个 `Crawler` 实例

```js
import Craler from 'krawler';

// 1. Create a new instance of the Crawler object, providing configuration
// details. Note that configuration cannot be changed after the object is
// created.
const crawler = new Crawler({
  // By default, Supercrawler uses a simple FIFO queue, which doesn't support
  // retries or memory of crawl state. 
  // Tme (ms) between requests
  interval: 200,
  // Maximum number of requests at any one time.
  concurrentLimit: 4,
  // Query string to use during the crawl.
  userAgent: "Mozilla/5.0 (compatible; supercrawler/1.0)",
  // Custom options to be passed to request.
  gotOptions: {
    headers: {
      'Referer': 'http://example.com'
    }
  }
});

// 注册 links 事件处理方法，用于对页面的内容进行处理
crawler.on('links', (links) => {
  console.debug(links);
});

```

第三步，注册一些内容类型的处理函数，最好是不要用到全局命名空间里的对象变量

注册相同内容类型的处理函数时，只有最后一次设置会生效，通常建议把处理过程放在同一个函数体里面

```js
// 当内容类型的参数没有传的时候，默认就是 "*" 通配符类型
crawler.setHandler(SitemapsParser());

// 库里面提供了一个HtmlLinkParser工具函数，用Cheerio的CSS选择器从页面里面拿到所有的链接并返回
// 过滤器参数通过hostnames列表筛选出指定域名的链接，并且注册一个 links 事件
// 可以用crawler实例绑定 links 事件的处理函数
crawler.setHandler("text/html", HtmlLinkParser({
  // Restrict discovered links to the following hostnames.
  hostnames: ["example.com"]
}));

// 可以自定义对某种内容类型的
crawler.setHandler("text/html", function (context) {
  var sizeKb = Buffer.byteLength(context.body) / 1024;
  logger.info("Processed", context.url, "Size=", sizeKb, "KB");

  return []
});

// Match an array of content-type
crawler.setHandler(["text/plain", "text/html"], myCustomHandler);
```

第四步，添加种子链接
```js
await crawler.initSeed("http://example.com");

// 可以先启动再添加种子地址，start()方法会调用一个递归方法在后台运行
// 直到监听到 url_queue_complete 事件才会触发 stop() 方法调用
const completed = crawler.start();

// 这一句可以省略，在后面编写其他的异步代码
await Promise.all(completed);

```

上面就是简单的使用教程了

## Crawler

Each `Crawler` instance represents a web crawler. You can configure your
crawler with the following options:

| Option | Description |
| --- | --- |
| depth | 设置爬虫可以爬取的最大深度，适用于深度优先搜索，默认值是 1 |
| urlList | Custom instance of `UrlList` type queue. Defaults to `FifoUrlList`, which processes URLs in the order that they were added to the queue; once they are removed from the queue, they cannot be recrawled. |
| interval | Number of milliseconds between requests. Defaults to 1000. |
| concurrentLimit | Maximum number of concurrent requests. Defaults to 5. |
| userAgent | User agent to use for requests. This can be either a string or a function that takes the URL being crawled. Defaults to `Mozilla/5.0 (compatible; supercrawler/1.0; +https://github.com/brendonboshell/supercrawler)`. |
| request | Object of options to be passed to [request](https://github.com/request/request). Note that request does not support an asynchronous (and distributed) cookie jar. |

Example usage:

```js
const crawler = new Crawler({
  depth: 3,
  interval: 200,
  concurrentLimit: 1
});
```

The following methods are available:

| Method | Description |
| --- | --- |
| getUrlList | Get the `UrlList` type instance. |
| getInterval | Get the interval setting. |
| getConcurrentRequestsLimit | Get the maximum number of concurrent requests. |
| getUserAgent | Get the user agent. |
| start | Start crawling. |
| stop | Stop crawling. |
| setHandler(handler) | Set a handler for all content types. |
| setHandler(contentType, handler) | Set a handler for a specific content type. If `contentType` is a string, then (for example) 'text' will match 'text/html', 'text/plain', etc. If `contentType` is an array of strings, the page content type must match exactly. |

The `Crawler` object fires the following events:

| Event | Description |
| --- | --- |
| crawl_url(url) | Fires when crawling starts with a new URL. |
| crawled_url(url, errorCode, statusCode, errorMessage) | Fires when crawling of a URL is complete. `errorCode` is `null` if no error occurred. `statusCode` is set if and only if the request was successful. `errorMessage` is `null` if no error occurred. |
| url_list_empty | Fires when the URL list is (intermittently) empty. |
| url_list_complete | Fires when the URL list is permanently empty, barring URLs added by external sources. This only makes sense when running Supercrawler in non-distributed fashion. |


## RedisUrlList

`RedisUrlList` is a queue backed with Redis.

If a request fails, this queue will ensure the request gets retried at some point in the future. The next request is schedule 1 hour into the future. After that, the period of delay doubles for each failure.

It also balances requests between different hostnames. So, for example, if you
crawl a sitemap file with 10,000 URLs, the next 10,000 URLs will not be stuck in
the same host.

Options:

| Option | Description |
| --- | --- |
| opts.redis | Options passed to [ioredis](https://github.com/luin/ioredis). |
| opts.delayHalfLifeMs | Hostname delay factor half-life. Requests are delayed by an amount of time proportional to the number of pages crawled for a hostname, but this factor exponentially decays over time. Default = 3600000 (1 hour). |
| opts.expiryTimeMs | Amount of time before recrawling a successful URL. Default = 2592000000 (30 days). |
| opts.initialRetryTimeMs | Amount of time to wait before first retry after a failed URL. Default = 3600000 (1 hour) |

Example usage:

```js
new RedisUrlList({
  redis: {
    host: "127.0.0.1"
  }
})
```

The following methods are available:

| Method | Description |
| --- | --- |
| insertIfNotExists(url) | Insert a `Url` object. |
| upsert(url) | Upsert `Url` object. |
| getNextUrl() | Get the next `Url` to be crawled. |

## FifoUrlList

The `FifoUrlList` is the default URL queue powering the crawler. You can add
URLs to the queue, and they will be crawled in the same order (FIFO).

Note that, with this queue, URLs are only crawled once, even if the request
fails. If you need retry functionality, you must use `DbUrlList`.

The following methods are available:

| Method | Description |
| --- | --- |
| insertIfNotExists(url) | Insert a `Url` object. |
| upsert(url) | Upsert `Url` object. |
| getNextUrl() | Get the next `Url` to be crawled. |

## Url

A `Url` represents a URL to be crawled, or a URL that has already been
crawled. It is uniquely identified by an absolute-path URL, but also contains
information about errors and status codes.

| Option | Description |
| --- | --- |
| url | Absolute-path string url |
| parent | Referer source link. Use last process url |
| statusCode | HTTP status code or `null`. |
| errorCode | String error code or `null`. |

Example usage:

```js
const url = new Url({
  url: "https://example.com"
});
```

You can also call it just a string URL:

```js
const url = new Url("https://example.com");
```

The following methods are available:

| Method | Description |
| --- | --- |
| getUniqueId | Get the unique identifier for this object. |
| getUrl | Get the absolute-path string URL. |
| getErrorCode | Get the error code, or `null` if it is empty. |
| getStatusCode | Get the status code, or `null` if it is empty. |


## HtmlLinkParser

A function that returns a handler which parses a HTML page and identifies any
links.

| Option | Description |
| --- | --- |
| hostnames | Array of hostnames that are allowed to be crawled. |
| urlFilter(url, pageUrl) | Function that takes a URL and returns `true` if it should be included. |

Example usage:

```js
const hlp = HtmlLinkParser({
  hostnames: ["example.com"]
});
```

```js
const hlp = HtmlLinkParser({
  urlFilter: function (url) {
    return url.indexOf("page1") === -1;
  }
});
```

## SitemapsParser

A function that returns a handler which parses an XML sitemaps file. It will
pick up any URLs matching `sitemapindex > sitemap > loc, urlset > url > loc`.

It will also handle a gzipped file, since that it part of the sitemaps
specification.

| Option | Description |
| --- | --- |
| urlFilter | Function that takes a URL (including sitemap entries) and returns `true` if it should be included. |

Example usage:

```js
const sp = SitemapsParser();
crawler.addHandler(SitemapsParser());
```

## Changelog

### 2.0.0 - Nov 24, 2019

* [Added] `crawledurl` event to contain the error message, thanks [hjr3](https://github.com/hjr3).
* [Changed] `sitemapsParser` to apply `urlFilter` on the sitemaps entries, thanks [hjr3](https://github.com/hjr3).
* [Added] `Crawler` to take `userAgent` option as a function, thanks [hjr3](https://github.com/hjr3).
