/* globals console */
import { Crawler, HtmlLinkParser, SitemapsParser } from '../index.mjs';

// 可以传入depth参数定义爬取的深度，后面需要改变爬虫算法
const crawler = new Crawler();

crawler.on('crawl_url', function (url) {
  console.log('开始抓取:', url);
});

// 自定义链接队列没链接的行为
crawler.on('url_queue_empty', function () {
  console.warn('队列中没有链接');
});

crawler.on('http_error', function (err, url) {
  console.error(url, err.message);
});

crawler.on('links', function (data) {
  console.log(data.join('\n'));
});

crawler.setHandler('application/xml', SitemapsParser());

crawler.setHandler('text/html', async function (ctx) {
  let sizeKb = Buffer.byteLength(ctx.body) / 1024;
  console.log('处理页面:', ctx.url, '字节数', sizeKb, 'KB', '\n');

  const parse = HtmlLinkParser({
    hostnames: ['cheerio.js.org']
  });

  const links = await parse(ctx);

  console.log('爬取的页面中包含的链接数:', links.length);
  console.log(links.join('\n'));
  console.log();
});

(async function () {
  await crawler.initSeed('https://cheerio.js.org/docs/api');
  crawler.start();
})();
